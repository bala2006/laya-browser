/**
 * The agentLens overlay: an on-page HUD that shows what Laya is doing, re-injected on every
 * document via `context.addInitScript` so it survives navigations and new tabs.
 *
 *   - src/overlay-design.ts  the design system (tokens, activities, icons, the one stylesheet)
 *   - src/overlay-client.ts  the in-page renderer (serialised into the page; closes over nothing)
 *   - this file              {@link BrowserOverlay}, the server-side controller
 *
 * What the user sees: a frosted-glass status pill (activity icon + verb + live narration +
 * progress ring + cost meter + drag grip), a glass cursor that glides along a slight arc with a
 * chip naming the action, a dashed selection box with corner handles on the target, a click
 * ripple, a blinking caret while typing, a scroll track, toasts, an activity log, the page-edge
 * aura, and a "Laya is in control - Esc to take over" chip during a run.
 *
 * Every server method is best-effort and NEVER throws into the caller: without the in-page API
 * (mid-navigation, closed page) a call is a silent no-op, so narration can never change
 * automation semantics.
 */
import type { BrowserContext, Page } from "playwright";
import type { OverlayConfig } from "./config.js";
import {
  ACTIVITIES,
  ACTIVITY_VERBS,
  ICONS,
  TOAST_ACTIVITY,
  TOKENS,
  buildOverlayCss,
} from "./overlay-design.js";
import { overlayClient, type OverlayClientConfig } from "./overlay-client.js";

/** A visual "mood" the HUD reflects; together with the status text it picks the activity. */
export type OverlayState = "thinking" | "acting" | "success" | "error" | "uncertain";

/** A toast severity; controls the toast's icon and tone. */
export type ToastKind = "info" | "success" | "error" | "uncertain";

/** A scroll direction shown by the scroll indicator. */
export type ScrollDirection = "up" | "down" | "left" | "right";

/** A rectangle in CSS pixels relative to the viewport (spotlight target). */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** From {@link BrowserOverlay.focus}: how long the cursor needs to glide there (ms). */
  arriveMs?: number;
}

/** The uncertainty accent (amber), shared client/server. */
export const OVERLAY_UNCERTAIN_COLOR = "#f59e0b";

/** The injected init script: the client function applied to its (JSON) configuration. */
function buildClientScript(config: OverlayConfig): string {
  const cfg: OverlayClientConfig = {
    css: buildOverlayCss(config.accent),
    activities: ACTIVITIES,
    verbs: ACTIVITY_VERBS,
    icons: ICONS,
    toastActivity: TOAST_ACTIVITY,
    motion: { cursor: TOKENS.motion.cursor, narration: TOKENS.motion.narration },
    options: {
      typingEffect: config.typingEffect,
      waitCountdown: config.waitCountdown,
      debugSeeElements: config.debugSeeElements,
      activityLog: config.activityLog,
      cursorTrail: config.cursorTrail,
    },
  };
  return `(${overlayClient.toString()})(${JSON.stringify(cfg)});`;
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
  /**
   * The spot the user dragged the bar to on the page (viewport coordinates), remembered
   * server-side so it survives a navigation: every overlay call reports the pinned position back,
   * and {@link install} re-applies it to freshly loaded documents. Null means "default corner".
   */
  private pinnedPos: { x: number; y: number } | null = null;

  constructor(private readonly config: OverlayConfig) {
    this.enabled = config.enabled;
    this.clientScript = buildClientScript(config);
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
    try {
      // The context-wide binding the in-page drag handle reports to: it makes a drag stick the
      // instant it happens (before the user navigates away), and it covers every page and every
      // future document of the context. A name collision is not fatal - the pull path in call()
      // still tracks the position.
      await context.exposeFunction("__layaReportPos", (pos: { x?: unknown; y?: unknown } | null) => {
        const x = Number(pos?.x);
        const y = Number(pos?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) this.pinnedPos = { x, y };
      });
    } catch {
      // Already exposed (install called twice) or the context is closing; ignore.
    }
    for (const page of openPages) {
      try {
        await page.evaluate(this.clientScript);
      } catch {
        // Page may be mid-navigation or closed; the init script will cover future loads.
      }
      await this.restorePosition(page);
    }
  }

  /**
   * Re-apply the user's dragged position to a page (no-op until they have moved the bar), so a
   * navigation or a new tab does not snap the HUD back to its default corner.
   */
  private async restorePosition(page: Page | undefined): Promise<void> {
    const pos = this.pinnedPos;
    if (!pos) return;
    await this.call(page, "setPosition", pos.x, pos.y);
  }

  /** Run a snippet against `window.__layaOverlay` on `page`, swallowing every error. */
  private async call(
    page: Page | undefined,
    fn: string,
    ...args: unknown[]
  ): Promise<void> {
    await this.invoke(page, [[fn, ...args]]);
  }

  /**
   * (Perf) Apply SEVERAL HUD updates in a single round-trip.
   *
   * Narration used to cost one `page.evaluate` per call — about 13 per step, and each
   * round-trip carries ~1.4ms of pure overhead before any in-page work happens. Batching the
   * calls a step emits back-to-back collapses them into one round-trip without changing what
   * the HUD ends up displaying, because the in-page `batch` applies the ops in order and guards
   * each one. Guarded best-effort no-op with no page; never throws.
   */
  async callBatch(page: Page | undefined, ops: Array<[string, ...unknown[]]>): Promise<void> {
    if (ops.length === 0) return;
    await this.invoke(page, ops as Array<Array<unknown>>);
  }

  /**
   * (Perf) Resolve a ref and aim the cursor + spotlight at it in ONE round-trip. Returns the
   * element's viewport rect, or null when the ref is gone — the same contract as
   * {@link refRect}. Guarded no-op returning null without a page.
   */
  async focus(
    page: Page | undefined,
    ref: string,
    caption?: string,
  ): Promise<OverlayRect | null> {
    if (!this.enabled || !page) return null;
    try {
      const pinned = this.pinnedPos;
      const out = await page.evaluate(
        ([targetRef, text, spot]) => {
          const o = (window as unknown as {
            __layaOverlay?: Record<string, unknown> & {
              __pos?: { x: number; y: number } | null;
              __pinned?: { x: number; y: number } | null;
              __fresh?: boolean;
              setPosition?: (x: number, y: number) => void;
              focus?: (ref: string, caption?: string) => unknown;
            };
          }).__layaOverlay;
          if (!o) return { pos: null, rect: null };
          o.__pinned = spot ?? null;
          if (o.__fresh) {
            o.__fresh = false;
            if (o.__pinned && o.setPosition) o.setPosition(o.__pinned.x, o.__pinned.y);
          }
          let rect: unknown = null;
          try {
            if (typeof o.focus === "function") {
              rect = o.focus(targetRef, text ?? undefined) ?? null;
            }
          } catch {
            // Never let an overlay error bubble out of the page.
          }
          return { pos: o.__pos ?? null, rect };
        },
        [ref, caption ?? null, pinned] as const,
      );
      if (out?.pos && typeof out.pos.x === "number" && typeof out.pos.y === "number") {
        this.pinnedPos = { x: out.pos.x, y: out.pos.y };
      }
      return (out?.rect as OverlayRect | null | undefined) ?? null;
    } catch {
      // A navigation/close mid-call leaves no rect; report nothing.
      return null;
    }
  }

  /**
   * The single evaluate every narration call funnels through. It does double duty on each trip:
   * it hands the server's pinned position to the page (so a freshly loaded document restores
   * where the user dragged the bar instead of snapping back to its default corner), and it
   * reports the page's current position back, so a drag the user just performed is remembered
   * for the rest of the session.
   */
  private async invoke(page: Page | undefined, ops: Array<Array<unknown>>): Promise<void> {
    if (!this.enabled || !page) return;
    try {
      const pinned = this.pinnedPos;
      const pos = await page.evaluate(
        ([batch, spot]) => {
          const o = (window as unknown as {
            __layaOverlay?: Record<string, unknown> & {
              __pos?: { x: number; y: number } | null;
              __pinned?: { x: number; y: number } | null;
              __fresh?: boolean;
              setPosition?: (x: number, y: number) => void;
              batch?: (ops: unknown[]) => void;
            };
          }).__layaOverlay;
          if (!o) return null;
          o.__pinned = spot ?? null;
          if (o.__fresh) {
            o.__fresh = false;
            if (o.__pinned && o.setPosition) o.setPosition(o.__pinned.x, o.__pinned.y);
          }
          if (typeof o.batch === "function") {
            o.batch(batch);
          } else {
            // Tolerate a page still carrying an older injected script (mid-session upgrade):
            // apply the same ops directly, so the HUD ends up in exactly the same state.
            for (const op of batch) {
              const name = op[0];
              if (typeof name !== "string") continue;
              const fn = o[name];
              if (typeof fn !== "function") continue;
              try {
                (fn as (...a: unknown[]) => unknown)(...(op.slice(1) as unknown[]));
              } catch {
                // Never let an overlay error bubble out of the page.
              }
            }
          }
          return o.__pos ?? null;
        },
        [ops, pinned] as const,
      );
      if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
        this.pinnedPos = { x: pos.x, y: pos.y };
      }
    } catch {
      // evaluate itself can reject if the page navigated/closed mid-call; ignore.
    }
  }

  /**
   * A run starts: show the "Laya is in control - Esc to take over" chip, arm the takeover key,
   * reset the activity log, and bring the cursor on screen.
   */
  async beginRun(page: Page | undefined): Promise<void> {
    await this.callBatch(page, [["beginRun"], ["showCursor", null, null], ["sessionFrame", true]]);
  }

  /** A run ended: hide the takeover chip and the transient cursor affordances. */
  async endRun(page: Page | undefined): Promise<void> {
    await this.call(page, "endRun");
  }

  /** Laya is about to press keys itself, so an Escape in the next `ms` is not a takeover. */
  async expectKeys(page: Page | undefined, ms: number): Promise<void> {
    await this.call(page, "expectKeys", ms);
  }

  /**
   * Whether the user pressed Esc to take over since the run began. False when the overlay is
   * off or unreachable (no signal is not a takeover).
   */
  async takeoverRequested(page: Page | undefined): Promise<boolean> {
    if (!this.enabled || !page) return false;
    try {
      return await page.evaluate(
        () => (window as unknown as { __layaOverlay?: { __released?: boolean } }).__layaOverlay?.__released === true,
      );
    } catch {
      return false;
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
   * Make the synthetic cursor visible (default: viewport centre) so it is present from the
   * start of a run rather than only appearing on the first {@link moveCursor}. A guarded
   * best-effort no-op like every overlay call.
   */
  async showCursor(page: Page | undefined, x?: number, y?: number): Promise<void> {
    await this.call(page, "showCursor", x ?? null, y ?? null);
  }

  /**
   * Toggle the subtle page-edge "Laya is in control" presence treatment on/off (a faint blue
   * inset glow with a gradient on all four sides, not a dominating bracket frame). Shown for the
   * duration of an autopilot run. A guarded best-effort no-op like every overlay call.
   */
  async sessionFrame(page: Page | undefined, on: boolean): Promise<void> {
    await this.call(page, "sessionFrame", on);
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
