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
import type { OverlayConfig } from "./config.js";
import { BrowserOverlay } from "./overlay.js";

/** The Playwright engine a {@link BrowserSession} drives. */
export type BrowserEngineName = "chromium" | "firefox" | "webkit";

/** Configuration for a {@link BrowserSession}. */
export interface BrowserSessionOptions {
  /** Which Playwright engine to launch. Defaults to `"chromium"`. */
  engine?: BrowserEngineName;
  /**
   * Launch headless or headed. Defaults to `false` (headed). A headed launch on a machine
   * with no display server transparently falls back to headless (see {@link BrowserSession.launch}).
   */
  headless?: boolean;
  /** Viewport size for the page. Defaults to 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Resolved visual-overlay (agentLens HUD) configuration threaded in from the typed config.
   * Optional so a bare `BrowserSession` still works; when omitted the overlay is off.
   */
  overlay?: OverlayConfig;
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

/** (A2) Default post-action settle-probe window, in milliseconds. Kept short and bounded. */
export const DEFAULT_SETTLE_PROBE_MS = 400;

/**
 * (A2) The result of a purely-observational {@link BrowserSession.probeSettle}. Reports
 * whether ANY change was observed after the action, whether the page navigated (URL
 * changed), and the raw DOM mutation count seen over the probe window.
 */
export interface SettleProbeResult {
  /** Whether any change was observed (a navigation OR one or more DOM mutations). */
  changed: boolean;
  /** Whether the URL changed relative to the URL captured just before the action. */
  urlChanged: boolean;
  /** How many DOM mutations were seen over the probe window. */
  mutations: number;
}

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
  private readonly options: Required<Omit<BrowserSessionOptions, "channel" | "overlay">> &
    Pick<BrowserSessionOptions, "channel" | "overlay">;

  /**
   * The headless mode a launch actually used. Starts as the requested option and is set to
   * `true` when a headed launch fails and we fall back to headless, so downstream (e.g. the
   * overlay in `auto` mode) can decide on/off from the mode the browser really runs in.
   */
  private effectiveHeadless: boolean;

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

  /**
   * The visual overlay (agentLens HUD). Built from the resolved overlay config; injected via
   * `context.addInitScript` in {@link launch} when active. Disabled (a no-op controller) when
   * no overlay config was threaded in.
   */
  private readonly overlay: BrowserOverlay;

  constructor(options: BrowserSessionOptions = {}) {
    this.options = {
      engine: options.engine ?? "chromium",
      headless: options.headless ?? false,
      viewport: options.viewport ?? { width: 1280, height: 800 },
      channel: options.channel,
      overlay: options.overlay,
      actionTimeoutMs: options.actionTimeoutMs ?? 10000,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 20000,
    };
    this.browserType = BROWSER_TYPES[this.options.engine];
    this.effectiveHeadless = this.options.headless;
    // Build the overlay from the resolved config. When no overlay config was threaded in,
    // synthesise a disabled one so the controller is a safe no-op.
    this.overlay = new BrowserOverlay(
      this.options.overlay ?? {
        enabled: false,
        mode: "off",
        accent: "#a855f7",
        typingEffect: false,
        waitCountdown: false,
        debugSeeElements: false,
        activityLog: true,
      },
    );
  }

  /**
   * The visual overlay controller, so the Autopilot loop (and other in-boundary callers) can
   * narrate through the same HUD the session installs. Always returns a controller; it is a
   * no-op when the overlay is disabled.
   */
  getOverlay(): BrowserOverlay {
    return this.overlay;
  }

  /** Whether a browser has actually been launched yet. */
  get launched(): boolean {
    return this.browser !== undefined;
  }

  /**
   * The headless mode the browser is actually running in. Before launch this reflects the
   * requested option; after a headed launch that failed and fell back, it is `true`. The
   * overlay uses this to resolve `auto` mode (on when headed) against reality.
   */
  get headless(): boolean {
    return this.effectiveHeadless;
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
    const launchOptions = {
      ...(useChannel ? { channel: this.options.channel } : {}),
    };
    let browser: Browser;
    try {
      browser = await this.browserType.launch({
        headless: this.options.headless,
        ...launchOptions,
      });
      this.effectiveHeadless = this.options.headless;
    } catch (err) {
      // A HEADLESS launch that fails is a real error and must propagate. A HEADED launch can
      // fail on a machine with no display server (e.g. CI/sandbox): warn ONCE to stderr
      // (never stdout, to keep the stdio JSON-RPC stream intact) and retry headless so the
      // server still comes up. On a user's machine with a display, the headed launch works.
      if (this.options.headless) throw err;
      const msg = (err as Error).message;
      process.stderr.write(
        `[laya-browser-mcp] headed launch failed (${msg}); falling back to headless.\n`,
      );
      browser = await this.browserType.launch({ headless: true, ...launchOptions });
      this.effectiveHeadless = true;
    }
    const context = await browser.newContext({
      viewport: this.options.viewport,
    });
    // Bound action/navigation waits so a missing element surfaces as an error promptly
    // instead of hanging for Playwright's 30s default.
    context.setDefaultTimeout(this.options.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

    this.browser = browser;
    this.context = context;

    // A new page can appear in the context WITHOUT the server calling newPage(): the web
    // page itself may open one via window.open(...), a target="_blank" link, or a
    // ctrl/cmd+click. Subscribe once so those externally-opened popups become listable and
    // selectable, mirroring the real Playwright MCP. registerPage() de-dups, so pages the
    // server opens via context.newPage() (which ALSO fires this event) are tracked exactly
    // once and never double-counted.
    context.on("page", (newPage) => {
      // Externally-opened popups do not steal focus: keep the active tab on the opener,
      // matching Playwright MCP (the user must select the new tab to focus it).
      this.registerPage(newPage, { activate: false });
    });

    const page = await context.newPage();
    // The "page" event above will have registered `page`; ensure it is the active tab.
    this.registerPage(page, { activate: true });

    // Resolve the overlay against the EFFECTIVE headless mode: in `auto` mode the overlay is
    // on only when actually headed; `on`/`off` force it regardless. Forced `on` MUST inject
    // even headless so visual verification (which runs headless) can assert the HUD exists.
    const overlayCfg = this.options.overlay;
    if (overlayCfg) {
      const active =
        overlayCfg.mode === "on"
          ? true
          : overlayCfg.mode === "off"
            ? false
            : !this.effectiveHeadless;
      this.overlay.enable(active);
      if (active) {
        // addInitScript covers future loads/tabs; inject into the already-open page too.
        await this.overlay.install(context, [page]);
      }
    }
    return page;
  }

  /**
   * Track a page exactly once: attach listeners and add it to {@link pages}. Called both by
   * the `context.on("page")` subscription (for externally-opened popups) and directly for
   * server-opened tabs, so it de-dups on {@link pages} membership to avoid double-tracking.
   * When `activate` is true the page becomes the active tab; externally-opened popups pass
   * `activate: false` so focus stays on the opener.
   */
  private registerPage(page: Page, { activate }: { activate: boolean }): void {
    if (!this.pages.includes(page)) {
      this.trackPage(page);
      this.pages.push(page);
      // Remove an externally-closed tab from `pages` so listTabs() stays accurate and the
      // active index remains in bounds. Teardown of the last page is close()'s job, so we
      // never drop the final tab here.
      page.once("close", () => this.handlePageClosed(page));
    }
    if (activate) {
      this.activeIndex = this.pages.indexOf(page);
    }
  }

  /**
   * Drop a page that closed on its own (e.g. the site called window.close()) from
   * {@link pages}, keeping {@link activeIndex} within bounds. Mirrors the rebound logic in
   * {@link closeTab}. Never removes the last remaining page (that is {@link close}'s job).
   */
  private handlePageClosed(page: Page): void {
    const index = this.pages.indexOf(page);
    if (index === -1) return;
    if (this.pages.length === 1) return;
    this.pages.splice(index, 1);
    if (this.activeIndex >= this.pages.length) {
      this.activeIndex = this.pages.length - 1;
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1;
    }
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
    // The "page" event fired by newPage() will have registered `page` already; this call
    // de-dups and just makes it the active tab.
    this.registerPage(page, { activate: true });
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
    // Best-effort, AFTER the real action: mirror the synthetic cursor so vision-mode
    // coordinate moves are visible in the HUD without ever changing move semantics.
    await this.overlay.moveCursor(page, x, y);
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
    // Best-effort ripple + cursor AFTER the real click so click behaviour never changes.
    await this.overlay.moveCursor(page, x, y);
    await this.overlay.ripple(page, x, y);
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
    // Best-effort cursor trail AFTER the real drag so drag semantics never change.
    await this.overlay.moveCursor(page, endX, endY);
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
    const page = await this.getPage();
    const locator = this.resolveRef(target);
    const count = await locator.count();
    if (count === 0) return false;
    // When the overlay is active, spotlight the target through the HUD so the highlight
    // survives navigation and matches the agentLens visual language. Still keep the inline
    // outline too (best-effort) so browser_hide_highlight has something to clear even if the
    // overlay is torn down mid-session, and so the contract is identical either way.
    if (this.overlay.isEnabled()) {
      const trimmed = target.trim();
      if (REF_PATTERN.test(trimmed)) {
        await this.overlay.spotlight(page, trimmed);
      } else {
        const rect = await locator
          .first()
          .boundingBox()
          .catch(() => null);
        if (rect) {
          await this.overlay.spotlight(page, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });
        }
      }
    }
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
    if (this.overlay.isEnabled()) {
      await this.overlay.hideSpotlight(page);
    }
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
   * (A2) A lightweight, purely-observational post-action settle probe.
   *
   * Reads `document.readyState`, the current URL, and counts DOM mutations over a short,
   * bounded window via an in-page `MutationObserver`, all inside a single `page.evaluate`
   * with its OWN internal timeout. It deliberately uses NO `networkidle` wait and NO
   * `slowMo`: it never blocks longer than `timeoutMs` and never throws into the caller (any
   * failure resolves to a "nothing observed" result), so the Autopilot loop can consult it
   * without ever changing the decision path or the run outcome.
   *
   * Returns whether a change was observed at all ({@link SettleProbeResult.changed}),
   * whether the URL changed vs. the URL captured just before the action
   * ({@link SettleProbeResult.urlChanged}), and the mutation count seen in the window.
   */
  async probeSettle(
    page: Page,
    options: { timeoutMs?: number; beforeUrl?: string } = {},
  ): Promise<SettleProbeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_PROBE_MS;
    const beforeUrl = options.beforeUrl ?? "";
    try {
      const result = await page.evaluate(
        ({ timeoutMs, beforeUrl }) =>
          new Promise<{ urlChanged: boolean; mutations: number; readyComplete: boolean }>(
            (resolve) => {
              let mutations = 0;
              let observer: MutationObserver | undefined;
              try {
                observer = new MutationObserver((records) => {
                  mutations += records.length;
                });
                observer.observe(document.documentElement, {
                  subtree: true,
                  childList: true,
                  attributes: true,
                  characterData: true,
                });
              } catch {
                // MutationObserver unavailable (extremely rare); fall through with 0 counts.
              }
              const cap = Math.max(0, Math.min(2000, Number(timeoutMs) || 0));
              window.setTimeout(() => {
                try {
                  observer?.disconnect();
                } catch {
                  // Ignore disconnect failures.
                }
                resolve({
                  urlChanged:
                    typeof beforeUrl === "string" &&
                    beforeUrl !== "" &&
                    window.location.href !== beforeUrl,
                  mutations,
                  readyComplete: document.readyState === "complete",
                });
              }, cap);
            },
          ),
        { timeoutMs, beforeUrl },
      );
      const changed = result.urlChanged || result.mutations > 0;
      return {
        changed,
        urlChanged: result.urlChanged,
        mutations: result.mutations,
      };
    } catch {
      // A navigation/close mid-probe (or an evaluate rejection) leaves us with no signal;
      // report "nothing observed" so the probe stays purely observational and never throws.
      return { changed: false, urlChanged: false, mutations: 0 };
    }
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
