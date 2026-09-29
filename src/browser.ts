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
import { existsSync } from "node:fs";
import type {
  ConsoleMessageRecord,
  DialogRecord,
  NetworkRequestRecord,
  NodeGuard,
  RouteRule,
  TabInfo,
} from "./types.js";
import { DEFAULT_OVERLAY_ACCENT, type OverlayConfig } from "./config.js";
import { BrowserOverlay } from "./overlay.js";
import { captureFast } from "./snapshot.js";

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
  /**
   * (T2.1) Path to a Playwright storage-state JSON file for automatic session persistence.
   * When set: if the file exists at launch it is loaded so the browser context starts with
   * those cookies + per-origin localStorage (an authenticated session resumes); and on
   * {@link close} the current context's storage state is written back to the same path.
   * Undefined (the default) is a complete no-op, so existing sessions are unaffected.
   */
  storageStatePath?: string;
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
 * (Perf) Default settle-probe QUIET period, in milliseconds.
 *
 * {@link BrowserSession.probeSettle} resolves as soon as the page has been free of GENUINE
 * mutations for this long, instead of always sleeping the full {@link DEFAULT_SETTLE_PROBE_MS}
 * cap. A page that was already settled when the probe started — the common case, since a click
 * does its work before the probe is called — therefore costs roughly `quietMs` rather than the
 * whole cap. A page that is still mutating keeps re-arming the quiet timer, so the probe still
 * measures the true settling window, and the cap remains a HARD upper bound: the wait can never
 * exceed the previous behaviour. Set `quietMs: 0` to restore the fixed-window behaviour exactly.
 */
export const DEFAULT_SETTLE_QUIET_MS = 120;

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
 * (F1) Deep-equal two {@link NodeGuard} fingerprints field by field. A guard is a flat struct
 * of JSON scalars, so a field-wise comparison is exact and cheap (avoids JSON.stringify key
 * ordering pitfalls). Used by {@link BrowserSession.freshGuard} to decide fresh vs stale.
 */
function guardsEqual(a: NodeGuard, b: NodeGuard): boolean {
  return (
    a.role === b.role &&
    a.name === b.name &&
    a.value === b.value &&
    a.checked === b.checked &&
    a.selectedIndex === b.selectedIndex &&
    a.disabled === b.disabled &&
    a.ariaExpanded === b.ariaExpanded &&
    a.ariaChecked === b.ariaChecked &&
    a.ariaSelected === b.ariaSelected &&
    a.href === b.href &&
    a.scopeText === b.scopeText
  );
}

/**
 * (F1) In-page: recompute [pageKey, guard(node)] for a specific persistent nodeId, exactly as
 * captureFast built them, so the Node side can deep-equal it against the recorded expectation.
 * Returns null when the identity cache is absent; the guard is null when the node is gone /
 * invisible. Self-contained (closes over nothing from Node).
 */
function currentGuardAndPageKey(nodeId: number): {
  pageKey: string;
  guard: NodeGuard | null;
} | null {
  interface LayaFastCache {
    ids: WeakMap<Element, number>;
    nodes: Map<number, Element>;
    next: number;
  }
  const w = window as unknown as { __layaFast?: LayaFastCache };
  const cache = w.__layaFast;
  if (!cache) return null;
  function viewOf(el: Element): Window {
    return (el.ownerDocument && el.ownerDocument.defaultView) || window;
  }
  function isVisible(el: Element): boolean {
    const rect = (el as HTMLElement).getBoundingClientRect();
    const style = viewOf(el).getComputedStyle(el as HTMLElement);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
    if (rect.width === 0 && rect.height === 0) {
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "select" && tag !== "textarea") return false;
    }
    return true;
  }
  function roleFor(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit && explicit.trim()) return explicit.trim();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      if (type === "hidden") return "hidden";
      return "textbox";
    }
    if (el.hasAttribute("contenteditable")) return "textbox";
    return tag;
  }
  // (F1) Accessible-name derivation, kept BYTE-FOR-BYTE identical to captureFast's
  // accessibleName in snapshot.ts so the act-time guard recompute never disagrees with the
  // observe-time guard. The full fallback chain is: aria-label, aria-labelledby, associated
  // label/placeholder/name for form fields, input submit/button/reset value, title,
  // textContent, then a child img[alt]. Any divergence here would make guardsEqual report a
  // fresh node as stale, so this MUST mirror accessibleName exactly.
  function nameFor(el: Element): string {
    const he = el as HTMLElement;
    const tag = el.tagName.toLowerCase();

    const ariaLabel = he.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const doc = he.ownerDocument || document;

    const labelledBy = he.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = he.getAttribute("id");
      if (id) {
        const lbl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl && lbl.textContent && lbl.textContent.trim()) return lbl.textContent.trim();
      }
      const wrapping = he.closest("label");
      if (wrapping && wrapping.textContent && wrapping.textContent.trim())
        return wrapping.textContent.trim();
      const placeholder = he.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
      const nameAttr = he.getAttribute("name");
      if (nameAttr && nameAttr.trim()) return nameAttr.trim();
    }

    if (tag === "input") {
      const type = (he.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") {
        const v = (he as HTMLInputElement).value;
        if (v && v.trim()) return v.trim();
      }
    }

    const title = he.getAttribute("title");
    if (title && title.trim()) return title.trim();

    const text = (he.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.length > 120 ? text.slice(0, 117) + "..." : text;

    const altImg = he.querySelector("img[alt]");
    if (altImg) {
      const alt = altImg.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();
    }

    return "";
  }
  // pageKey: recompute exactly as captureFast (form-field state + document/nav identity).
  let formState: unknown[] = [];
  try {
    formState = Array.from(document.querySelectorAll("input,textarea,select")).map((e) => {
      const el = e as HTMLInputElement & HTMLSelectElement;
      return [
        cache.ids.get(e) ?? -1,
        el.value ?? null,
        el.checked ?? null,
        el.selectedIndex ?? null,
        el.disabled ?? null,
        el.readOnly ?? null,
      ];
    });
  } catch {
    formState = [];
  }
  const pageKey = JSON.stringify([
    window.location.href,
    window.scrollX,
    window.scrollY,
    window.innerWidth,
    window.innerHeight,
    formState,
  ]);

  const el = cache.nodes.get(nodeId);
  if (!el || !el.isConnected || !isVisible(el)) {
    return { pageKey, guard: null };
  }
  const role = roleFor(el);
  const name = nameFor(el);
  const tag = el.tagName.toLowerCase();
  const he = el as HTMLInputElement;
  let value: string | null = null;
  let checked: boolean | null = null;
  let selectedIndex: number | null = null;
  if (tag === "input") {
    const type = (he.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") checked = he.checked;
    else value = he.value;
  } else if (tag === "textarea") {
    value = (el as unknown as HTMLTextAreaElement).value;
  } else if (tag === "select") {
    const sel = el as unknown as HTMLSelectElement;
    selectedIndex = sel.selectedIndex;
    const selected = sel.options[sel.selectedIndex];
    value = selected ? selected.label || selected.value : null;
  } else if (el.hasAttribute("contenteditable")) {
    value = (el.textContent ?? "").trim();
  }
  const scope =
    el.closest("form,dialog,[role='dialog'],article,li,tr,[role='row']") || el.parentElement;
  const scopeText = ((scope as HTMLElement | null)?.innerText ?? "").slice(0, 6000);
  const guard: NodeGuard = {
    role,
    name,
    value,
    checked,
    selectedIndex,
    disabled: (el as HTMLButtonElement).disabled === true || el.matches(":disabled"),
    ariaExpanded: el.getAttribute("aria-expanded"),
    ariaChecked: el.getAttribute("aria-checked"),
    ariaSelected: el.getAttribute("aria-selected"),
    href: el.getAttribute("href"),
    scopeText,
  };
  return { pageKey, guard };
}

/**
 * (F1) In-page: act on the observed node resolved from `window.__layaFast.nodes`. Re-checks
 * connected/visible/enabled/not-readonly-for-fill, computes the rect center, occlusion
 * hit-tests `e.contains(document.elementFromPoint(x,y))` (rejects a covered/off-viewport
 * control BEFORE input), then performs the input. Self-contained (closes over nothing).
 * Returns a structured {ok, reason} object so the caller can re-observe on a soft failure.
 */
function actOnNodeInPage(args: {
  nodeId: number;
  kind: "click" | "fill" | "select";
  value: string | null;
}): {
  ok: boolean;
  reason?: "stale" | "covered" | "gone";
  /** For a click: the verified, unoccluded point the caller must press with a real pointer. */
  point?: { x: number; y: number };
  /** For a contenteditable fill: the text is selected and must be replaced by real input. */
  insert?: boolean;
} {
  interface LayaFastCache {
    ids: WeakMap<Element, number>;
    nodes: Map<number, Element>;
    next: number;
  }
  const w = window as unknown as { __layaFast?: LayaFastCache };
  const cache = w.__layaFast;
  if (!cache) return { ok: false, reason: "gone" };
  const el = cache.nodes.get(args.nodeId) as HTMLElement | undefined;
  if (!el || !el.isConnected) return { ok: false, reason: "gone" };
  // Enabled + not aria-disabled/inert.
  if (
    el.matches(":disabled") ||
    el.closest("[aria-disabled='true'],[inert]")
  ) {
    return { ok: false, reason: "stale" };
  }
  // Visible.
  const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return { ok: false, reason: "stale" };
  }
  // not-readonly for fill.
  if (
    args.kind === "fill" &&
    ((el as HTMLInputElement).readOnly === true ||
      el.getAttribute("aria-readonly") === "true")
  ) {
    return { ok: false, reason: "stale" };
  }
  const outside = (r: DOMRect): boolean => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight;
  };
  let rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: "covered" };
  // The model is offered controls anywhere on the page, not only on screen: bring an
  // off-screen target into view (instantly, so geometry is final) before the hit-test, the
  // way a user would scroll to it. Refusing it as "covered" only burned a self-heal retry.
  if (outside(rect)) {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    rect = el.getBoundingClientRect();
    if (outside(rect)) return { ok: false, reason: "covered" };
  }
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  // OCCLUSION hit-test: the element under the rect center must be (or contain) the target.
  const hit = document.elementFromPoint(x, y);
  if (!hit || !el.contains(hit)) {
    return { ok: false, reason: "covered" };
  }
  if (args.kind === "select") {
    const sel = el as unknown as HTMLSelectElement;
    if (el.tagName !== "SELECT") return { ok: false, reason: "stale" };
    const want = args.value ?? "";
    const match = Array.from(sel.options).find(
      (o) => (o.value === want || o.label === want) && !o.disabled,
    );
    if (!match) return { ok: false, reason: "stale" };
    // The prototype setter, not `sel.value =`: frameworks (React) shadow the instance setter to
    // track the value, and an instance write marks the change as already seen, so the input
    // event below would be swallowed and the app state never updates.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      sel,
      match.value,
    );
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (args.kind === "fill") {
    const input = el as HTMLInputElement;
    input.focus();
    try {
      input.select?.();
    } catch {
      // Some editable elements have no select(); ignore.
    }
    const text = args.value ?? "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      // Prototype setter for the same React value-tracker reason as the select path.
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, text);
    } else if (el.isContentEditable) {
      // Rich editors ignore a textContent write; select everything and let the caller replace
      // it with real (trusted) text input.
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return { ok: true, insert: true };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  // click: the hit-test above proved this point lands on the target, so the caller presses it
  // with a real pointer (trusted pointerdown/mousedown/mouseup/click, like a user), instead of
  // a synthetic el.click() that menus/widgets listening on pointer events never see.
  return { ok: true, point: { x, y } };
}

/**
 * (F1) In-page: the bounded adaptive wait. After a fill into a combobox, waits for a visible
 * `[role=option]` under the field's aria-controls/aria-owns up to capMs; otherwise resolves
 * after >= 2 animation frames. Self-contained (closes over nothing). Always resolves.
 */
function adaptiveWaitInPage(args: {
  nodeId: number;
  kind: "click" | "fill" | "select";
  capMs: number;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    interface LayaFastCache {
      ids: WeakMap<Element, number>;
      nodes: Map<number, Element>;
      next: number;
    }
    const w = window as unknown as { __layaFast?: LayaFastCache };
    const field = w.__layaFast?.nodes.get(args.nodeId) as HTMLElement | undefined;
    const autocomplete =
      args.kind === "fill" && field?.getAttribute("role") === "combobox";
    let frames = 0;
    let stopped = false;
    const finish = (): void => {
      if (stopped) return;
      stopped = true;
      resolve();
    };
    // Hard cap: an autocomplete list gets up to capMs, a plain action a short floor.
    window.setTimeout(finish, autocomplete ? args.capMs : Math.min(50, args.capMs));
    const ready = (): void => {
      if (stopped) return;
      const ids = (
        field?.getAttribute("aria-controls") ||
        field?.getAttribute("aria-owns") ||
        ""
      )
        .split(/\s+/)
        .filter(Boolean);
      const roots: (Document | HTMLElement)[] = ids.length
        ? (ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[])
        : [document];
      const options = roots.flatMap((root) =>
        Array.from(root.querySelectorAll("[role='option']")),
      );
      const anyVisible =
        !autocomplete ||
        options.some((e) => {
          const r = (e as HTMLElement).getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.top < window.innerHeight
          );
        });
      if (++frames >= 2 && anyVisible) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  });
}

/**
 * A lazily-launched browser session: browser -> context -> one or more pages (tabs).
 *
 * Nothing is launched until {@link getPage} (or a method that needs the page) is first
 * called, so constructing a session in Assist mode with no work to do is cheap and
 * loads no model weights.
 */
export class BrowserSession {
  private readonly options: Required<
    Omit<BrowserSessionOptions, "channel" | "overlay" | "storageStatePath">
  > &
    Pick<BrowserSessionOptions, "channel" | "overlay" | "storageStatePath">;

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
      storageStatePath: options.storageStatePath,
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
        accent: DEFAULT_OVERLAY_ACCENT,
        typingEffect: false,
        waitCountdown: false,
        debugSeeElements: false,
        activityLog: true,
        cursorTrail: 0,
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
    // (Issue 1) A HEADED Chromium launch opens a real OS window whose size is independent of
    // the context viewport, so a larger window renders the fixed-viewport page smaller than
    // the window (a grey strip on the right). Match the OS window to the viewport via
    // `--window-size` for CHROMIUM + HEADED only. Headless ignores/does not need it, and
    // firefox/webkit do not honour Chromium switches, so they never receive the arg. The
    // headed->headless fallback below re-launches WITHOUT this arg.
    const headedWindowArgs =
      this.options.engine === "chromium" && !this.options.headless
        ? {
            args: [
              `--window-size=${this.options.viewport.width},${this.options.viewport.height}`,
            ],
          }
        : {};
    let browser: Browser;
    try {
      browser = await this.browserType.launch({
        headless: this.options.headless,
        ...launchOptions,
        ...headedWindowArgs,
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
    // (T2.1) Auto-load storage state at context creation when a path is configured AND the
    // file exists, so an authenticated session resumes (cookies + per-origin localStorage).
    // A missing/unreadable file is a clean no-op (first run has nothing to restore). A warn is
    // written to stderr only (never stdout) on a genuinely malformed file.
    let storageStateForContext: string | undefined;
    if (this.options.storageStatePath) {
      try {
        if (existsSync(this.options.storageStatePath)) {
          storageStateForContext = this.options.storageStatePath;
        }
      } catch {
        storageStateForContext = undefined;
      }
    }
    const context = await browser.newContext({
      viewport: this.options.viewport,
      ...(storageStateForContext ? { storageState: storageStateForContext } : {}),
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

  /**
   * (T2.3) Frame-aware target resolution: like {@link resolveRef}, but for a `eN` ref that is
   * NOT present in the active page's main frame, it searches the page's child frames (in
   * order) and returns a locator scoped to the FIRST frame that contains the ref. This makes
   * a `data-laya-ref` stamped inside a SAME-ORIGIN iframe (discovered when capture ran with a
   * non-zero `frameDepth`) actionable.
   *
   * The main-frame CSS engine already pierces OPEN shadow roots, so shadow-DOM refs resolve
   * without a frame search. A raw (non-ref) selector, or a ref that resolves in the main
   * frame, returns the same locator as {@link resolveRef}. Async because presence in a frame
   * can only be determined by an awaited `count()`; callers already await the action they run
   * against the returned locator. Falls back to the main-frame locator when no frame matches
   * (so the ensuing action surfaces a normal "element not found" error).
   */
  async locate(target: string): Promise<Locator> {
    const page = this.pages[this.activeIndex];
    if (!page) {
      throw new Error(
        "Cannot resolve a target before the page has been created; call getPage() first.",
      );
    }
    const trimmed = target.trim();
    if (!REF_PATTERN.test(trimmed)) {
      return page.locator(trimmed);
    }
    const selector = `[data-laya-ref="${trimmed}"]`;
    const mainLocator = page.locator(selector);
    try {
      if ((await mainLocator.count()) > 0) return mainLocator;
    } catch {
      // Count can throw mid-navigation; fall through to the frame search.
    }
    // Search child frames (skip the main frame, already checked). Cross-origin frames simply
    // yield no match; a detached frame's count() throwing is caught and skipped.
    const mainFrame = page.mainFrame();
    for (const frame of page.frames()) {
      if (frame === mainFrame) continue;
      try {
        const frameLocator = frame.locator(selector);
        if ((await frameLocator.count()) > 0) return frameLocator;
      } catch {
        // Detached/cross-origin frame; skip.
      }
    }
    // No frame matched: return the main-frame locator so the action surfaces a clear error.
    return mainLocator;
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
  /**
   * Show a manual (Assist) action on the HUD: the cursor glides to the target, the target is
   * selected, and the action is captioned; `click` also plays the press ripple. Best-effort and
   * a no-op when the overlay is off, so it never changes what the tool does.
   */
  async narrate(
    target: string | undefined,
    caption: string,
    { click = false }: { click?: boolean } = {},
  ): Promise<void> {
    if (!this.overlay.isEnabled()) return;
    const page = this.pages[this.activeIndex];
    if (!page) return;
    const ref = target?.trim();
    if (ref && REF_PATTERN.test(ref)) {
      const rect = await this.overlay.focus(page, ref, caption);
      const wait = Math.min(280, rect?.arriveMs ?? 0);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (rect && click) {
        await this.overlay.ripple(page, rect.x + Math.min(rect.width / 2, 40), rect.y + rect.height / 2);
      }
    }
    await this.overlay.callBatch(page, [
      ["setState", "acting"],
      ["setStatus", caption],
      ["log", caption],
    ]);
  }

  /** Make an already-tracked (or newly-seen) page the active tab. */
  activatePage(page: Page): void {
    this.registerPage(page, { activate: true });
  }

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

  // --- Download capture boundary (T2.4; capability: storage) ---

  /**
   * (T2.4) Capture a Playwright `download` triggered by clicking `target`, save it to
   * `savePath`, and report the suggested filename plus the resolved path.
   *
   * The download listener is armed on the active page BEFORE the click so a fast download is
   * never missed, and the click and the `waitForEvent("download")` are awaited together. The
   * saved bytes are written via Playwright's `download.saveAs`, so the file lands wherever the
   * caller chose regardless of the browser's own downloads directory. Bounded by the context
   * action timeout, so a click that produces no download surfaces a clear timeout rather than
   * hanging. This is the SOLE Playwright download boundary; the tool layer never touches it.
   */
  async downloadVia(
    target: string,
    savePath: string,
  ): Promise<{ path: string; suggestedFilename: string }> {
    const page = await this.getPage();
    const locator = this.resolveRef(target);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      locator.click(),
    ]);
    await download.saveAs(savePath);
    return { path: savePath, suggestedFilename: download.suggestedFilename() };
  }

  /**
   * (T2.4) Like {@link downloadVia} but into a DIRECTORY: the browser-suggested filename is
   * known only after the download starts, so this captures the download, then saves it under
   * `dir` using that suggested filename. Returns the resolved path + suggested filename.
   */
  async downloadViaInto(
    target: string,
    dir: string,
  ): Promise<{ path: string; suggestedFilename: string }> {
    const page = await this.getPage();
    const locator = this.resolveRef(target);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      locator.click(),
    ]);
    const suggested = download.suggestedFilename();
    // Join without importing node:path here (keep this module Playwright-focused): the tool
    // layer passed an absolute dir; use a portable separator join.
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    const savePath = `${dir}${sep}${suggested}`;
    await download.saveAs(savePath);
    return { path: savePath, suggestedFilename: suggested };
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
    options: { timeoutMs?: number; beforeUrl?: string; quietMs?: number } = {},
  ): Promise<SettleProbeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_PROBE_MS;
    const quietMs = options.quietMs ?? DEFAULT_SETTLE_QUIET_MS;
    const beforeUrl = options.beforeUrl ?? "";
    try {
      const result = await page.evaluate(
        ({ timeoutMs, quietMs, beforeUrl }) =>
          new Promise<{ urlChanged: boolean; mutations: number; readyComplete: boolean }>(
            (resolve) => {
              let mutations = 0;
              let done = false;
              let observer: MutationObserver | undefined;
              let quietTimer: number | undefined;
              let capTimer: number | undefined;
              const cap = Math.max(0, Math.min(2000, Number(timeoutMs) || 0));
              // The quiet period is clamped INTO the cap, so early exit can only ever shorten
              // the wait, never extend the fixed upper bound.
              const quiet = Math.max(0, Math.min(cap, Number(quietMs) || 0));
              const finish = () => {
                if (done) return;
                done = true;
                try {
                  observer?.disconnect();
                } catch {
                  // Ignore disconnect failures.
                }
                if (quietTimer !== undefined) window.clearTimeout(quietTimer);
                if (capTimer !== undefined) window.clearTimeout(capTimer);
                resolve({
                  urlChanged:
                    typeof beforeUrl === "string" &&
                    beforeUrl !== "" &&
                    window.location.href !== beforeUrl,
                  mutations,
                  readyComplete: document.readyState === "complete",
                });
              };
              // (Perf) Restart the quiet clock; when it elapses the page has stopped changing and
              // the probe can answer immediately instead of sleeping out the whole cap.
              const armQuiet = () => {
                if (done || quiet <= 0) return;
                if (quietTimer !== undefined) window.clearTimeout(quietTimer);
                quietTimer = window.setTimeout(finish, quiet);
              };
              try {
                observer = new MutationObserver((records) => {
                  // (T4.1) Ignore our OWN instrumentation: the snapshot walk stamps
                  // `data-laya-ref` attributes, and a speculative capture may run concurrently
                  // with this probe. Counting those self-inflicted attribute writes would
                  // falsely report the page as "changed", so they are filtered out. Every
                  // genuine page mutation (childList / characterData / other attributes) is
                  // still counted, so the probe's observed semantics are unchanged.
                  let genuine = 0;
                  for (const r of records) {
                    if (
                      r.type === "attributes" &&
                      r.attributeName === "data-laya-ref"
                    ) {
                      continue;
                    }
                    genuine += 1;
                  }
                  mutations += genuine;
                  // Only GENUINE activity restarts the quiet clock: our own ref stamps (and a
                  // speculative capture running alongside) must not extend the wait.
                  if (genuine > 0) armQuiet();
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
              capTimer = window.setTimeout(finish, cap);
              // A page with nothing left to do resolves after one quiet period.
              armQuiet();
            },
          ),
        { timeoutMs, quietMs, beforeUrl },
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

  // --- (F1) Fast-loop persistent-identity execution + freshness -----------------------------
  //
  // These methods back the fast browser loop. They act on the OBSERVED node via the
  // window-scoped identity map (`window.__layaFast.nodes`) that captureFast populates, so NO
  // fresh selector re-query / DOM re-walk happens per action (the round-trip win). Every
  // evaluate is guarded so a mid-navigation rejection degrades to a stale/gone result rather
  // than throwing into the loop.

  /**
   * (F1) Re-evaluate the live freshness of a targeted click/select node in ONE evaluate and
   * deep-equal it to the guard + pageKey captured at decision time. For non-targeted
   * freshness (no nodeId), the whole-page marker is compared instead. Returns false (stale) on
   * any mismatch, when the node is gone, or when the identity cache is absent.
   *
   * This mirrors jev's `fresh`: click/select re-check [pageKey, guard(node)] while other
   * operations re-check the whole-page marker.
   */
  async freshGuard(
    page: Page,
    nodeId: number | undefined,
    expected: { guard?: NodeGuard; pageKey?: string; marker?: string },
  ): Promise<boolean> {
    // Whole-page freshness: recompute the marker via captureFast (so it is byte-identical to
    // the one recorded at observation time) and compare. No node is targeted.
    if (nodeId === undefined) {
      if (expected.marker === undefined) return false;
      try {
        const fresh = await captureFast(page);
        return fresh.marker === expected.marker;
      } catch {
        return false;
      }
    }
    // Targeted freshness: re-read [pageKey, guard(node)] and deep-equal it to the expected.
    // Without a pageKey only the node's own guard is compared (used when the caller's own
    // earlier writes in the same step are what changed the page's form state).
    if (expected.guard === undefined) return false;
    try {
      const current = (await page.evaluate(currentGuardAndPageKey, nodeId)) as
        | { pageKey: string; guard: NodeGuard | null }
        | null;
      if (current === null || current.guard === null) return false;
      return (
        (expected.pageKey === undefined || current.pageKey === expected.pageKey) &&
        guardsEqual(current.guard, expected.guard)
      );
    } catch {
      return false;
    }
  }

  /**
   * (F1) Act on the OBSERVED node (resolved from `window.__layaFast.nodes.get(nodeId)`) in ONE
   * evaluate: re-check isConnected / visible / enabled / not-readonly-for-fill, compute the
   * rect center, OCCLUSION hit-test `e.contains(document.elementFromPoint(x,y))` (reject a
   * covered/off-viewport control BEFORE input), then perform the input. Returns a structured
   * result so the loop can re-observe on `stale`/`covered`/`gone` instead of throwing.
   *
   * For `fill`/`select` the value is written through the element prototype's setter (so
   * framework value trackers such as React's see the change) and input/change are dispatched;
   * a contenteditable is selected and replaced with real keyboard input. For `click` the
   * verified, unoccluded rect center is pressed with a real pointer (`page.mouse.click`), so
   * the full trusted pointer/mouse event sequence fires. NO fresh selector query happens.
   */
  async actOnNode(
    page: Page,
    nodeId: number,
    kind: "click" | "fill" | "select",
    opts: { value?: string } = {},
  ): Promise<{ ok: true } | { ok: false; reason: "stale" | "covered" | "gone" }> {
    if (!Number.isInteger(nodeId)) return { ok: false, reason: "gone" };
    try {
      const outcome = (await page.evaluate(actOnNodeInPage, {
        nodeId,
        kind,
        value: opts.value ?? null,
      })) as ReturnType<typeof actOnNodeInPage> | null;
      if (outcome === null) return { ok: false, reason: "gone" };
      if (outcome.ok) {
        if (outcome.point) await page.mouse.click(outcome.point.x, outcome.point.y);
        if (outcome.insert) {
          const text = opts.value ?? "";
          if (text === "") await page.keyboard.press("Delete");
          else await page.keyboard.insertText(text);
        }
        return { ok: true };
      }
      return { ok: false, reason: outcome.reason ?? "stale" };
    } catch {
      // A mid-navigation rejection: the node is effectively gone for this decision.
      return { ok: false, reason: "gone" };
    }
  }

  /**
   * (F1) A bounded, event-driven adaptive wait replacing the fixed post-action settle on the
   * hot path. After a fill into a combobox it waits (via a requestAnimationFrame loop inside
   * ONE evaluate) for a visible `[role=option]` under the field's aria-controls/aria-owns up
   * to `capMs`, otherwise it resolves after >= 2 animation frames (mirroring jev observe's
   * after-input wait). Never throws: a mid-navigation rejection resolves immediately.
   */
  async adaptiveWait(
    page: Page,
    opts: { nodeId: number; kind: "click" | "fill" | "select"; capMs: number },
  ): Promise<void> {
    try {
      await page.evaluate(adaptiveWaitInPage, {
        nodeId: opts.nodeId,
        kind: opts.kind,
        capMs: Math.max(0, Math.min(2000, opts.capMs)),
      });
    } catch {
      // A navigation/close mid-wait leaves nothing to wait for; resolve immediately.
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
    // (T2.1) Auto-save storage state to the configured path BEFORE tearing the context down,
    // so an authenticated session persists to disk for the next launch to resume. Best-effort:
    // any failure (context already gone, unwritable path) is swallowed so close() never throws
    // and stays idempotent. A no-op when no path was configured or nothing was ever launched.
    if (this.options.storageStatePath && this.context) {
      try {
        await this.context.storageState({ path: this.options.storageStatePath });
      } catch {
        // Nothing to persist / context closing; ignore.
      }
    }
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
