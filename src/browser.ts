/**
 * Playwright browser lifecycle + the ref-resolution boundary.
 *
 * `BrowserSession` owns a single Chromium browser/context and one or more pages (tabs),
 * launched lazily on first use. It is the ONLY place that talks to Playwright's launch
 * API, so the rest of the server depends on this small surface rather than on Playwright
 * directly. All multi-tab, dialog, console, network, and raw-snippet behaviour is confined
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
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import type {
  ConsoleMessageRecord,
  DialogRecord,
  NetworkRequestRecord,
  TabInfo,
} from "./types.js";

/** Configuration for a {@link BrowserSession}. */
export interface BrowserSessionOptions {
  /** Launch headless (default) or headed. Defaults to `true`. */
  headless?: boolean;
  /** Viewport size for the page. Defaults to 1280x800. */
  viewport?: { width: number; height: number };
  /** Optional Chromium channel (e.g. `"chrome"`, `"msedge"`). */
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

/** A snapshot ref looks like `e` followed by one or more digits, e.g. `e12`. */
const REF_PATTERN = /^e\d+$/;

/** Cap the console/network buffers so a long-running session cannot grow unbounded. */
const RING_BUFFER_LIMIT = 500;

/**
 * A lazily-launched Chromium session: browser -> context -> one or more pages (tabs).
 *
 * Nothing is launched until {@link getPage} (or a method that needs the page) is first
 * called, so constructing a session in Assist mode with no work to do is cheap and
 * loads no model weights.
 */
export class BrowserSession {
  private readonly options: Required<Omit<BrowserSessionOptions, "channel">> &
    Pick<BrowserSessionOptions, "channel">;

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

  constructor(options: BrowserSessionOptions = {}) {
    this.options = {
      headless: options.headless ?? true,
      viewport: options.viewport ?? { width: 1280, height: 800 },
      channel: options.channel,
      actionTimeoutMs: options.actionTimeoutMs ?? 10000,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 20000,
    };
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
    const browser = await chromium.launch({
      headless: this.options.headless,
      ...(this.options.channel ? { channel: this.options.channel } : {}),
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
  }
}
