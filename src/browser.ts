/**
 * Playwright browser lifecycle + the ref-resolution boundary.
 *
 * `BrowserSession` owns a single browser/context (chromium, firefox, or webkit, selected
 * by {@link BrowserSessionOptions.engine}) and one or more pages (tabs), launched lazily on
 * first use. It is the ONLY place that talks to Playwright's launch API, so the rest of the
 * server depends on this small surface rather than on Playwright directly. Engine selection
 * is confined here; everything downstream (viewport, timeouts, tabs, listeners, routing,
 * storage, the ref boundary) is identical across engines. All multi-tab, dialog, console, network, and raw-snippet behaviour is confined
 * here so that Playwright API growth never leaks past this boundary.
 *
 * The ref boundary lives here too: {@link BrowserSession.resolveRef} turns a snapshot
 * ref (`"e5"`) into a Playwright `Locator` via the `data-laya-ref` attribute stamped by
 * {@link ./snapshot.capture}. An unrecognised target string is treated as a raw
 * Playwright selector, so callers can also address elements by CSS/text selectors.
 * resolveRef acts on the ACTIVE page. We own this boundary deliberately: stable
 * `playwright-core@1.63.0` exposes no public `_snapshotForAI`/`snapshotForAI`, so nothing
 * here depends on a Playwright private API.
 */
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Cookie,
  type Locator,
  type Page,
} from "playwright";
import type {
  ConsoleMessageRecord,
  DialogRecord,
  NetworkRequestRecord,
  RouteRule,
  TabInfo,
} from "./types.js";

/** The Playwright engine a {@link BrowserSession} drives. */
export type BrowserEngineName = "chromium" | "firefox" | "webkit";

/** Configuration for a {@link BrowserSession}. */
export interface BrowserSessionOptions {
  /** Which Playwright engine to launch. Defaults to `"chromium"`. */
  engine?: BrowserEngineName;
  /** Launch headless (default) or headed. Defaults to `true`. */
  headless?: boolean;
  /** Viewport size for the page. Defaults to 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Optional Chromium channel (e.g. `"chrome"`, `"msedge"`). Ignored for firefox/webkit,
   * which have no channel concept.
   */
  channel?: string;
  /** Per-action timeout in ms (click/type/select waits). Defaults to 10000. */
  actionTimeoutMs?: number;
  /** Navigation timeout in ms. Defaults to 20000. */
  navigationTimeoutMs?: number;
}

/** How the next JavaScript dialog should be handled, registered before it fires. */
export interface DialogDisposition {
  /** Accept the dialog (vs. dismiss it). */
  accept: boolean;
  /** Text to enter for a `prompt` dialog when accepting. */
  promptText?: string;
}

/** Map an engine name to its Playwright {@link BrowserType}. */
const BROWSER_TYPES: Record<BrowserEngineName, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

/** A snapshot ref looks like `e` followed by one or more digits, e.g. `e12`. */
const REF_PATTERN = /^e\d+$/;

/** Cap the console/network buffers so a long-running session cannot grow unbounded. */
const RING_BUFFER_LIMIT = 500;

/**
 * A lazily-launched browser session: browser -> context -> one or more pages (tabs).
 *
 * Nothing is launched until {@link getPage} (or a method that needs the page) is first
 * called, so constructing a session in Assist mode with no work to do is cheap and
 * loads no model weights.
 */
export class BrowserSession {
  private readonly options: Required<Omit<BrowserSessionOptions, "channel">> &
    Pick<BrowserSessionOptions, "channel">;

  /** The Playwright browser type selected by {@link BrowserSessionOptions.engine}. */
  private readonly browserType: BrowserType;

  private browser?: Browser;
  private context?: BrowserContext;
  /** All open tabs, in creation order; {@link activeIndex} selects the active one. */
  private pages: Page[] = [];
  /** Index into {@link pages} of the currently active tab. */
  private activeIndex = 0;
  /** Serialises concurrent lazy-launch calls so we launch exactly one browser. */
  private launching?: Promise<Page>;

  /** Ring-buffered console messages accumulated across all tabs. */
  private consoleMessages: ConsoleMessageRecord[] = [];
  /** Ring-buffered network request/response records accumulated across all tabs. */
  private networkRequests: NetworkRequestRecord[] = [];
  /** Fast lookup from a Playwright request object to its record for response merge. */
  private requestIndex = new WeakMap<object, NetworkRequestRecord>();
  /** Disposition for the NEXT dialog; consumed (cleared) when a dialog fires. */
  private nextDialog?: DialogDisposition;
  /** The most recent dialog seen, recorded after it was handled. */
  private lastDialog?: DialogRecord;
  /** Active route-mocking rules, keyed by URL pattern (one rule per pattern). */
  private routeRules = new Map<string, RouteRule>();

  constructor(options: BrowserSessionOptions = {}) {
    this.options = {
      engine: options.engine ?? "chromium",
      headless: options.headless ?? true,
      viewport: options.viewport ?? { width: 1280, height: 800 },
      channel: options.channel,
      actionTimeoutMs: options.actionTimeoutMs ?? 10000,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 20000,
    };
    this.browserType = BROWSER_TYPES[this.options.engine];
  }

  /** Whether a browser has actually been launched yet. */
  get launched(): boolean {
    return this.browser !== undefined;
  }

  /**
   * Return the active page, launching the browser/context/page on first use.
   *
   * Concurrent callers during the initial launch share a single in-flight launch.
   */
  async getPage(): Promise<Page> {
    const active = this.pages[this.activeIndex];
    if (active) return active;
    if (this.launching) return this.launching;

    this.launching = this.launch();
    try {
      return await this.launching;
    } finally {
      this.launching = undefined;
    }
  }

  private async launch(): Promise<Page> {
    // Only Chromium honours a `channel`; firefox/webkit have no channel concept, so we
    // pass it only for chromium and keep every other launch option identical across engines.
    const useChannel = this.options.engine === "chromium" && this.options.channel;
    const browser = await this.browserType.launch({
      headless: this.options.headless,
      ...(useChannel ? { channel: this.options.channel } : {}),
    });
    const context = await browser.newContext({
      viewport: this.options.viewport,
    });
    // Bound action/navigation waits so a missing element surfaces as an error promptly
    // instead of hanging for Playwright's 30s default.
    context.setDefaultTimeout(this.options.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

    this.browser = browser;
    this.context = context;

    const page = await context.newPage();
    this.trackPage(page);
    this.pages = [page];
    this.activeIndex = 0;
    return page;
  }

  /**
   * Attach the console/network/dialog listeners to a page so its events feed the shared
   * ring buffers and the registered dialog disposition. Every page (tab) is tracked, so
   * observations survive tab switches.
   */
  private trackPage(page: Page): void {
    page.on("console", (msg) => {
      const loc = msg.location();
      const record: ConsoleMessageRecord = {
        type: msg.type(),
        text: msg.text(),
      };
      if (loc?.url) {
        record.location = {
          url: loc.url,
          lineNumber: loc.lineNumber,
          columnNumber: loc.columnNumber,
        };
      }
      this.pushCapped(this.consoleMessages, record);
    });

    page.on("pageerror", (err) => {
      this.pushCapped(this.consoleMessages, {
        type: "error",
        text: err.message,
      });
    });

    page.on("request", (req) => {
      const record: NetworkRequestRecord = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        requestHeaders: { ...req.headers() },
      };
      this.requestIndex.set(req, record);
      this.pushCapped(this.networkRequests, record);
    });

    page.on("response", async (res) => {
      const record = this.requestIndex.get(res.request());
      if (!record) return;
      record.status = res.status();
      record.statusText = res.statusText();
      try {
        record.responseHeaders = { ...res.headers() };
      } catch {
        // Headers may be unavailable for some responses; leave them unset.
      }
    });

    page.on("requestfailed", (req) => {
      const record = this.requestIndex.get(req);
      if (!record) return;
      record.failure = req.failure()?.errorText ?? "failed";
    });

    page.on("dialog", async (dialog) => {
      const disposition = this.nextDialog;
      // Consume the one-shot disposition so a later action does not reuse it.
      this.nextDialog = undefined;
      const accept = disposition?.accept ?? false;
      this.lastDialog = {
        type: dialog.type(),
        message: dialog.message(),
        accept,
        ...(disposition?.promptText !== undefined
          ? { promptText: disposition.promptText }
          : {}),
      };
      try {
        if (accept) {
          await dialog.accept(disposition?.promptText);
        } else {
          await dialog.dismiss();
        }
      } catch {
        // Dialog may already be handled or the page gone; ignore.
      }
    });
  }

  /** Push onto a ring buffer, dropping the oldest entry past the cap. */
  private pushCapped<T>(buffer: T[], item: T): void {
    buffer.push(item);
    if (buffer.length > RING_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - RING_BUFFER_LIMIT);
    }
  }

  /** The accumulated console messages, newest last. */
  getConsoleMessages(): ConsoleMessageRecord[] {
    return this.consoleMessages.map((m) => ({ ...m }));
  }

  /** The accumulated network request/response records, in request order. */
  getNetworkRequests(): NetworkRequestRecord[] {
    return this.networkRequests.map((r) => ({ ...r }));
  }

  /** The most recently handled dialog, if any. */
  getLastDialog(): DialogRecord | undefined {
    return this.lastDialog ? { ...this.lastDialog } : undefined;
  }

  /**
   * Register how the NEXT JavaScript dialog should be handled. Because dialogs are
   * triggered by a subsequent action, callers register the disposition first, then perform
   * the action that fires the dialog.
   */
  setNextDialog(disposition: DialogDisposition): void {
    this.nextDialog = { ...disposition };
  }

  /**
   * Resolve a target string to a Playwright {@link Locator} on the ACTIVE page.
   *
   * A target matching the ref shape (`eN`) is resolved by the `data-laya-ref`
   * attribute that {@link ./snapshot.capture} stamps on interactive elements. Any other
   * string is treated as a raw Playwright selector (CSS, text=, etc). This is the single
   * guarded boundary where an opaque target becomes a concrete element locator.
   */
  resolveRef(target: string): Locator {
    const page = this.pages[this.activeIndex];
    if (!page) {
      throw new Error(
        "Cannot resolve a target before the page has been created; call getPage() first.",
      );
    }
    const trimmed = target.trim();
    if (REF_PATTERN.test(trimmed)) {
      return page.locator(`[data-laya-ref="${trimmed}"]`);
    }
    return page.locator(trimmed);
  }

  /** List all open tabs as pure {@link TabInfo} records, launching lazily if needed. */
  async listTabs(): Promise<TabInfo[]> {
    await this.getPage();
    const tabs: TabInfo[] = [];
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i]!;
      let title = "";
      try {
        title = await page.title();
      } catch {
        // A closing/blank page may not have a title yet; leave it empty.
      }
      tabs.push({
        index: i,
        title,
        url: page.url(),
        active: i === this.activeIndex,
      });
    }
    return tabs;
  }

  /**
   * Open a new tab and make it the active one. When `url` is given, the new tab navigates
   * there before returning. Returns the new tab's 0-based index.
   */
  async newTab(url?: string): Promise<number> {
    await this.getPage();
    if (!this.context) {
      throw new Error("Cannot open a tab before the browser context exists.");
    }
    const page = await this.context.newPage();
    this.trackPage(page);
    this.pages.push(page);
    this.activeIndex = this.pages.length - 1;
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return this.activeIndex;
  }

  /**
   * Close the tab at `index`. The active tab is re-pointed to a still-open neighbour. The
   * last remaining tab cannot be closed via this method (use {@link close} to end the
   * session).
   */
  async closeTab(index: number): Promise<void> {
    await this.getPage();
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`No tab at index ${index}; open tabs: 0..${this.pages.length - 1}.`);
    }
    if (this.pages.length === 1) {
      throw new Error("Cannot close the last remaining tab; use browser_close instead.");
    }
    const [page] = this.pages.splice(index, 1);
    try {
      await page?.close();
    } catch {
      // Page may already be closed; ignore.
    }
    // Keep the active index within bounds and pointed at a live tab.
    if (this.activeIndex >= this.pages.length) {
      this.activeIndex = this.pages.length - 1;
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1;
    }
  }

  /** Make the tab at `index` the active one that {@link getPage}/{@link resolveRef} act on. */
  async selectTab(index: number): Promise<void> {
    await this.getPage();
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`No tab at index ${index}; open tabs: 0..${this.pages.length - 1}.`);
    }
    this.activeIndex = index;
    // Bring the tab to the foreground so subsequent interactions target it.
    try {
      await this.pages[index]!.bringToFront();
    } catch {
      // Non-fatal: some engines/headless modes ignore bringToFront.
    }
  }

  /** Return the browser context, launching the browser lazily if needed. */
  private async getContext(): Promise<BrowserContext> {
    await this.getPage();
    if (!this.context) {
      throw new Error("Cannot access the browser context before it exists.");
    }
    return this.context;
  }

  // --- Cookie storage boundary (capability: storage) ---

  /** List all cookies in the current context. */
  async listCookies(): Promise<Cookie[]> {
    const context = await this.getContext();
    return context.cookies();
  }

  /**
   * Add (or overwrite) a cookie. A `url` or an explicit `domain`+`path` is required by
   * Playwright; when neither is given, the active page's URL is used so a caller can set a
   * cookie for the current page without spelling out the domain.
   */
  async setCookie(cookie: {
    name: string;
    value: string;
    url?: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }): Promise<void> {
    const context = await this.getContext();
    const hasDomainPath = cookie.domain !== undefined && cookie.path !== undefined;
    const url = cookie.url ?? (hasDomainPath ? undefined : this.pages[this.activeIndex]?.url());
    // Playwright requires either url or domain+path; assemble whichever the caller gave.
    const toAdd: Parameters<BrowserContext["addCookies"]>[0][number] = {
      name: cookie.name,
      value: cookie.value,
      ...(url ? { url } : {}),
      ...(cookie.domain !== undefined ? { domain: cookie.domain } : {}),
      ...(cookie.path !== undefined ? { path: cookie.path } : {}),
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
    };
    await context.addCookies([toAdd]);
  }

  /**
   * Delete the cookie(s) with the given name by clearing all cookies and re-adding the
   * survivors. Playwright's `clearCookies` supports a name filter, which we use directly.
   */
  async deleteCookie(name: string): Promise<void> {
    const context = await this.getContext();
    await context.clearCookies({ name });
  }

  /** Remove all cookies from the current context. */
  async clearCookies(): Promise<void> {
    const context = await this.getContext();
    await context.clearCookies();
  }

  // --- Web storage boundary (localStorage / sessionStorage; capability: storage) ---

  /**
   * Run an operation against `window.localStorage` or `window.sessionStorage` on the active
   * page. Confining the `page.evaluate` here keeps every Playwright call inside this
   * boundary; tools pass a plain `which` discriminator.
   */
  async webStorage(
    which: "localStorage" | "sessionStorage",
    op:
      | { kind: "list" }
      | { kind: "get"; key: string }
      | { kind: "set"; key: string; value: string }
      | { kind: "delete"; key: string }
      | { kind: "clear" },
  ): Promise<Record<string, string> | string | null | void> {
    const page = await this.getPage();
    switch (op.kind) {
      case "list":
        return page.evaluate((store) => {
          const s = store === "localStorage" ? window.localStorage : window.sessionStorage;
          const out: Record<string, string> = {};
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (k !== null) out[k] = s.getItem(k) ?? "";
          }
          return out;
        }, which);
      case "get":
        return page.evaluate(
          ([store, key]) => {
            const s = store === "localStorage" ? window.localStorage : window.sessionStorage;
            return s.getItem(key);
          },
          [which, op.key] as const,
        );
      case "set":
        await page.evaluate(
          ([store, key, value]) => {
            const s = store === "localStorage" ? window.localStorage : window.sessionStorage;
            s.setItem(key, value);
          },
          [which, op.key, op.value] as const,
        );
        return;
      case "delete":
        await page.evaluate(
          ([store, key]) => {
            const s = store === "localStorage" ? window.localStorage : window.sessionStorage;
            s.removeItem(key);
          },
          [which, op.key] as const,
        );
        return;
      case "clear":
        await page.evaluate((store) => {
          const s = store === "localStorage" ? window.localStorage : window.sessionStorage;
          s.clear();
        }, which);
        return;
    }
  }

  // --- Storage state save/restore boundary (capability: storage) ---

  /**
   * Write the context's storage state (cookies + origin localStorage) to `path` as JSON
   * and return the same state object, so a caller can persist and later restore a session.
   */
  async saveStorageState(path: string): Promise<Awaited<ReturnType<BrowserContext["storageState"]>>> {
    const context = await this.getContext();
    return context.storageState({ path });
  }

  /**
   * Restore storage state previously written by {@link saveStorageState}. Cookies are added
   * to the current context directly; localStorage is restored per-origin by navigating to
   * the origin and replaying entries via `page.evaluate`. A full storageState is normally
   * applied at context creation, but we restore into the live context so the session and its
   * open tabs are preserved.
   */
  async restoreStorageState(state: {
    cookies?: Cookie[];
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  }): Promise<void> {
    const context = await this.getContext();
    if (state.cookies && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
    }
    const page = await this.getPage();
    for (const origin of state.origins ?? []) {
      if (origin.localStorage.length === 0) continue;
      // localStorage is per-origin, so the page must be on that origin to write it.
      if (!page.url().startsWith(origin.origin)) {
        try {
          await page.goto(origin.origin, { waitUntil: "domcontentloaded" });
        } catch {
          // Origin may be unreachable offline; skip restoring its localStorage.
          continue;
        }
      }
      await page.evaluate((entries) => {
        for (const { name, value } of entries) {
          window.localStorage.setItem(name, value);
        }
      }, origin.localStorage);
    }
  }

  // --- Routing / network-mocking boundary (capability: network) ---

  /**
   * Register (or replace) a route-mocking rule. Matching requests are fulfilled with the
   * rule's canned response or aborted, instead of hitting the network. The rule is recorded
   * so {@link listRoutes} can enumerate active rules and {@link unroute} can remove one.
   */
  async route(rule: RouteRule): Promise<void> {
    const context = await this.getContext();
    // Replace any existing handler for this pattern so re-registering is idempotent.
    if (this.routeRules.has(rule.urlPattern)) {
      await context.unroute(rule.urlPattern);
    }
    this.routeRules.set(rule.urlPattern, { ...rule });
    await context.route(rule.urlPattern, async (route) => {
      // Read the latest rule for this pattern so an in-place update takes effect.
      const active = this.routeRules.get(rule.urlPattern);
      if (!active) {
        await route.continue();
        return;
      }
      if (active.action === "abort") {
        await route.abort(active.errorCode ?? "failed");
        return;
      }
      await route.fulfill({
        status: active.status ?? 200,
        ...(active.headers ? { headers: active.headers } : {}),
        ...(active.body !== undefined ? { body: active.body } : {}),
      });
    });
  }

  /** List the active route-mocking rules, in insertion order. */
  listRoutes(): RouteRule[] {
    return Array.from(this.routeRules.values()).map((r) => ({ ...r }));
  }

  /**
   * Remove the route-mocking rule for `urlPattern`. Returns true if a rule was present.
   */
  async unroute(urlPattern: string): Promise<boolean> {
    const context = await this.getContext();
    if (!this.routeRules.has(urlPattern)) return false;
    this.routeRules.delete(urlPattern);
    await context.unroute(urlPattern);
    return true;
  }

  /** Toggle the context between offline and online. */
  async setOffline(offline: boolean): Promise<void> {
    const context = await this.getContext();
    await context.setOffline(offline);
  }

  // --- PDF boundary (capability: pdf) ---

  /**
   * Render the active page to PDF via `page.pdf`. This is Chromium-only in Playwright (it
   * uses the DevTools print-to-PDF path), so callers on Firefox/WebKit will get an error.
   * When `path` is given the PDF is also written there; the bytes are always returned so a
   * caller can inspect or persist them.
   */
  async pdf(path?: string): Promise<Buffer> {
    const page = await this.getPage();
    return page.pdf(path ? { path } : {});
  }

  // --- Vision / raw mouse boundary (capability: vision) ---

  /** Move the mouse to absolute page coordinates. */
  async mouseMove(x: number, y: number): Promise<void> {
    const page = await this.getPage();
    await page.mouse.move(x, y);
  }

  /** Move to coordinates and click there with the given button (default left). */
  async mouseClick(
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
  ): Promise<void> {
    const page = await this.getPage();
    await page.mouse.move(x, y);
    await page.mouse.click(x, y, { button });
  }

  /** Press-and-hold the given mouse button at the current cursor position. */
  async mouseDown(button: "left" | "right" | "middle" = "left"): Promise<void> {
    const page = await this.getPage();
    await page.mouse.down({ button });
  }

  /** Release the given mouse button at the current cursor position. */
  async mouseUp(button: "left" | "right" | "middle" = "left"): Promise<void> {
    const page = await this.getPage();
    await page.mouse.up({ button });
  }

  /** Drag from a start coordinate to an end coordinate via down -> move -> up. */
  async mouseDrag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): Promise<void> {
    const page = await this.getPage();
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // An intermediate move makes drag handlers that watch for movement fire reliably.
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();
  }

  /** Scroll the page by a wheel delta. */
  async mouseWheel(deltaX: number, deltaY: number): Promise<void> {
    const page = await this.getPage();
    await page.mouse.wheel(deltaX, deltaY);
  }

  // --- DevTools boundary (capability: devtools) ---

  /**
   * Start Playwright tracing on the context (screenshots + snapshots + sources). The trace
   * is finalised and written to a zip by {@link stopTracing}.
   */
  async startTracing(): Promise<void> {
    const context = await this.getContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  /** Stop tracing and write the trace zip to `path`. */
  async stopTracing(path: string): Promise<void> {
    const context = await this.getContext();
    await context.tracing.stop({ path });
  }

  /**
   * Draw a visible outline around the element resolved from a ref/selector, via an injected
   * inline style. Returns false when the element cannot be found. This is a real,
   * evaluate-based highlight (the headless analogue of the codegen inspector overlay).
   */
  async highlight(target: string): Promise<boolean> {
    await this.getPage();
    const locator = this.resolveRef(target);
    const count = await locator.count();
    if (count === 0) return false;
    await locator.first().evaluate((el) => {
      const he = el as HTMLElement;
      he.setAttribute("data-laya-highlight-prev", he.style.outline || "");
      he.style.outline = "3px solid #ff00ff";
      he.style.outlineOffset = "1px";
    });
    return true;
  }

  /** Remove any outline previously added by {@link highlight} across the page. */
  async hideHighlight(): Promise<void> {
    const page = await this.getPage();
    await page.evaluate(() => {
      const marked = document.querySelectorAll("[data-laya-highlight-prev]");
      for (const el of Array.from(marked)) {
        const he = el as HTMLElement;
        he.style.outline = he.getAttribute("data-laya-highlight-prev") ?? "";
        he.removeAttribute("data-laya-highlight-prev");
      }
    });
  }

  /**
   * Run a raw Playwright snippet against the active page. The snippet is compiled as an
   * async function body receiving the `page` object, so callers can express arbitrary
   * automation (e.g. `return await page.title()`). This is deliberately unrestricted and is
   * only reachable through the guarded `browser_run_code_unsafe` tool.
   */
  async runCode(code: string): Promise<unknown> {
    const page = await this.getPage();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(
      "page",
      `return (async () => { ${code} })();`,
    ) as (page: Page) => Promise<unknown>;
    return fn(page);
  }

  /** Close the page(s)/context/browser and release all resources. Idempotent. */
  async close(): Promise<void> {
    // Close inner-to-outer; guard each so a partially-launched session still cleans up.
    for (const page of this.pages) {
      try {
        await page.close();
      } catch {
        // Page may already be closed; ignore.
      }
    }
    try {
      await this.context?.close();
    } catch {
      // Context may already be closed; ignore.
    }
    try {
      await this.browser?.close();
    } catch {
      // Browser may already be closed; ignore.
    }
    this.pages = [];
    this.activeIndex = 0;
    this.context = undefined;
    this.browser = undefined;
    this.routeRules.clear();
  }
}
