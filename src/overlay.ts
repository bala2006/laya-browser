/**
 * The agentLens visual overlay — a self-contained, on-page HUD that narrates what Laya is
 * doing, injected via `context.addInitScript` so it re-appears after every navigation and on
 * every new tab (the fatal flaw of the old one-shot `highlight()` was that a navigation wiped
 * it). {@link BrowserSession} owns exactly one {@link BrowserOverlay}; the rest of the server
 * never touches Playwright's injection API directly.
 *
 * Two halves live here:
 *   1. A CLIENT script (see {@link CLIENT_SCRIPT}) that runs INSIDE the page. It closes over
 *      nothing from Node (Playwright serialises it as a string), installs itself exactly once
 *      per document (idempotent via a `window.__layaOverlayInstalled` flag), and builds a
 *      fixed-position root with a VERY high z-index and `pointer-events:none` on the root and
 *      every child, so overlay nodes NEVER intercept a real click or alter page behaviour. It
 *      exposes `window.__layaOverlay` with the methods the server drives.
 *   2. A SERVER-side {@link BrowserOverlay} class whose methods act on the active Playwright
 *      {@link Page} via `page.evaluate`. Every method is wrapped so it NEVER throws into the
 *      caller: if `window.__layaOverlay` is missing (e.g. mid-navigation, before the init
 *      script ran), the call is a silent no-op. This lets the autopilot loop and the raw mouse
 *      ops narrate best-effort without ever changing automation semantics.
 *
 * Tiers implemented (per the plan):
 *   T1 banner + synthetic cursor + click ripple + target spotlight
 *   T2 action popover/caption + status HUD (setStatus/progress/setState) + optional typing
 *   T3 scroll indicator + auto-dismissing toasts + success/error/uncertain colouring + WAIT countdown
 *   T4 collapsible activity-log panel + Esc-to-release hint + idle heartbeat + debug see-elements
 */
import type { BrowserContext, Page } from "playwright";
import type { OverlayConfig } from "./config.js";

/** A visual "mood" the HUD reflects; drives label, icon, and accent colour. */
export type OverlayState = "thinking" | "acting" | "success" | "error" | "uncertain";

/** A toast severity; controls the toast's accent colour. */
export type ToastKind = "info" | "success" | "error" | "uncertain";

/** A scroll direction shown by the scroll indicator. */
export type ScrollDirection = "up" | "down" | "left" | "right";

/** A rectangle in CSS pixels relative to the viewport (spotlight target). */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Options baked into the injected client script. Only serialisable primitives — this object
 * is JSON-embedded into the script string, so it must close over nothing from Node.
 */
interface OverlayClientOptions {
  accent: string;
  uncertainColor: string;
  typingEffect: boolean;
  waitCountdown: boolean;
  debugSeeElements: boolean;
  activityLog: boolean;
  /** (T3.4) Default breadcrumb-trail length for the synthetic cursor (0 disables). */
  cursorTrail: number;
}

/** The uncertainty accent (amber), shared client/server. */
export const OVERLAY_UNCERTAIN_COLOR = "#f59e0b";

/**
 * Build the client-side injected script as a string. Runs inside the page. `optsJson` is a
 * JSON literal embedded verbatim; the IIFE reads it, installs once, and defines
 * `window.__layaOverlay`. Everything is inline so the script is fully self-contained.
 */
function buildClientScript(optsJson: string): string {
  return `(() => {
  const OPTS = ${optsJson};
  if (window.__layaOverlayInstalled) return;
  window.__layaOverlayInstalled = true;

  const NS = "__laya_overlay__";
  const Z = "2147483646"; // just under the max 32-bit z-index so nothing of ours is clipped

  // Root is created lazily once <body> exists (init scripts can run before body parse).
  let root = null;
  let els = {};
  let toastTimers = [];
  let countdownRaf = 0;
  let heartbeat = false;

  function css(node, styles) { for (const k in styles) node.style[k] = styles[k]; }

  function mkDiv(styles) {
    const d = document.createElement("div");
    css(d, Object.assign({ pointerEvents: "none" }, styles || {}));
    return d;
  }

  function ensureRoot() {
    if (root && document.documentElement.contains(root)) return root;
    const host = document.body || document.documentElement;
    if (!host) return null;
    root = document.getElementById(NS);
    if (root && document.documentElement.contains(root)) return root;
    root = mkDiv({
      position: "fixed", top: "0", left: "0", width: "0", height: "0",
      zIndex: Z, pointerEvents: "none", margin: "0", padding: "0", border: "0",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    });
    root.id = NS;
    root.setAttribute("aria-hidden", "true");
    host.appendChild(root);
    build();
    return root;
  }

  function build() {
    // --- Banner (T1): dark HUD bar top-centre ---
    const banner = mkDiv({
      position: "fixed", top: "10px", left: "50%", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "10px",
      background: "rgba(17,17,23,0.92)", color: "#e5e7eb",
      padding: "8px 14px", borderRadius: "10px", fontSize: "13px", lineHeight: "1.3",
      boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
      border: "1px solid " + OPTS.accent, maxWidth: "80vw",
      transition: "border-color 200ms ease, box-shadow 300ms ease",
    });
    const dot = mkDiv({
      width: "9px", height: "9px", borderRadius: "50%", background: OPTS.accent,
      flex: "0 0 auto", transition: "transform 300ms ease, background 200ms ease",
    });
    const title = mkDiv({ fontWeight: "600", whiteSpace: "nowrap" });
    title.textContent = "\u{1F916} Laya is controlling this browser";
    const stateLabel = mkDiv({ color: OPTS.accent, fontWeight: "600", whiteSpace: "nowrap" });
    stateLabel.textContent = "";
    const status = mkDiv({ color: "#cbd5e1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "40vw" });
    const progress = mkDiv({ color: "#94a3b8", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" });

    // progress bar under the banner text
    const barWrap = mkDiv({ position: "relative", width: "70px", height: "4px", background: "rgba(148,163,184,0.3)", borderRadius: "3px", overflow: "hidden", display: "none" });
    const barFill = mkDiv({ position: "absolute", left: "0", top: "0", bottom: "0", width: "0%", background: OPTS.accent, transition: "width 250ms ease" });
    barWrap.appendChild(barFill);

    banner.appendChild(dot);
    banner.appendChild(title);
    banner.appendChild(stateLabel);
    banner.appendChild(status);
    banner.appendChild(progress);
    banner.appendChild(barWrap);
    root.appendChild(banner);

    // --- Token / step-cost meter (T3.1): a compact pill in the banner showing cumulative
    // steps, LLM escalation count, and an estimated token spend for the run so the user sees
    // the running cost of the automation at a glance.
    const meter = mkDiv({
      display: "none", alignItems: "center", gap: "8px", color: "#94a3b8",
      fontSize: "11px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
      borderLeft: "1px solid rgba(148,163,184,0.3)", paddingLeft: "8px", marginLeft: "2px",
    });
    banner.appendChild(meter);

    // --- Esc-to-release hint (T4) ---
    const hint = mkDiv({
      position: "fixed", top: "48px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(17,17,23,0.75)", color: "#94a3b8", padding: "3px 8px",
      borderRadius: "6px", fontSize: "11px", whiteSpace: "nowrap",
    });
    hint.textContent = "controlled by Laya \u2014 press Esc to release";
    root.appendChild(hint);

    // --- Synthetic cursor (T1) ---
    const cursor = mkDiv({
      position: "fixed", left: "0", top: "0", width: "20px", height: "20px",
      transform: "translate(-4px,-2px)",
      transition: "left 450ms cubic-bezier(.22,.61,.36,1), top 450ms cubic-bezier(.22,.61,.36,1)",
      display: "none",
    });
    cursor.innerHTML = "<svg width='20' height='20' viewBox='0 0 24 24' fill='" + OPTS.accent + "' stroke='white' stroke-width='1'><path d='M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z'/></svg>";
    root.appendChild(cursor);

    // --- Caption/popover near the cursor (T2) ---
    const caption = mkDiv({
      position: "fixed", left: "0", top: "0", transform: "translate(16px, 8px)",
      background: OPTS.accent, color: "#0b1020", padding: "3px 8px", borderRadius: "6px",
      fontSize: "12px", fontWeight: "600", whiteSpace: "nowrap", display: "none",
      boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
    });
    root.appendChild(caption);

    // --- Spotlight (T1): a ring highlighting a target rect ---
    const spotlight = mkDiv({
      position: "fixed", left: "0", top: "0", width: "0", height: "0",
      border: "2px solid " + OPTS.accent, borderRadius: "6px",
      boxShadow: "0 0 0 3px rgba(168,85,247,0.25)",
      transition: "left 300ms ease, top 300ms ease, width 300ms ease, height 300ms ease, opacity 200ms ease",
      display: "none",
    });
    root.appendChild(spotlight);

    // --- Scroll indicator (T3) ---
    const scroll = mkDiv({
      position: "fixed", right: "12px", bottom: "56px",
      background: "rgba(17,17,23,0.9)", color: OPTS.accent, padding: "4px 8px",
      borderRadius: "6px", fontSize: "12px", fontWeight: "700", display: "none",
    });
    root.appendChild(scroll);

    // --- Toast stack (T3) ---
    const toasts = mkDiv({
      position: "fixed", right: "12px", top: "60px",
      display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end",
    });
    root.appendChild(toasts);

    // --- WAIT countdown ring (T3) ---
    const countdown = mkDiv({
      position: "fixed", right: "12px", bottom: "12px",
      background: "rgba(17,17,23,0.9)", color: "#e5e7eb", padding: "5px 9px",
      borderRadius: "18px", fontSize: "12px", fontWeight: "700", display: "none",
      border: "1px solid " + OPTS.accent, fontVariantNumeric: "tabular-nums",
    });
    root.appendChild(countdown);

    // --- Activity-log panel (T4) ---
    const logPanel = mkDiv({
      position: "fixed", left: "12px", bottom: "12px", width: "240px", maxHeight: "180px",
      background: "rgba(17,17,23,0.92)", color: "#cbd5e1", borderRadius: "8px",
      border: "1px solid rgba(148,163,184,0.25)", display: OPTS.activityLog ? "flex" : "none",
      flexDirection: "column", overflow: "hidden", fontSize: "11px",
    });
    const logHead = mkDiv({
      padding: "5px 8px", color: OPTS.accent, fontWeight: "700",
      borderBottom: "1px solid rgba(148,163,184,0.2)", display: "flex",
      justifyContent: "space-between", alignItems: "center",
    });
    logHead.textContent = "Activity";
    const logBody = mkDiv({ padding: "4px 8px", overflowY: "auto", maxHeight: "150px" });
    logPanel.appendChild(logHead);
    logPanel.appendChild(logBody);
    root.appendChild(logPanel);

    // --- Debug "what the agent sees" layer (T4) ---
    const seen = mkDiv({ position: "fixed", left: "0", top: "0", width: "0", height: "0", display: "none" });
    root.appendChild(seen);

    els = { banner, dot, title, stateLabel, status, progress, meter, barWrap, barFill,
      hint, cursor, caption, spotlight, scroll, toasts, countdown, logPanel, logBody, seen };
  }

  const api = {
    enabled: true,
    __lastCursor: null,
    setStatus(text) {
      if (!ensureRoot()) return;
      els.status.textContent = text == null ? "" : String(text);
    },
    setState(state) {
      if (!ensureRoot()) return;
      const map = {
        thinking: { label: "\u{1F914} Deciding\u2026", color: OPTS.accent },
        acting: { label: "\u26A1 Acting\u2026", color: OPTS.accent },
        success: { label: "\u2713 Done", color: "#22c55e" },
        error: { label: "\u2717 Error", color: "#ef4444" },
        uncertain: { label: "? Uncertain", color: OPTS.uncertainColor },
      };
      const s = map[state] || map.thinking;
      els.stateLabel.textContent = s.label;
      els.stateLabel.style.color = s.color;
      els.dot.style.background = s.color;
      els.banner.style.borderColor = s.color;
      heartbeat = state === "thinking";
      pulse();
    },
    progress(step, max) {
      if (!ensureRoot()) return;
      const n = Number(step) || 0, m = Number(max) || 0;
      if (m > 0) {
        els.progress.textContent = "step " + n + "/" + m;
        els.barWrap.style.display = "block";
        els.barFill.style.width = Math.max(0, Math.min(100, (n / m) * 100)) + "%";
      } else {
        els.progress.textContent = "";
        els.barWrap.style.display = "none";
      }
    },
    meter(steps, escalations, tokens) {
      if (!ensureRoot()) return;
      const s = Number(steps) || 0;
      const e = Number(escalations) || 0;
      const t = Number(tokens) || 0;
      // Compact human-friendly token count (e.g. 1.2k) so the pill stays narrow.
      const tok = t >= 1000 ? (t / 1000).toFixed(1) + "k" : String(t);
      els.meter.style.display = "flex";
      els.meter.setAttribute("data-laya-meter", "1");
      els.meter.textContent = "\u{1F9EE} " + s + " steps \u00B7 " + e + " LLM \u00B7 ~" + tok + " tok";
    },
    moveCursor(x, y, caption, trailLength) {
      if (!ensureRoot()) return;
      // (T3.4) Draw a fading breadcrumb trail from the previous cursor position to the new one
      // so multi-field actions (e.g. FILL_FORM moving between fields) read as continuous
      // motion rather than a teleport. Bounded by trailLength (default 6); each dot fades out
      // and self-removes, and the trail is pointer-events:none like everything in the HUD.
      const requested = trailLength == null ? OPTS.cursorTrail : trailLength;
      const n = Math.max(0, Math.min(24, Number(requested) || 0));
      const prev = api.__lastCursor;
      if (n > 0 && prev && (prev.x !== x || prev.y !== y)) {
        for (let i = 1; i <= n; i++) {
          const f = i / (n + 1);
          const tx = prev.x + (x - prev.x) * f;
          const ty = prev.y + (y - prev.y) * f;
          const dot = mkDiv({
            position: "fixed", left: tx + "px", top: ty + "px", width: "6px", height: "6px",
            marginLeft: "-3px", marginTop: "-3px", borderRadius: "50%",
            background: OPTS.accent, opacity: String(0.5 * (1 - f) + 0.1),
            transition: "opacity 500ms ease-out",
          });
          root.appendChild(dot);
          const node = dot;
          requestAnimationFrame(() => { node.style.opacity = "0"; });
          setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 560);
        }
      }
      api.__lastCursor = { x: x, y: y };
      els.cursor.style.display = "block";
      els.cursor.style.left = x + "px";
      els.cursor.style.top = y + "px";
      if (caption != null && caption !== "") {
        els.caption.style.display = "block";
        els.caption.style.left = x + "px";
        els.caption.style.top = y + "px";
        els.caption.textContent = String(caption);
      } else {
        els.caption.style.display = "none";
      }
    },
    ripple(x, y) {
      if (!ensureRoot()) return;
      const r = mkDiv({
        position: "fixed", left: x + "px", top: y + "px", width: "8px", height: "8px",
        marginLeft: "-4px", marginTop: "-4px", borderRadius: "50%",
        background: "rgba(168,85,247,0.5)", border: "2px solid " + OPTS.accent,
        transition: "transform 500ms ease-out, opacity 500ms ease-out", transform: "scale(1)", opacity: "1",
      });
      root.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(6)"; r.style.opacity = "0"; });
      setTimeout(() => { if (r.parentNode) r.parentNode.removeChild(r); }, 550);
    },
    spotlight(rect) {
      if (!ensureRoot() || !rect) return;
      els.spotlight.style.display = "block";
      els.spotlight.style.opacity = "1";
      els.spotlight.style.left = (rect.x - 4) + "px";
      els.spotlight.style.top = (rect.y - 4) + "px";
      els.spotlight.style.width = (rect.width + 8) + "px";
      els.spotlight.style.height = (rect.height + 8) + "px";
    },
    hideSpotlight() {
      if (!root) return;
      els.spotlight.style.opacity = "0";
      els.spotlight.style.display = "none";
    },
    toast(message, kind) {
      if (!ensureRoot()) return;
      const colors = { info: OPTS.accent, success: "#22c55e", error: "#ef4444", uncertain: OPTS.uncertainColor };
      const color = colors[kind] || OPTS.accent;
      const t = mkDiv({
        background: "rgba(17,17,23,0.94)", color: "#e5e7eb", padding: "6px 10px",
        borderRadius: "7px", fontSize: "12px", borderLeft: "3px solid " + color,
        boxShadow: "0 3px 12px rgba(0,0,0,0.4)", opacity: "0", transform: "translateX(12px)",
        transition: "opacity 200ms ease, transform 200ms ease", maxWidth: "260px",
      });
      t.textContent = String(message);
      els.toasts.appendChild(t);
      requestAnimationFrame(() => { t.style.opacity = "1"; t.style.transform = "translateX(0)"; });
      const timer = setTimeout(() => {
        t.style.opacity = "0"; t.style.transform = "translateX(12px)";
        setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
      }, 3200);
      toastTimers.push(timer);
    },
    log(line) {
      if (!OPTS.activityLog || !ensureRoot()) return;
      const entry = mkDiv({ padding: "1px 0", borderBottom: "1px solid rgba(148,163,184,0.08)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      const time = new Date().toLocaleTimeString();
      entry.textContent = time + "  " + String(line);
      els.logBody.appendChild(entry);
      els.logBody.scrollTop = els.logBody.scrollHeight;
      while (els.logBody.childNodes.length > 100) els.logBody.removeChild(els.logBody.firstChild);
    },
    countdown(ms) {
      if (!OPTS.waitCountdown || !ensureRoot()) return;
      const total = Number(ms) || 0;
      if (total <= 0) { els.countdown.style.display = "none"; return; }
      els.countdown.style.display = "block";
      const start = Date.now();
      if (countdownRaf) cancelAnimationFrame(countdownRaf);
      const tick = () => {
        const left = Math.max(0, total - (Date.now() - start));
        els.countdown.textContent = "\u23F3 " + (left / 1000).toFixed(1) + "s";
        if (left > 0) { countdownRaf = requestAnimationFrame(tick); }
        else { els.countdown.style.display = "none"; countdownRaf = 0; }
      };
      tick();
    },
    scrollIndicator(direction, pos) {
      if (!ensureRoot()) return;
      const arrows = { up: "\u2191", down: "\u2193", left: "\u2190", right: "\u2192" };
      els.scroll.style.display = "block";
      els.scroll.textContent = (arrows[direction] || "\u2193") + " " + (pos == null ? "" : String(pos));
      clearTimeout(els.scroll.__t);
      els.scroll.__t = setTimeout(() => { els.scroll.style.display = "none"; }, 1200);
    },
    showSeenElements() {
      if (!OPTS.debugSeeElements || !ensureRoot()) return;
      this.hideSeenElements();
      const marked = document.querySelectorAll("[data-laya-ref]");
      for (const el of Array.from(marked)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const box = mkDiv({
          position: "fixed", left: rect.left + "px", top: rect.top + "px",
          width: rect.width + "px", height: rect.height + "px",
          border: "1px dashed " + OPTS.accent, boxSizing: "border-box",
        });
        const tag = mkDiv({
          position: "fixed", left: rect.left + "px", top: Math.max(0, rect.top - 12) + "px",
          background: OPTS.accent, color: "#0b1020", fontSize: "9px", padding: "0 3px",
          borderRadius: "3px", fontWeight: "700",
        });
        tag.textContent = "[ref=" + el.getAttribute("data-laya-ref") + "]";
        els.seen.appendChild(box);
        els.seen.appendChild(tag);
      }
      els.seen.style.display = "block";
    },
    hideSeenElements() {
      if (!els.seen) return;
      els.seen.textContent = "";
      els.seen.style.display = "none";
    },
    refRect(ref) {
      const el = document.querySelector('[data-laya-ref="' + ref + '"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
  };

  function pulse() {
    // Idle heartbeat / breathing pulse on the dot while "thinking".
    if (!els.dot) return;
    if (!heartbeat) { els.dot.style.transform = "scale(1)"; return; }
    const grow = els.dot.style.transform === "scale(1.6)";
    els.dot.style.transform = grow ? "scale(1)" : "scale(1.6)";
    setTimeout(() => { if (heartbeat) pulse(); }, 650);
  }

  window.__layaOverlay = api;
  // Body may not exist yet when an init script runs; retry on DOMContentLoaded.
  if (!ensureRoot()) {
    document.addEventListener("DOMContentLoaded", ensureRoot, { once: true });
  }
})();`;
}

/**
 * The typed, server-side overlay controller owned by {@link BrowserSession}. Each method
 * drives `window.__layaOverlay` on the active page via `page.evaluate` and swallows any
 * error (missing overlay mid-navigation, page closing, evaluate rejection) so narration is
 * always best-effort and NEVER changes automation semantics.
 */
export class BrowserOverlay {
  private enabled: boolean;
  private readonly clientScript: string;

  constructor(private readonly config: OverlayConfig) {
    this.enabled = config.enabled;
    const opts: OverlayClientOptions = {
      accent: config.accent,
      uncertainColor: OVERLAY_UNCERTAIN_COLOR,
      typingEffect: config.typingEffect,
      waitCountdown: config.waitCountdown,
      debugSeeElements: config.debugSeeElements,
      activityLog: config.activityLog,
      cursorTrail: config.cursorTrail,
    };
    this.clientScript = buildClientScript(JSON.stringify(opts));
  }

  /** Whether the overlay is active. When false every server method is a no-op. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Turn the overlay on/off at runtime (used by the `auto`-vs-effective-headless decision). */
  enable(on: boolean): void {
    this.enabled = on;
  }

  /** Whether the per-character typing effect should be used by callers (loop). */
  get typingEffect(): boolean {
    return this.config.typingEffect;
  }

  /**
   * Register the injected script on the context so EVERY future page/navigation/new tab
   * re-injects the overlay, then inject into any already-open page (addInitScript only
   * affects future loads). No-op when disabled. Best-effort throughout.
   */
  async install(context: BrowserContext, openPages: Page[] = []): Promise<void> {
    if (!this.enabled) return;
    try {
      await context.addInitScript(this.clientScript);
    } catch {
      // Context may be closing; nothing else to do.
    }
    for (const page of openPages) {
      try {
        await page.evaluate(this.clientScript);
      } catch {
        // Page may be mid-navigation or closed; the init script will cover future loads.
      }
    }
  }

  /** Run a snippet against `window.__layaOverlay` on `page`, swallowing every error. */
  private async call(
    page: Page | undefined,
    fn: string,
    ...args: unknown[]
  ): Promise<void> {
    if (!this.enabled || !page) return;
    try {
      await page.evaluate(
        ([method, callArgs]) => {
          const o = (window as unknown as { __layaOverlay?: Record<string, (...a: unknown[]) => unknown> })
            .__layaOverlay;
          if (!o || typeof o[method] !== "function") return;
          try {
            o[method](...(callArgs as unknown[]));
          } catch {
            // Never let an overlay error bubble out of the page.
          }
        },
        [fn, args] as const,
      );
    } catch {
      // evaluate itself can reject if the page navigated/closed mid-call; ignore.
    }
  }

  /** Set the banner status line. */
  async setStatus(page: Page | undefined, text: string): Promise<void> {
    await this.call(page, "setStatus", text);
  }

  /** Swap the HUD state (thinking/acting/success/error/uncertain). */
  async setState(page: Page | undefined, state: OverlayState): Promise<void> {
    await this.call(page, "setState", state);
  }

  /** Render `step N/max` and the progress bar. */
  async progress(page: Page | undefined, step: number, max: number): Promise<void> {
    await this.call(page, "progress", step, max);
  }

  /**
   * Move the synthetic cursor to a viewport coordinate, optionally with a caption and a
   * breadcrumb-trail length (T3.4). Omitting `trailLength` uses the configured default; pass
   * `0` to suppress the trail for a single move.
   */
  async moveCursor(
    page: Page | undefined,
    x: number,
    y: number,
    caption?: string,
    trailLength?: number,
  ): Promise<void> {
    await this.call(page, "moveCursor", x, y, caption ?? "", trailLength ?? null);
  }

  /**
   * (T3.1) Update the token/step-cost meter pill: cumulative step count, LLM escalation
   * count, and an estimated token spend for the run. A guarded no-op like every overlay call.
   */
  async meter(
    page: Page | undefined,
    steps: number,
    escalations: number,
    tokens: number,
  ): Promise<void> {
    await this.call(page, "meter", steps, escalations, tokens);
  }

  /** Play a click-ripple at a viewport coordinate. */
  async ripple(page: Page | undefined, x: number, y: number): Promise<void> {
    await this.call(page, "ripple", x, y);
  }

  /**
   * Spotlight a target: either an explicit rect or a ref (`eN`) resolved in-page via the
   * `data-laya-ref` selector. Returns nothing; missing targets are silently ignored.
   */
  async spotlight(
    page: Page | undefined,
    target: string | OverlayRect,
  ): Promise<void> {
    if (!this.enabled || !page) return;
    if (typeof target === "string") {
      const rect = await this.refRect(page, target);
      if (rect) await this.call(page, "spotlight", rect);
      return;
    }
    await this.call(page, "spotlight", target);
  }

  /** Hide the spotlight ring. */
  async hideSpotlight(page: Page | undefined): Promise<void> {
    await this.call(page, "hideSpotlight");
  }

  /** Show an auto-dismissing toast. */
  async toast(
    page: Page | undefined,
    message: string,
    kind: ToastKind = "info",
  ): Promise<void> {
    await this.call(page, "toast", message, kind);
  }

  /** Append a line to the activity-log panel (gated in-page by activityLog). */
  async log(page: Page | undefined, line: string): Promise<void> {
    await this.call(page, "log", line);
  }

  /** Show the WAIT countdown (gated in-page by waitCountdown). */
  async countdown(page: Page | undefined, ms: number): Promise<void> {
    await this.call(page, "countdown", ms);
  }

  /** Show the scroll direction/position indicator. */
  async scrollIndicator(
    page: Page | undefined,
    direction: ScrollDirection,
    pos?: number | string,
  ): Promise<void> {
    await this.call(page, "scrollIndicator", direction, pos ?? "");
  }

  /** Outline every `[data-laya-ref]` element with its `[ref=eN]` label (debug). */
  async showSeenElements(page: Page | undefined): Promise<void> {
    await this.call(page, "showSeenElements");
  }

  /** Remove the debug see-elements outlines. */
  async hideSeenElements(page: Page | undefined): Promise<void> {
    await this.call(page, "hideSeenElements");
  }

  /**
   * Resolve a ref (`eN`) to its viewport-relative bounding rect via the in-page
   * `data-laya-ref` selector, so a caller can spotlight/move-cursor to it. Returns null when
   * the ref matches nothing (or on any error).
   */
  async refRect(page: Page | undefined, ref: string): Promise<OverlayRect | null> {
    if (!page) return null;
    try {
      const rect = await page.evaluate((r) => {
        const el = document.querySelector('[data-laya-ref="' + r + '"]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left, y: b.top, width: b.width, height: b.height };
      }, ref);
      return rect;
    } catch {
      return null;
    }
  }
}
