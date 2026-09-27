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

  // --- Design tokens -------------------------------------------------------
  // The pill is a FROSTED GLASS surface with thin line-art iconography and a light weight/high
  // x-height sans. Its ink is picked from the luminance of what is actually BEHIND it, so the
  // same pill reads as the reference does over a dark/coloured backdrop (thin translucent white
  // glass, white ink, hairline white ring) and stays legible over a light page (near-opaque
  // white glass, dark ink). One fixed ink cannot do both: white-on-white measured 1.0:1 - the
  // invisible-pill bug - and dark ink over a dark backdrop is just as unreadable.
  const FONT =
    "'Inter', 'Inter var', ui-sans-serif, system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const LIGHT = {
    glass: "rgba(255,255,255,0.9)",
    ink: "#0f172a",
    inkSoft: "rgba(15,23,42,0.78)",
    inkFaint: "rgba(15,23,42,0.62)",
    hairline: "rgba(15,23,42,0.14)",
    ring: "rgba(255,255,255,0.78)",
    glow: "rgba(15,23,42,0.2)",
  };
  const DARK = {
    glass: "rgba(15,23,42,0.55)",
    ink: "#ffffff",
    inkSoft: "rgba(255,255,255,0.88)",
    inkFaint: "rgba(255,255,255,0.72)",
    hairline: "rgba(255,255,255,0.28)",
    ring: "rgba(255,255,255,0.38)",
    glow: "rgba(2,6,23,0.55)",
  };
  const CHIP_BG = "rgba(15,23,42,0.92)";
  const CHIP_INK = "#f8fafc";
  const STACK_GAP = 8;

  // Live theme + state colours (set by applyTheme() / setState()).
  let theme = LIGHT;
  let stateColor = null; // the bright state colour (icon tint, progress fill, border glow)
  let stateInk = null; // the DARK ink variant of that colour, for the label on a light pill
  let stateGlyph = "cursor";
  let lastStatus = "";

  // Root is created lazily once <body> exists (init scripts can run before body parse).
  let root = null;
  let els = {};
  let toastTimers = [];
  let countdownRaf = 0;
  let heartbeat = false;

  function css(node, styles) { for (const k in styles) node.style[k] = styles[k]; }

  // Parse a #rgb / #rrggbb hex into [r,g,b], falling back to the default blue for a malformed
  // value. Shared by accentRgba(), inkFor(), rgbaOf() and the backdrop probe.
  function parseHex(input) {
    const hex = String(input || "").replace("#", "");
    let r = 59, g = 130, b = 246;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
    if (isNaN(r) || isNaN(g) || isNaN(b)) { r = 59; g = 130; b = 246; }
    return [r, g, b];
  }

  function parseAccent() { return parseHex(OPTS.accent); }

  // Turn the brand accent into an "rgba(r,g,b,a)" string so accent-tinted glows/fills track
  // the configured accent instead of hardcoding a colour.
  function accentRgba(alpha) {
    const c = parseAccent();
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")";
  }

  // A translucent version of any brand/state hex, used for the glass icon badge and the pointer
  // fill so the page shows through (the reference's coloured-glass look).
  function rgbaOf(hex, alpha) {
    const c = parseHex(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")";
  }

  // Darken an accent into an "ink" that stays legible as TEXT on the light glass pill (the bright
  // accent itself fails contrast on a frosted-white surface).
  function inkFor(factor) {
    const c = parseAccent();
    const f = factor == null ? 0.55 : factor;
    return "rgb(" + Math.round(c[0] * f) + "," + Math.round(c[1] * f) + "," + Math.round(c[2] * f) + ")";
  }

  // WCAG relative luminance (0 = black, 1 = white) of an [r,g,b] triple.
  function luminanceOf(rgb) {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  // Line-art state glyphs (thin strokes, no fill) - the reference's icon language. Stroking in
  // currentColor lets the badge ink follow whichever theme is active.
  function glyph(name) {
    const open = "<svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor'" +
      " stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>";
    const paths = {
      cursor: "<path d='M5 3 L5 18.6 L9.4 14.6 L12.3 20.7 L15.1 19.4 L12.3 13.4 L17.9 12.9 Z'/>",
      terminal: "<path d='M7 8.4 L10.7 12 L7 15.6'/><path d='M12.9 15.8 H17.2'/>",
      search: "<circle cx='10.5' cy='10.5' r='5.5'/><path d='M14.6 14.6 L19.6 19.6'/>",
      check: "<path d='M4.8 12.7 L9.5 17.4 L19.2 7.7'/>",
      cross: "<path d='M6.4 6.4 L17.6 17.6'/><path d='M17.6 6.4 L6.4 17.6'/>",
      question: "<path d='M8.7 9.3a3.3 3.3 0 1 1 4.8 2.8c-.9.5-1.5 1.1-1.5 2.1'/><circle cx='12' cy='17.7' r='1' fill='currentColor' stroke='none'/>",
      spark: "<path d='M12 3.5 L13.9 9.4 L19.8 11.3 L13.9 13.2 L12 19.1 L10.1 13.2 L4.2 11.3 L10.1 9.4 Z'/>",
    };
    return open + (paths[name] || paths.cursor) + "</svg>";
  }

  // What is actually painted behind the pill right now, as an [r,g,b] triple, by compositing the
  // computed backgrounds from the element under its centre up to the root over the blank (white)
  // canvas. Returns null when the backdrop cannot be judged - a photo/video/canvas/gradient sits
  // under it - in which case the caller keeps the safe light-page treatment.
  // Pull the solid colours out of a CSS value so a GRADIENT backdrop can still be judged (the
  // reference's glass-over-colour look). Deliberately returns nothing for a photo (url(...)),
  // where no colour can be read and the caller keeps the safe light default. Parsed by hand and
  // with paren-free patterns for the same template-literal reason as the colour parse above.
  function colorsFromCss(value) {
    const out = [];
    const text = String(value || "");
    if (text.indexOf("url(") >= 0) return out;
    const hexes = text.match(/#[0-9a-f]{3}(?:[0-9a-f]{3})?/gi) || [];
    for (const h of hexes) {
      const c = parseHex(h);
      out.push([c[0], c[1], c[2]]);
    }
    let idx = text.indexOf("rgb");
    while (idx >= 0) {
      const open = text.indexOf("(", idx);
      const close = open < 0 ? -1 : text.indexOf(")", open);
      if (open < 0 || close < 0) break;
      const p = text.slice(open + 1, close).split(",");
      if (p.length >= 3) out.push([Number(p[0]), Number(p[1]), Number(p[2])]);
      idx = text.indexOf("rgb", close);
    }
    return out;
  }

  function backdropColor() {
    if (!els.banner || typeof document.elementFromPoint !== "function") return null;
    const box = els.banner.getBoundingClientRect();
    const x = Math.min(Math.max(box.left + 14, 1), Math.max(1, window.innerWidth - 1));
    const y = Math.min(Math.max(box.top + box.height / 2, 1), Math.max(1, window.innerHeight - 1));
    let node = document.elementFromPoint(x, y);
    if (!node) return null;
    const tag = (node.tagName || "").toUpperCase();
    if (tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" || tag === "IFRAME") return null;
    const layers = [];
    while (node) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        // A gradient: average its colours, and stop here - the gradient is what is painted.
        const cols = colorsFromCss(cs.backgroundImage);
        if (!cols.length) return null; // a photo/video: unjudgeable, keep the safe default
        let r = 0, g = 0, b = 0;
        for (const c of cols) { r += c[0]; g += c[1]; b += c[2]; }
        layers.push([r / cols.length, g / cols.length, b / cols.length, 1]);
        break;
      }
      // Parsed by hand rather than with a regex: this whole script is embedded in a template
      // literal, which would swallow the backslashes of an escaped-paren pattern.
      const raw = cs.backgroundColor;
      const open = raw.indexOf("(");
      const close = raw.lastIndexOf(")");
      if (open >= 0 && close > open) {
        const p = raw.slice(open + 1, close).split(","); // Number() tolerates the spaces
        const a = p.length > 3 ? Number(p[3]) : 1;
        if (a > 0) layers.push([Number(p[0]), Number(p[1]), Number(p[2]), a]);
      }
      if (!node.parentElement) break;
      node = node.parentElement;
    }
    let acc = [255, 255, 255, 1]; // the blank canvas behind the document
    for (let i = layers.length - 1; i >= 0; i--) {
      const fg = layers[i];
      const alpha = fg[3] + acc[3] * (1 - fg[3]);
      if (alpha === 0) continue;
      acc = [
        (fg[0] * fg[3] + acc[0] * acc[3] * (1 - fg[3])) / alpha,
        (fg[1] * fg[3] + acc[1] * acc[3] * (1 - fg[3])) / alpha,
        (fg[2] * fg[3] + acc[2] * acc[3] * (1 - fg[3])) / alpha,
        alpha,
      ];
      if (alpha >= 0.999) break;
    }
    return acc.slice(0, 3);
  }

  // Pick the theme from the backdrop and paint every pill node from it, so the glass/ink pairing
  // is always the legible one. Idempotent and cheap; called after anything that can change what
  // is behind the pill.
  function applyTheme() {
    if (!els.banner) return;
    const backdrop = backdropColor();
    theme = backdrop && luminanceOf(backdrop) < 0.42 ? DARK : LIGHT;
    const accent = stateColor || OPTS.accent;
    // Expose the resolved pairing on the pill (observable, so tests can pin the choice and a
    // user debugging a page can read it from the DOM).
    els.banner.setAttribute("data-laya-theme", theme === DARK ? "dark" : "light");
    els.banner.setAttribute(
      "data-laya-backdrop",
      backdrop ? backdrop.map((v) => Math.round(v)).join(",") : "unknown",
    );
    els.banner.style.background = theme.glass;
    els.banner.style.color = theme.ink;
    els.banner.style.borderColor = theme.ring;
    // A soft neutral drop shadow + a restrained accent halo, plus the hairline inner ring that
    // reads the glass edge (the reference's lit rim).
    els.banner.style.boxShadow =
      "0 12px 32px " + theme.glow + ", 0 0 22px " + rgbaOf(accent, theme === LIGHT ? 0.3 : 0.42) +
      ", 0 2px 10px rgba(2,6,23,0.22), 0 0 0 1px " + theme.ring + " inset";
    els.title.style.color = theme.ink;
    els.stateLabel.style.color = theme === LIGHT && stateInk ? stateInk : theme.ink;
    els.status.style.color = theme.inkSoft;
    els.progress.style.color = theme.inkFaint;
    els.meter.style.color = theme.inkFaint;
    els.meter.style.borderLeftColor = theme.hairline;
    els.barWrap.style.background = theme.hairline;
    els.barFill.style.background = accent;
    // The icon badge is a circle of tinted glass with a hairline ring, and its line-art glyph is
    // stroked in the theme ink (currentColor).
    els.dot.style.background = rgbaOf(accent, theme === LIGHT ? 0.2 : 0.32);
    els.dot.style.borderColor = theme.ring;
    els.dot.style.color = theme.ink;
  }

  // The pill's glyph reflects what it is doing: a magnifier while reading the page, otherwise the
  // mark of the current state (the local decision step shows a terminal, as in the reference).
  function refreshGlyph() {
    if (!els.dot) return;
    const reading = /read|review|extract|scan|look/i.test(lastStatus);
    els.dot.innerHTML = glyph(reading && !stateColor ? "search" : stateGlyph);
  }

  // The one stylesheet the HUD injects: namespaced keyframes (declarative CSS animations cannot be
  // set through inline styles) plus a reduced-motion opt-out. Every selector is scoped under the
  // overlay root id, so nothing of ours can restyle the page.
  function ensureStyle() {
    const id = NS + "_style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent =
      // Only the opacity breathes. Nothing may animate background-position: the four edge bands
      // have to stay pinned to their own edges, and moving them is what produced the hard seams.
      "@keyframes laya-aura-breathe { 0% { opacity: .72 } 50% { opacity: 1 } 100% { opacity: .72 } }" +
      "#" + NS + " .laya-aura { animation: laya-aura-breathe 4.2s ease-in-out infinite; }" +
      "@media (prefers-reduced-motion: reduce) {" +
      " #" + NS + " .laya-aura { animation: none; opacity: 1 } }";
    (document.head || document.documentElement).appendChild(style);
  }

  function mkDiv(styles) {
    const d = document.createElement("div");
    css(d, Object.assign({ pointerEvents: "none" }, styles || {}));
    return d;
  }

  function ensureRoot() {
    if (root && document.documentElement.contains(root)) return root;
    const host = document.body || document.documentElement;
    if (!host) return null;
    ensureStyle();
    root = document.getElementById(NS);
    if (root && document.documentElement.contains(root)) return root;
    root = mkDiv({
      position: "fixed", top: "0", left: "0", width: "0", height: "0",
      zIndex: Z, pointerEvents: "none", margin: "0", padding: "0", border: "0",
      fontFamily: FONT,
    });
    root.id = NS;
    root.setAttribute("aria-hidden", "true");
    host.appendChild(root);
    build();
    return root;
  }

  function build() {
    // --- Feedback pill (T1 / issue 3): a LIGHT, glassy, frosted rounded PILL anchored in the
    // LOWER-RIGHT of the viewport with a soft accent glow/halo. It reads as part of the page
    // rather than a heavy dark HUD bar.
    //
    // READABILITY IS THE POINT: the surface is a near-opaque frosted WHITE, so every line inside
    // it uses DARK ink. (A translucent light pill carrying white text was invisible on a white
    // page - a measured 1.0:1 contrast.) boxSizing:border-box keeps the padding inside the
    // max-width so the pill can no longer render wider than the width it claims, and flexWrap
    // lets a long status/step line wrap instead of being clipped away.
    //
    // Layout (child order is load-bearing for the tests):
    //   0 icon   1 title   2 stateLabel   3 status   4 progress   5 barWrap   6 meter
    const banner = mkDiv({
      position: "fixed", bottom: "36px", right: "32px",
      display: "flex", alignItems: "center", flexWrap: "wrap",
      columnGap: "9px", rowGap: "5px", boxSizing: "border-box",
      background: LIGHT.glass,
      backdropFilter: "blur(18px) saturate(180%)", webkitBackdropFilter: "blur(18px) saturate(180%)",
      color: LIGHT.ink,
      fontFamily: FONT, fontSize: "13px", fontWeight: "500", lineHeight: "1.35",
      letterSpacing: "0.005em", fontVariantNumeric: "tabular-nums",
      padding: "7px 10px 7px 8px", borderRadius: "999px",
      border: "1px solid " + LIGHT.ring,
      boxShadow: "0 12px 32px " + LIGHT.glow + ", 0 2px 10px rgba(2,6,23,0.22), 0 0 0 1px " + LIGHT.ring + " inset",
      // Keep clear of the bottom-left activity-log panel at any viewport width.
      maxWidth: "min(420px, max(260px, calc(100vw - 292px)))",
      transition: "background 250ms ease, border-color 250ms ease, box-shadow 250ms ease",
    });
    // Left icon: a CIRCULAR badge of tinted glass holding a thin line-art mark (the reference's
    // icon language). It is a shape rather than text, so it keeps a tinted fill on either theme;
    // its ring and glyph ink follow the active theme. The node is still the pill's leading marker
    // (the setState pulse and the tests reference it as the first banner child).
    const dot = mkDiv({
      width: "26px", height: "26px", borderRadius: "50%", boxSizing: "border-box",
      background: rgbaOf(OPTS.accent, 0.2),
      border: "1px solid " + LIGHT.ring,
      color: LIGHT.ink,
      flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center",
      transition: "transform 300ms ease, background 250ms ease, border-color 250ms ease, color 250ms ease",
    });
    dot.innerHTML = glyph("cursor");
    const title = mkDiv({ color: LIGHT.ink, fontWeight: "600", whiteSpace: "nowrap" });
    title.textContent = "Laya is working\u2026";
    const stateLabel = mkDiv({ color: LIGHT.ink, fontWeight: "600", whiteSpace: "nowrap" });
    stateLabel.textContent = "";
    // The status is the one variable-length line: it may shrink (and only then ellipsise) so it
    // never squeezes its siblings into clipping.
    const status = mkDiv({ color: LIGHT.inkSoft, fontWeight: "500", flex: "0 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "min(240px, 56vw)" });
    const progress = mkDiv({ color: LIGHT.inkFaint, fontVariantNumeric: "tabular-nums" });

    // progress bar inside the pill (hairline track + accent fill, so it reads on the glass)
    const barWrap = mkDiv({ position: "relative", width: "70px", height: "4px", background: LIGHT.hairline, borderRadius: "3px", overflow: "hidden", display: "none", flex: "0 0 auto" });
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
      display: "none", alignItems: "center", gap: "8px", color: LIGHT.inkFaint,
      fontSize: "11px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
      borderLeft: "1px solid " + LIGHT.hairline, paddingLeft: "8px", marginLeft: "2px",
      flex: "0 0 auto",
    });
    banner.appendChild(meter);

    // --- Drag handle (3 x 2 dots, six in total): the ONLY interactive node in the HUD. Hold it
    // to move the bar anywhere in the viewport (clamped so it can never leave the window), so a
    // user can get the HUD out of the way of the page they are watching. It is appended LAST so
    // the documented banner child order (0 icon .. 6 meter) is untouched. ---
    const grip = mkDiv({
      width: "15px", height: "12px", flex: "0 0 auto",
      display: "grid", gridTemplateColumns: "repeat(3, 3px)", gridTemplateRows: "repeat(2, 3px)",
      columnGap: "3px", rowGap: "3px", placeContent: "center",
      padding: "5px 6px", marginLeft: "2px", borderRadius: "999px",
      background: "transparent", border: "1px solid transparent",
      pointerEvents: "auto", cursor: "grab", touchAction: "none",
      transition: "background 200ms ease, border-color 200ms ease",
    });
    for (let i = 0; i < 6; i++) {
      // The dots are inert (mkDiv defaults to pointer-events:none), so only the pad itself
      // receives the hold - a stray dot can never swallow the gesture.
      grip.appendChild(mkDiv({ width: "3px", height: "3px", borderRadius: "50%", background: "currentColor", opacity: "0.7" }));
    }
    banner.appendChild(grip);

    // --- Esc-to-release chip (T4): sits just above the pill in the lower-right. It is the
    // INVERSE of the pill (near-opaque dark navy + white ink) so a single treatment reads on
    // both light and dark pages. Its bottom offset is assigned by stack(). ---
    const hint = mkDiv({
      position: "fixed", bottom: "72px", right: "32px",
      background: CHIP_BG, color: CHIP_INK, padding: "3px 10px",
      backdropFilter: "blur(8px)", webkitBackdropFilter: "blur(8px)",
      borderRadius: "999px", fontSize: "11px", whiteSpace: "nowrap",
      border: "1px solid rgba(255,255,255,0.16)",
      boxShadow: "0 6px 18px rgba(15,23,42,0.32)",
    });
    hint.textContent = "controlled by Laya \u2014 press Esc to release";
    root.appendChild(hint);

    // --- Synthetic cursor (T1): the reference pointer - a chunky arrow with a THICK white
    // outline, a translucent accent fill and a soft glow, so it reads over light and dark page
    // content alike while staying inert (pointer-events:none). The path's tip sits at (5,3) and
    // the wrapper is offset by exactly that much, so the tip lands on the true coordinate. ---
    const cursor = mkDiv({
      position: "fixed", left: "0", top: "0", width: "26px", height: "26px",
      transform: "translate(-5px,-3px)",
      filter: "drop-shadow(0 0 10px " + accentRgba(0.5) + ") drop-shadow(0 3px 6px rgba(2,6,23,0.45))",
      transition: "left 450ms cubic-bezier(.22,.61,.36,1), top 450ms cubic-bezier(.22,.61,.36,1)",
      display: "none",
    });
    cursor.innerHTML =
      "<svg width='26' height='26' viewBox='0 0 26 26'>" +
      "<path d='M5 3 L5 21.3 L9.8 16.6 L12.9 23.1 L16 21.7 L13 15.2 L19.4 14.7 Z'" +
      " fill='" + accentRgba(0.62) + "' stroke='#ffffff' stroke-width='2.1' stroke-linejoin='round'/></svg>";
    root.appendChild(cursor);

    // --- Caption/popover near the cursor (T2): dark glass + white ink so it reads over any page
    // and stays visually consistent with the Esc chip. ---
    const caption = mkDiv({
      position: "fixed", left: "0", top: "0", transform: "translate(18px, 10px)",
      background: CHIP_BG, color: CHIP_INK, padding: "3px 9px", borderRadius: "999px",
      fontSize: "12px", fontWeight: "600", whiteSpace: "nowrap", display: "none",
      backdropFilter: "blur(8px)", webkitBackdropFilter: "blur(8px)",
      border: "1px solid rgba(255,255,255,0.16)",
      boxShadow: "0 6px 18px rgba(2,6,23,0.4)",
    });
    root.appendChild(caption);

    // --- Spotlight (T1): a ring highlighting a target rect ---
    const spotlight = mkDiv({
      position: "fixed", left: "0", top: "0", width: "0", height: "0",
      border: "2px solid " + OPTS.accent, borderRadius: "6px",
      boxShadow: "0 0 0 3px " + accentRgba(0.25),
      transition: "left 300ms ease, top 300ms ease, width 300ms ease, height 300ms ease, opacity 200ms ease",
      display: "none",
    });
    root.appendChild(spotlight);

    // --- Scroll indicator (T3): right-anchored above the chip; stack() places it so it can
    // never land on top of the pill. ---
    const scroll = mkDiv({
      position: "fixed", right: "32px", bottom: "104px",
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

    // --- WAIT countdown ring (T3): right-anchored above the chip; stack() places it too. ---
    const countdown = mkDiv({
      position: "fixed", right: "32px", bottom: "140px",
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

    // --- Session aura: while Laya is in control of the tab the viewport wears a GRADIENT ON ALL
    // FOUR SIDES. Four accent bands, one per edge, over a soft radial vignette so the corners join
    // without a seam. TWO details matter and were both wrong before:
    //   1. every layer needs an EXPLICIT background-position, or it is painted at the top-left
    //      corner - which put the "to left" band (meant for the right edge) at the LEFT, leaving a
    //      hard accent line across the middle of the page. Each band is now pinned to its own edge.
    //   2. nothing may animate background-position, or the bands drift inland and re-introduce
    //      those hard edges; the aura breathes on opacity only (see ensureStyle).
    // It stays pointer-events:none throughout, so the page under it is fully usable. ---
    const band = 14; // how far each band reaches in (% of that axis)
    const edgeTop = accentRgba(0.3);
    const edgeSide = accentRgba(0.24);
    const sessionFrame = mkDiv({
      position: "fixed", top: "0", left: "0", right: "0", bottom: "0",
      display: "none", pointerEvents: "none",
      backgroundColor: "transparent",
      backgroundImage:
        // one band per edge, each fading inward from its own edge
        "linear-gradient(to bottom, " + edgeTop + ", " + accentRgba(0) + ")" +
        ", linear-gradient(to top, " + edgeTop + ", " + accentRgba(0) + ")" +
        ", linear-gradient(to right, " + edgeSide + ", " + accentRgba(0) + ")" +
        ", linear-gradient(to left, " + edgeSide + ", " + accentRgba(0) + ")" +
        // a soft vignette underneath, so the four corners meet without a seam
        ", radial-gradient(75% 75% at 50% 50%, " + accentRgba(0) + " 55%, " + accentRgba(0.26) + " 100%)",
      backgroundSize:
        "100% " + band + "%, 100% " + band + "%, " + band + "% 100%, " + band + "% 100%, 100% 100%",
      backgroundPosition: "50% 0, 50% 100%, 0 50%, 100% 50%, 50% 50%",
      backgroundRepeat: "no-repeat",
      boxShadow: "inset 0 0 0 1px " + accentRgba(0.2) + ", inset 0 0 120px " + accentRgba(0.1),
    });
    sessionFrame.className = "laya-aura";
    sessionFrame.setAttribute("data-laya-aura", "1");
    root.appendChild(sessionFrame);

    els = { banner, dot, title, stateLabel, status, progress, meter, barWrap, barFill, grip,
      hint, cursor, caption, spotlight, scroll, toasts, countdown, logPanel, logBody, seen,
      sessionFrame };
    // The grip is the one node that listens: holding it drags the bar (see place()).
    els.grip.addEventListener("pointerdown", onGripDown);
    els.grip.addEventListener("pointermove", onGripMove);
    els.grip.addEventListener("pointerup", onGripUp);
    els.grip.addEventListener("pointercancel", onGripUp);
    els.grip.addEventListener("pointerenter", onGripEnter);
    els.grip.addEventListener("pointerleave", onGripLeave);
    stack();
  }

  // --- Drag the bar (hold the 3x2 dot grip) ----------------------------------------
  // While the grip is held the pill follows the pointer, clamped so it can never leave the
  // viewport, and the chip/indicator column is re-anchored to trail it (stack()). The pinned spot
  // is published on api.__pos so the server can restore it after a navigation instead of letting
  // the bar jump back to its default corner.
  let dragging = null;

  function place(x, y) {
    if (!els.banner) return;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const size = els.banner.getBoundingClientRect();
    const nx = Math.round(Math.max(8, Math.min(Math.max(8, vw - size.width - 8), Number(x) || 0)));
    const ny = Math.round(Math.max(8, Math.min(Math.max(8, vh - size.height - 8), Number(y) || 0)));
    const moved = !api.__pos || api.__pos.x !== nx || api.__pos.y !== ny;
    api.__pos = { x: nx, y: ny };
    stack(); // stack() is what actually writes left/top, clamped to the viewport
    if (moved) reportPosition(nx, ny);
  }

  function gripPatch() {
    if (!els.grip) return;
    els.grip.style.background = dragging ? rgbaOf(OPTS.accent, 0.26) : "";
    els.grip.style.borderColor = dragging ? theme.ring : "transparent";
    els.grip.style.cursor = dragging ? "grabbing" : "grab";
  }

  function onGripEnter() {
    if (els.grip && !dragging) els.grip.style.background = rgbaOf(OPTS.accent, 0.16);
  }

  function onGripLeave() {
    if (els.grip && !dragging) els.grip.style.background = "";
  }

  function onGripDown(e) {
    if (!els.banner || !els.grip) return;
    if (e.button != null && e.button !== 0) return; // primary button only
    // Consume the gesture so the page's own document-level listeners never see it.
    e.preventDefault();
    e.stopPropagation();
    const box = els.banner.getBoundingClientRect();
    dragging = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    try { els.grip.setPointerCapture(e.pointerId); } catch (err) { /* capture is best-effort */ }
    gripPatch();
  }

  // Tell the server where the bar now sits, the moment the user drops it, through the binding
  // BrowserOverlay installs on the context. Best-effort: without the binding (a page created
  // outside the session) the position is still picked up by the next server call.
  function reportPosition(x, y) {
    try {
      if (typeof window.__layaReportPos === "function") window.__layaReportPos({ x: x, y: y });
    } catch (err) { /* reporting is best-effort */ }
  }

  function onGripMove(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    place(e.clientX - dragging.dx, e.clientY - dragging.dy);
  }

  function onGripUp(e) {
    if (!dragging) return;
    e.stopPropagation();
    dragging = null;
    try { els.grip.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    gripPatch();
    stack();
  }

  // Keep the right-anchored HUD column (pill -> Esc chip -> scroll indicator -> WAIT countdown)
  // from overlapping: each visible node is placed a fixed gap above the one below it, measured
  // from the live layout, so a taller pill (wrapped status, progress bar, meter) can never
  // collide with the chip. Cheap and idempotent; called after anything that can resize a node.
  function stack() {
    if (!els.banner || !document.documentElement.contains(els.banner)) return;
    // The glass/ink pairing depends on what is behind the pill, which changes as the pill moves
    // and the page scrolls, so re-derive it on every layout pass.
    applyTheme();
    const viewportWidth = window.innerWidth || 0;
    const viewport = window.innerHeight || 0;
    // The primary surface rests in the MIDDLE of the viewport (the computer-use convention: the
    // agent's status sits at the centre of the screen it is driving), and stays wherever the user
    // dragged it once they have. Either way it is clamped inside the window.
    const size = els.banner.getBoundingClientRect();
    const wanted = api.__pos || {
      x: (viewportWidth - size.width) / 2,
      y: (viewport - size.height) / 2,
    };
    const left = Math.round(
      Math.max(8, Math.min(Math.max(8, viewportWidth - size.width - 8), wanted.x)),
    );
    const top = Math.round(
      Math.max(8, Math.min(Math.max(8, viewport - size.height - 8), wanted.y)),
    );
    els.banner.style.left = left + "px";
    els.banner.style.top = top + "px";
    els.banner.style.right = "auto";
    els.banner.style.bottom = "auto";
    const box = els.banner.getBoundingClientRect();
    let offset = Math.max(0, viewport - box.top) + STACK_GAP;
    // The column trails the pill horizontally too, so it stays beside it after a drag.
    const right = Math.max(8, Math.round(viewportWidth - box.right));
    const column = [els.hint, els.scroll, els.countdown];
    for (const node of column) {
      if (!node) continue;
      if (getComputedStyle(node).display === "none") continue;
      node.style.bottom = offset + "px";
      node.style.right = right + "px";
      offset += node.getBoundingClientRect().height + STACK_GAP;
    }
    // The activity-log panel sits in the opposite (bottom-left) corner. On a viewport too narrow
    // for both, clamp its width so it stops short of the pill instead of running underneath it.
    if (OPTS.activityLog && els.logPanel) {
      const room = Math.floor(box.left - STACK_GAP - 12);
      // No usable sliver left of the pill (a phone-width viewport): drop the panel rather than
      // let it run underneath the pill. OPTS.activityLog is fixed at build time, so restoring
      // the panel can never resurrect one the user switched off.
      els.logPanel.style.display = room < 90 ? "none" : "flex";
      els.logPanel.style.maxWidth = room >= 90 && room < 240 ? room + "px" : "";
    }
  }

  const api = {
    enabled: true,
    __lastCursor: null,
    /** Where the bar currently sits (null = the default corner); read back by the server. */
    __pos: null,
    /** True until the first server call on THIS document, which re-applies the pinned spot. */
    __fresh: true,
    /** The spot the user last dragged the bar to, as told by the server (null = default). */
    __pinned: null,
    setStatus(text) {
      if (!ensureRoot()) return;
      lastStatus = text == null ? "" : String(text);
      els.status.textContent = lastStatus;
      refreshGlyph();
      stack();
    },
    setState(state) {
      if (!ensureRoot()) return;
      // state.color is the bright state hue: it tints the glass icon badge, the progress fill and
      // the pill glow. state.ink is the darker variant used for the LABEL when the light glass is
      // in play (applyTheme decides), and state.glyph is the line-art mark drawn inside the badge.
      const map = {
        thinking: { label: "\u{1F914} Deciding\u2026", color: OPTS.accent, ink: inkFor(0.62), glyph: "spark" },
        acting: { label: "\u26A1 Acting\u2026", color: OPTS.accent, ink: inkFor(0.62), glyph: "cursor" },
        success: { label: "\u2713 Done", color: "#22c55e", ink: "#15803d", glyph: "check" },
        error: { label: "\u2717 Error", color: "#ef4444", ink: "#b91c1c", glyph: "cross" },
        uncertain: { label: "? Uncertain", color: OPTS.uncertainColor, ink: "#b45309", glyph: "question" },
      };
      const s = map[state] || map.thinking;
      stateColor = s.color;
      stateInk = s.ink;
      stateGlyph = s.glyph;
      els.stateLabel.textContent = s.label;
      heartbeat = !map[state] || state === "thinking";
      refreshGlyph();
      pulse();
      stack();
    },
    /**
     * Park the bar at an absolute viewport position (used to restore the spot the user dragged it
     * to after a navigation). Clamped like a drag, so a stale position from a larger window can
     * never strand the pill off-screen.
     */
    setPosition(x, y) {
      if (x == null || y == null) return;
      if (!ensureRoot()) return;
      place(x, y);
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
      stack();
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
      stack();
    },
    showCursor(x, y) {
      if (!ensureRoot()) return;
      const cx = x == null ? Math.round(window.innerWidth / 2) : Number(x);
      const cy = y == null ? Math.round(window.innerHeight / 2) : Number(y);
      api.__lastCursor = { x: cx, y: cy };
      els.cursor.style.display = "block";
      els.cursor.style.left = cx + "px";
      els.cursor.style.top = cy + "px";
    },
    sessionFrame(on) {
      if (!ensureRoot()) return;
      els.sessionFrame.style.display = on ? "block" : "none";
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
        background: accentRgba(0.5), border: "2px solid " + OPTS.accent,
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
      if (total <= 0) { els.countdown.style.display = "none"; stack(); return; }
      els.countdown.style.display = "block";
      stack();
      const start = Date.now();
      if (countdownRaf) cancelAnimationFrame(countdownRaf);
      const tick = () => {
        const left = Math.max(0, total - (Date.now() - start));
        els.countdown.textContent = "\u23F3 " + (left / 1000).toFixed(1) + "s";
        if (left > 0) { countdownRaf = requestAnimationFrame(tick); }
        else { els.countdown.style.display = "none"; countdownRaf = 0; stack(); }
      };
      tick();
    },
    scrollIndicator(direction, pos) {
      if (!ensureRoot()) return;
      const arrows = { up: "\u2191", down: "\u2193", left: "\u2190", right: "\u2192" };
      els.scroll.style.display = "block";
      els.scroll.textContent = (arrows[direction] || "\u2193") + " " + (pos == null ? "" : String(pos));
      stack();
      clearTimeout(els.scroll.__t);
      els.scroll.__t = setTimeout(() => { els.scroll.style.display = "none"; stack(); }, 1200);
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
    // (Perf) Apply several HUD updates in ONE round-trip. The loop used to pay a separate
    // page.evaluate per narration call (about 13 per step, each ~1.4ms of pure round-trip
    // before any in-page work happened); a batch collapses the per-step chatter into a single
    // call. Each entry is [method, ...args]; unknown and self-referential entries are skipped
    // and every call is individually guarded, so one bad entry can never abort the rest of the
    // batch (and nothing can bubble out of the page).
    batch(ops) {
      if (!ops || typeof ops.length !== "number") return;
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (!op || typeof op[0] !== "string") continue;
        const name = op[0];
        if (name === "batch") continue;
        const fn = api[name];
        if (typeof fn !== "function") continue;
        try {
          fn.apply(api, Array.prototype.slice.call(op, 1));
        } catch (e) {
          // One malformed entry must not abort the rest of the batch.
        }
      }
    },
    // (Perf) Resolve a ref and aim the cursor + spotlight at it in ONE round-trip, returning the
    // rect (or null). focusTarget previously spent three evaluates on this; the cursor math and
    // caption handling are identical.
    focus(ref, caption) {
      const rect = api.refRect(ref);
      if (!rect) return null;
      api.moveCursor(rect.x + rect.width / 2, rect.y + rect.height / 2, caption);
      api.spotlight(rect);
      return rect;
    },
  };

  function pulse() {
    // Idle heartbeat / breathing pulse on the glass icon badge while "thinking".
    if (!els.dot) return;
    if (!heartbeat) { els.dot.style.transform = "scale(1)"; return; }
    const grow = els.dot.style.transform === "scale(1.14)";
    els.dot.style.transform = grow ? "scale(1)" : "scale(1.14)";
    setTimeout(() => { if (heartbeat) pulse(); }, 650);
  }

  window.__layaOverlay = api;
  // A viewport resize changes where the pill sits, so the stacked column is re-measured.
  window.addEventListener("resize", stack);
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
  /**
   * The spot the user dragged the bar to on the page (viewport coordinates), remembered
   * server-side so it survives a navigation: every overlay call reports the pinned position back,
   * and {@link install} re-applies it to freshly loaded documents. Null means "default corner".
   */
  private pinnedPos: { x: number; y: number } | null = null;

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
