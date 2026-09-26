/**
 * Playwright browser lifecycle + the ref-resolution boundary.
 *
 * `BrowserSession` owns a single Chromium browser/context/page, launched lazily on
 * first use. It is the ONLY place that talks to Playwright's launch API, so the rest
 * of the server depends on this small surface rather than on Playwright directly.
 *
 * The ref boundary lives here too: {@link BrowserSession.resolveRef} turns a snapshot
 * ref (`"e5"`) into a Playwright `Locator` via the `data-laya-ref` attribute stamped by
 * {@link ./snapshot.capture}. An unrecognised target string is treated as a raw
 * Playwright selector, so callers can also address elements by CSS/text selectors.
 * We own this boundary deliberately: stable `playwright-core@1.63.0` exposes no public
 * `_snapshotForAI`/`snapshotForAI`, so nothing here depends on a Playwright private API.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";

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

/** A snapshot ref looks like `e` followed by one or more digits, e.g. `e12`. */
const REF_PATTERN = /^e\d+$/;

/**
 * A lazily-launched Chromium session: browser -> context -> page.
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
  private page?: Page;
  /** Serialises concurrent lazy-launch calls so we launch exactly one browser. */
  private launching?: Promise<Page>;

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
    if (this.page) return this.page;
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
    const page = await context.newPage();

    this.browser = browser;
    this.context = context;
    this.page = page;
    return page;
  }

  /**
   * Resolve a target string to a Playwright {@link Locator}.
   *
   * A target matching the ref shape (`eN`) is resolved by the `data-laya-ref`
   * attribute that {@link ./snapshot.capture} stamps on interactive elements. Any other
   * string is treated as a raw Playwright selector (CSS, text=, etc). This is the single
   * guarded boundary where an opaque target becomes a concrete element locator.
   */
  resolveRef(target: string): Locator {
    if (!this.page) {
      throw new Error(
        "Cannot resolve a target before the page has been created; call getPage() first.",
      );
    }
    const trimmed = target.trim();
    if (REF_PATTERN.test(trimmed)) {
      return this.page.locator(`[data-laya-ref="${trimmed}"]`);
    }
    return this.page.locator(trimmed);
  }

  /** Close the page/context/browser and release all resources. Idempotent. */
  async close(): Promise<void> {
    // Close inner-to-outer; guard each so a partially-launched session still cleans up.
    try {
      await this.page?.close();
    } catch {
      // Page may already be closed; ignore.
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
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }
}
