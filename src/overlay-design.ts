/**
 * The overlay design system: the ONE place the HUD's look is defined.
 *
 * - {@link TOKENS}: colour, glass, type, radius, spacing, shadow, motion and layering tokens.
 * - {@link ACTIVITIES}: every activity the HUD can show (Clicking, Typing, Reading, ...), its
 *   label, icon and tone. The pill, the cursor chip, the activity log and toasts all read this
 *   registry, so an activity looks the same everywhere.
 * - {@link ICONS}: the line-art icon set (24px grid, 1.8 stroke, round caps).
 * - {@link buildOverlayCss}: the single stylesheet, generated from the tokens and scoped to the
 *   overlay's shadow root. Components carry class names only; nothing outside this file picks a
 *   colour, a radius or a duration.
 *
 * Pure: no DOM, no Playwright. The client script (src/overlay-client.ts) receives the CSS, the
 * registry and the icons as data.
 */

/** Tones change the surface of the status pill (and the colour of icons/toasts). */
export type Tone = "accent" | "done" | "error" | "uncertain";

/** Every activity the HUD can narrate. */
export type ActivityId =
  | "ready"
  | "working"
  | "thinking"
  | "clicking"
  | "typing"
  | "opening"
  | "reading"
  | "searching"
  | "scrolling"
  | "inspecting"
  | "selecting"
  | "navigating"
  | "running"
  | "waiting"
  | "done"
  | "error"
  | "uncertain"
  | "asking"
  | "paused";

export interface Activity {
  /** The pill's bold verb. In-progress activities end with an ellipsis. */
  label: string;
  /** Key into {@link ICONS}. */
  icon: IconId;
  tone: Tone;
}

export const ACTIVITIES: Record<ActivityId, Activity> = {
  ready: { label: "Laya", icon: "sparkles", tone: "accent" },
  working: { label: "Working\u2026", icon: "working", tone: "accent" },
  thinking: { label: "Thinking\u2026", icon: "sparkles", tone: "accent" },
  clicking: { label: "Clicking\u2026", icon: "cursor", tone: "accent" },
  typing: { label: "Typing\u2026", icon: "keyboard", tone: "accent" },
  opening: { label: "Opening\u2026", icon: "window", tone: "accent" },
  reading: { label: "Reading\u2026", icon: "document", tone: "accent" },
  searching: { label: "Searching\u2026", icon: "search", tone: "accent" },
  scrolling: { label: "Scrolling\u2026", icon: "arrowDown", tone: "accent" },
  inspecting: { label: "Inspecting\u2026", icon: "brackets", tone: "accent" },
  selecting: { label: "Selecting\u2026", icon: "dashedSquare", tone: "accent" },
  navigating: { label: "Navigating\u2026", icon: "send", tone: "accent" },
  running: { label: "Running\u2026", icon: "play", tone: "accent" },
  waiting: { label: "Waiting\u2026", icon: "dashedCircle", tone: "accent" },
  done: { label: "Done", icon: "checkCircle", tone: "done" },
  error: { label: "Error", icon: "alert", tone: "error" },
  uncertain: { label: "Checking\u2026", icon: "question", tone: "uncertain" },
  asking: { label: "Needs you", icon: "hand", tone: "uncertain" },
  paused: { label: "You have control", icon: "hand", tone: "uncertain" },
};

/**
 * Narration text -> activity, for callers that only say what they are doing ("Clicking Sign
 * in", "Reading page..."). First match wins. Kept here so the verbs and the activities they map
 * to are defined next to each other.
 */
export const ACTIVITY_VERBS: ReadonlyArray<readonly [pattern: string, activity: ActivityId]> = [
  ["^(?:click|press(?:ing)? the|tap)", "clicking"],
  ["^search", "searching"],
  ["^(?:typ|fill|enter|pressing)", "typing"],
  ["^select|^choos", "selecting"],
  ["^(?:hover|inspect|verif|captur|screenshot|check)", "inspecting"],
  ["^(?:navigat|going back|go back|loading)", "navigating"],
  ["^scroll", "scrolling"],
  ["^wait", "waiting"],
  ["^(?:read|extract|scan|look)", "reading"],
  ["^(?:open|follow|switch)", "opening"],
  ["^(?:decid|think|plan)", "thinking"],
  ["^(?:awaiting|approve|about to)", "asking"],
  ["^(?:low confidence|asking|re-resolving)", "uncertain"],
  ["^(?:goal complete|done|finished)", "done"],
  ["^(?:stuck|stopped|error|failed|blocked)", "error"],
];

export type IconId =
  | "working"
  | "sparkles"
  | "cursor"
  | "keyboard"
  | "window"
  | "document"
  | "search"
  | "arrowDown"
  | "brackets"
  | "dashedSquare"
  | "send"
  | "play"
  | "dashedCircle"
  | "checkCircle"
  | "alert"
  | "question"
  | "hand"
  | "info";

/** Inner SVG markup on a 24x24 grid; the client wraps it in one shared <svg> shell. */
export const ICONS: Record<IconId, string> = {
  working:
    "<path d='M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16'/>" +
    "<path d='M10 9.5l6 2.4-2.5.9-.9 2.5z'/>",
  sparkles:
    "<path d='M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z'/>" +
    "<path d='M18 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'/>",
  cursor: "<path d='M5 3.5l5.9 16.3 2.2-6.7 6.7-2.2z'/>",
  keyboard:
    "<rect x='2.5' y='6' width='19' height='12' rx='2.5'/>" +
    "<path d='M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9'/>",
  window: "<rect x='3' y='4.5' width='18' height='15' rx='2.5'/><path d='M3 9h18M6.5 6.8h.01M9 6.8h.01'/>",
  document:
    "<path d='M7 3h7l5 5v11.5A1.5 1.5 0 0 1 17.5 21h-10A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z'/>" +
    "<path d='M14 3v5h5M9 13h6M9 17h4'/>",
  search: "<circle cx='10.5' cy='10.5' r='6'/><path d='M15 15l5 5'/>",
  arrowDown: "<path d='M12 4v15M6 13l6 6 6-6'/>",
  brackets: "<path d='M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4'/>",
  dashedSquare: "<rect x='4' y='4' width='16' height='16' rx='2' stroke-dasharray='3 3'/>",
  send: "<path d='M21 3L10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z'/>",
  play: "<circle cx='12' cy='12' r='9'/><path d='M10 8.5v7l6-3.5z'/>",
  dashedCircle: "<circle cx='12' cy='12' r='8.5' stroke-dasharray='2.6 3.1'/>",
  checkCircle: "<circle cx='12' cy='12' r='9'/><path d='M8 12.4l2.8 2.8 5.4-5.6'/>",
  alert: "<path d='M12 3.8L2.8 19.8h18.4z'/><path d='M12 10v4.2M12 17.2h.01'/>",
  question:
    "<circle cx='12' cy='12' r='9'/><path d='M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6M12 16.8h.01'/>",
  hand:
    "<path d='M8 12.5V6.8a1.5 1.5 0 0 1 3 0V11M11 10.5V5.3a1.5 1.5 0 0 1 3 0v5.9M14 10.8V7.3a1.5 1.5 0 0 1 3 0v6.4a6.3 6.3 0 0 1-6.3 6.3h-.4a5 5 0 0 1-4.2-2.3l-2-3.2a1.5 1.5 0 0 1 2.5-1.7L8 14.2'/>",
  info: "<circle cx='12' cy='12' r='9'/><path d='M12 11v5M12 8h.01'/>",
};

/** Toast kinds -> the activity whose icon and tone they borrow. */
export const TOAST_ACTIVITY: Record<"info" | "success" | "error" | "uncertain", ActivityId> = {
  info: "working",
  success: "done",
  error: "error",
  uncertain: "uncertain",
};

/** The design tokens. Colours are CSS strings; sizes are px unless noted. */
export const TOKENS = {
  font: {
    family:
      "'Inter', 'Inter var', ui-sans-serif, system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    size: { xs: 11, sm: 12, md: 13 },
    weight: { regular: 500, strong: 650 },
  },
  radius: { pill: 999, card: 18, box: 10, handle: 2.5 },
  space: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 },
  /**
   * Two surface themes. `light` is frosted white glass with navy ink, for light pages; `dark`
   * is thin white glass with white ink, for dark or coloured pages (the reference look). The
   * client picks one from the luminance of what is actually behind the pill.
   */
  theme: {
    light: {
      glass: "rgba(248, 251, 255, 0.86)",
      sheen: "linear-gradient(180deg, rgba(255,255,255,0.7), rgba(255,255,255,0) 60%)",
      rim: "rgba(255, 255, 255, 0.95)",
      edge: "rgba(37, 99, 235, 0.16)",
      ink: "#0b2545",
      inkSoft: "#2c4467",
      inkFaint: "#4a6285",
      track: "rgba(37, 99, 235, 0.14)",
      shadow: "0 12px 32px rgba(30, 64, 175, 0.18), 0 2px 8px rgba(15, 23, 42, 0.10)",
    },
    dark: {
      glass: "rgba(20, 32, 58, 0.52)",
      sheen: "linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%)",
      rim: "rgba(255, 255, 255, 0.34)",
      edge: "rgba(255, 255, 255, 0.10)",
      ink: "#ffffff",
      inkSoft: "rgba(255, 255, 255, 0.90)",
      inkFaint: "rgba(255, 255, 255, 0.76)",
      track: "rgba(255, 255, 255, 0.22)",
      shadow: "0 12px 32px rgba(2, 6, 23, 0.45), 0 2px 8px rgba(2, 6, 23, 0.30)",
    },
  },
  /** Status tones: an opaque-enough tinted surface with dark ink, so text always clears AA. */
  tone: {
    done: {
      surface: "#b4f1e3",
      sheen: "linear-gradient(135deg, #c8f7ee 0%, #9eead7 55%, #a6f0c9 100%)",
      ink: "#064e3b",
      icon: "#047857",
    },
    error: {
      surface: "#fcc9cf",
      sheen: "linear-gradient(135deg, #fdd5dc 0%, #fbb3bf 55%, #f9a8a8 100%)",
      ink: "#7f1d1d",
      icon: "#b91c1c",
    },
    uncertain: {
      surface: "#fde9b4",
      sheen: "linear-gradient(135deg, #fef1c7 0%, #fde3a1 100%)",
      ink: "#713f12",
      icon: "#b45309",
    },
  },
  /** Fixed tints for surfaces that are always dark (the takeover chip). */
  inverse: { surface: "rgba(11, 23, 45, 0.9)", ink: "#f8fafc", rim: "rgba(255,255,255,0.18)" },
  blur: { glass: "blur(18px) saturate(170%)", chip: "blur(12px) saturate(160%)" },
  motion: {
    fast: 140,
    base: 220,
    slow: 420,
    ease: "cubic-bezier(.2,.8,.2,1)",
    spring: "cubic-bezier(.34,1.56,.64,1)",
    /** Cursor glide: duration = clamp(min + distance * perPx, min, max). */
    cursor: { min: 220, max: 680, perPx: 0.55 },
    /** Live narration reveal: per character, capped overall. */
    narration: { perChar: 14, max: 380 },
  },
  z: 2147483646,
} as const;

/** `#rrggbb`/`#rgb` -> "r, g, b" (the default blue on a malformed value). */
export function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = /^[0-9a-f]{6}$/i.test(full) ? parseInt(full, 16) : 0x3b82f6;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** A darker variant of the accent, for icons and ink on light glass. */
function accentStrong(hex: string): string {
  const [r, g, b] = hexToRgb(hex).split(",").map((v) => Math.round(Number(v) * 0.72));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The overlay's one stylesheet, scoped to its shadow root (`:host` is the overlay host). All
 * colours and timings come from {@link TOKENS} (and the configured accent) through CSS custom
 * properties, so a theme or tone switch is a single attribute change on the host.
 */
export function buildOverlayCss(accent: string): string {
  const t = TOKENS;
  const L = t.theme.light;
  const D = t.theme.dark;
  const m = t.motion;
  const rgb = hexToRgb(accent);
  const vars = (v: typeof L | typeof D): string =>
    `--glass:${v.glass};--sheen:${v.sheen};--rim:${v.rim};--edge:${v.edge};--ink:${v.ink};` +
    `--ink-soft:${v.inkSoft};--ink-faint:${v.inkFaint};--track:${v.track};--shadow:${v.shadow};`;
  const tone = (name: "done" | "error" | "uncertain"): string => {
    const v = t.tone[name];
    return (
      `:host([data-tone='${name}']) .hud{background-color:${v.surface};background-image:${v.sheen};` +
      `border-color:rgba(255,255,255,0.85);}` +
      `:host([data-tone='${name}']) .hud .label,:host([data-tone='${name}']) .hud .narration,` +
      `:host([data-tone='${name}']) .hud .progress-text,:host([data-tone='${name}']) .hud .meter{color:${v.ink};}` +
      `:host([data-tone='${name}']) .hud .icon{color:${v.icon};background:rgba(255,255,255,0.55);}` +
      `:host([data-tone='${name}']) .ring .value{stroke:${v.icon};}` +
      `.tone-${name}{--tone:${v.icon};}`
    );
  };
  return [
    `:host{all:initial;position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:${t.z};` +
      // No \`contain\`: layout containment would make this zero-size host the containing block
      // of every position:fixed child and push them off screen.
      `pointer-events:none;` +
      `--accent:${accent};--accent-rgb:${rgb};--accent-strong:${accentStrong(accent)};` +
      `--font:${t.font.family};--ease:${m.ease};--spring:${m.spring};` +
      `--fast:${m.fast}ms;--base:${m.base}ms;--slow:${m.slow}ms;${vars(L)}}`,
    `:host([data-theme='dark']){${vars(D)}}`,
    `*{box-sizing:border-box;pointer-events:none;margin:0;}`,
    `svg.i{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.8;` +
      `stroke-linecap:round;stroke-linejoin:round;display:block;}`,
    // Glass surface shared by every pill-shaped component.
    `.glass{background-color:var(--glass);background-image:var(--sheen);color:var(--ink);` +
      `border:1px solid var(--rim);box-shadow:var(--shadow),0 0 0 1px var(--edge),inset 0 1px 0 rgba(255,255,255,0.55);` +
      `backdrop-filter:${t.blur.glass};-webkit-backdrop-filter:${t.blur.glass};font-family:var(--font);}`,
    // Status pill (the HUD).
    `.hud{position:fixed;display:flex;align-items:center;gap:10px;min-height:44px;` +
      `max-width:min(640px,calc(100vw - 32px));padding:6px 8px 6px 7px;border-radius:${t.radius.pill}px;` +
      `font-size:${t.font.size.md}px;line-height:1.3;font-weight:${t.font.weight.regular};` +
      `font-variant-numeric:tabular-nums;letter-spacing:0.005em;` +
      `transition:background-color var(--base) var(--ease),box-shadow var(--base) var(--ease),color var(--base) var(--ease);}`,
    `.hud .icon{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;` +
      `color:var(--accent-strong);background:rgba(var(--accent-rgb),0.14);border:1px solid var(--rim);` +
      `transition:color var(--base) var(--ease),background var(--base) var(--ease);}`,
    `:host([data-theme='dark']) .hud .icon{color:#fff;background:rgba(var(--accent-rgb),0.45);}`,
    `.hud .label{font-weight:${t.font.weight.strong};white-space:nowrap;color:var(--ink);}`,
    `.hud .narration{color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
      `min-width:0;flex:1 1 60px;}`,
    `.hud .narration:empty{display:none;}`,
    `.hud .progress{display:none;align-items:center;gap:6px;flex:0 0 auto;}`,
    `.hud .progress.on{display:flex;}`,
    `.ring{width:22px;height:22px;transform:rotate(-90deg);}`,
    `.ring circle{fill:none;stroke-width:3;}`,
    `.ring .track{stroke:var(--track);}`,
    `.ring .value{stroke:var(--accent);stroke-linecap:round;transition:stroke-dashoffset var(--slow) var(--ease);}`,
    `.hud .progress-text,.hud .meter{color:var(--ink-faint);font-size:${t.font.size.sm}px;white-space:nowrap;}`,
    `.hud .meter{display:none;padding-left:10px;border-left:1px solid var(--track);overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto;}`,
    `.hud .meter.on{display:block;}`,
    `.grip{pointer-events:auto;cursor:grab;touch-action:none;display:grid;grid-template-columns:repeat(3,3px);` +
      `grid-template-rows:repeat(2,3px);gap:3px;padding:7px 6px;border-radius:${t.radius.pill}px;flex:0 0 auto;` +
      `color:var(--ink-faint);transition:background var(--fast) var(--ease);}`,
    `.grip:hover{background:rgba(var(--accent-rgb),0.14);}`,
    `.grip.dragging{cursor:grabbing;background:rgba(var(--accent-rgb),0.22);}`,
    `.grip i{display:block;width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.75;}`,
    `.hud.thinking .icon{animation:laya-glow 1.6s var(--ease) infinite;}`,
    `.hud.waiting .icon svg{animation:laya-spin 2.4s linear infinite;}`,
    `.hud.pop{animation:laya-pop var(--base) var(--spring);}`,
    // Takeover chip (only while a run is active).
    `.takeover{position:fixed;left:0;top:0;display:none;align-items:center;gap:8px;padding:5px 12px;border-radius:${t.radius.pill}px;` +
      `background:${t.inverse.surface};color:${t.inverse.ink};border:1px solid ${t.inverse.rim};` +
      `font:${t.font.weight.regular} ${t.font.size.xs}px/1.4 var(--font);white-space:nowrap;` +
      `box-shadow:0 8px 20px rgba(2,6,23,0.3);backdrop-filter:${t.blur.chip};-webkit-backdrop-filter:${t.blur.chip};}`,
    `.takeover.on{display:flex;}`,
    `.takeover kbd{font:inherit;font-weight:${t.font.weight.strong};padding:0 6px;border-radius:5px;` +
      `border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.12);}`,
    `.takeover .live{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,0.25);animation:laya-glow 1.8s var(--ease) infinite;}`,
    // Cursor + the action chip that travels with it.
    `.cursor{position:fixed;left:0;top:0;width:28px;height:28px;display:none;will-change:transform;` +
      `filter:drop-shadow(0 4px 8px rgba(15,23,42,0.35)) drop-shadow(0 0 10px rgba(var(--accent-rgb),0.45));}`,
    `.cursor.on{display:block;}`,
    `.cursor svg{position:absolute;left:-5px;top:-3.2px;width:28px;height:28px;overflow:visible;}`,
    `.cursor .arrow{fill:rgba(255,255,255,0.94);stroke:var(--accent);stroke-width:1.6;stroke-linejoin:round;}`,
    `.cursor .shine{fill:rgba(var(--accent-rgb),0.16);}`,
    `.cursor.press svg{animation:laya-press 260ms var(--ease);}`,
    `.chip{position:fixed;left:0;top:0;display:none;align-items:center;gap:7px;padding:5px 11px 5px 8px;` +
      `border-radius:${t.radius.pill}px;font-size:${t.font.size.sm}px;font-weight:${t.font.weight.strong};` +
      `white-space:nowrap;max-width:320px;will-change:transform;}`,
    `.chip.on{display:flex;animation:laya-pop var(--base) var(--spring);}`,
    `.chip .i{color:var(--accent-strong);}`,
    `:host([data-theme='dark']) .chip .i{color:#fff;}`,
    `.chip .text{overflow:hidden;text-overflow:ellipsis;}`,
    `.dots{display:none;gap:3px;align-items:center;}`,
    `.dots.on{display:inline-flex;}`,
    `.dots i{width:4px;height:4px;border-radius:50%;background:var(--accent);animation:laya-dot 1s ease-in-out infinite;}`,
    `.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}`,
    // Target: element selection box with corner handles, plus a hover/focus indicator.
    `.target{position:fixed;left:0;top:0;width:0;height:0;display:none;border-radius:${t.radius.box}px;` +
      `border:1.5px dashed var(--accent);background:rgba(var(--accent-rgb),0.07);` +
      `box-shadow:0 0 0 4px rgba(var(--accent-rgb),0.10);` +
      `transition:left var(--base) var(--ease),top var(--base) var(--ease),width var(--base) var(--ease),height var(--base) var(--ease);}`,
    `.target.on{display:block;}`,
    `.target.flash{animation:laya-flash 420ms var(--ease);}`,
    `.target .h{position:absolute;width:8px;height:8px;border-radius:${t.radius.handle}px;background:#fff;` +
      `border:1.5px solid var(--accent);box-shadow:0 1px 3px rgba(15,23,42,0.25);}`,
    `.target .h.tl{left:-5px;top:-5px}.target .h.tr{right:-5px;top:-5px}.target .h.bl{left:-5px;bottom:-5px}.target .h.br{right:-5px;bottom:-5px}`,
    `.caret{position:fixed;width:2px;display:none;border-radius:1px;background:var(--accent);animation:laya-blink 1s steps(1) infinite;}`,
    `.caret.on{display:block;}`,
    `.focus{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;display:none;` +
      `border:1.5px solid var(--accent);background:rgba(var(--accent-rgb),0.10);}`,
    `.focus::after{content:'';position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--accent);}`,
    `.focus.on{display:block;animation:laya-pulse 1.4s var(--ease) infinite;}`,
    // Click ripple (two rings + a core), and the cursor trail.
    `.ripple{position:fixed;width:0;height:0;}`,
    `.ripple i{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;` +
      `border:2px solid rgba(var(--accent-rgb),0.85);background:rgba(var(--accent-rgb),0.12);` +
      `animation:laya-ripple 620ms var(--ease) forwards;}`,
    `.ripple i:nth-child(2){animation-delay:110ms;background:none;border-width:1.5px;}`,
    `.ripple b{position:absolute;left:-5px;top:-5px;width:10px;height:10px;border-radius:50%;background:var(--accent);` +
      `animation:laya-core 420ms var(--ease) forwards;}`,
    `.trail{position:fixed;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--accent);` +
      `transition:opacity 520ms ease-out;}`,
    // Scroll indicator: a slim track on the right edge.
    `.scrollbar{position:fixed;right:10px;top:50%;width:10px;height:120px;margin-top:-60px;display:none;` +
      `border-radius:${t.radius.pill}px;padding:2px;}`,
    `.scrollbar.on{display:block;}`,
    `.scrollbar .thumb{width:100%;min-height:18px;border-radius:${t.radius.pill}px;background:var(--accent);` +
      `transition:transform var(--base) var(--ease),height var(--base) var(--ease);}`,
    `.scrollbar .dir{position:absolute;right:18px;top:50%;margin-top:-13px;display:flex;align-items:center;gap:6px;` +
      `padding:4px 10px 4px 7px;border-radius:${t.radius.pill}px;font-size:${t.font.size.sm}px;font-weight:${t.font.weight.strong};white-space:nowrap;}`,
    // Toasts.
    `.toasts{position:fixed;right:16px;top:16px;display:flex;flex-direction:column;gap:8px;align-items:flex-end;}`,
    `.toast{display:flex;align-items:center;gap:8px;max-width:320px;padding:7px 12px 7px 9px;border-radius:${t.radius.pill}px;` +
      `font-size:${t.font.size.sm}px;animation:laya-slide var(--base) var(--ease);}`,
    `.toast .i{color:var(--tone,var(--accent-strong));}`,
    `.toast.out{opacity:0;transform:translateX(12px);transition:opacity var(--base) var(--ease),transform var(--base) var(--ease);}`,
    // Activity log (live narration history).
    `.log{position:fixed;left:16px;bottom:16px;width:280px;display:flex;flex-direction:column;border-radius:${t.radius.card}px;` +
      `overflow:hidden;font-size:${t.font.size.sm}px;}`,
    `.log .head{display:flex;justify-content:space-between;align-items:center;padding:9px 12px 7px;` +
      `font-weight:${t.font.weight.strong};color:var(--ink);border-bottom:1px solid var(--track);}`,
    `.log .count{color:var(--ink-faint);font-weight:${t.font.weight.regular};font-size:${t.font.size.xs}px;}`,
    `.log .body{max-height:168px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;padding:4px 0 6px;}`,
    `.log .entry{display:flex;align-items:center;gap:8px;padding:4px 12px;color:var(--ink-soft);animation:laya-slide-up var(--base) var(--ease);}`,
    `.log .entry .i{width:14px;height:14px;color:var(--tone,var(--accent-strong));}`,
    `:host([data-theme='dark']) .log .entry .i{color:var(--tone,#fff);}`,
    `.log .entry .text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}`,
    `.log .entry time{color:var(--ink-faint);font-size:${t.font.size.xs}px;}`,
    `.log .entry:last-child .text{color:var(--ink);font-weight:${t.font.weight.strong};}`,
    // WAIT countdown pill (rides under the HUD with the takeover chip).
    `.countdown{position:fixed;display:none;align-items:center;gap:7px;padding:4px 11px 4px 8px;` +
      `border-radius:${t.radius.pill}px;font-size:${t.font.size.sm}px;font-weight:${t.font.weight.strong};}`,
    `.countdown.on{display:flex;}`,
    `.countdown svg{animation:laya-spin 2.4s linear infinite;}`,
    // Debug "what the agent sees".
    `.seen{position:fixed;left:0;top:0;}`,
    `.seen .box{position:fixed;border:1px dashed var(--accent);border-radius:4px;}`,
    `.seen .tag{position:fixed;background:var(--accent);color:#fff;font:${t.font.weight.strong} 9px/1.4 var(--font);padding:0 4px;border-radius:3px;}`,
    // Session aura: the page edges glow while Laya has the tab (opacity breathes; bands pinned).
    // Four accent bands, each pinned to its own edge, over a soft radial vignette so the corners
    // meet without a seam. Only opacity animates: moving the bands re-introduces hard lines.
    `.aura{position:fixed;inset:0;display:block;background-repeat:no-repeat;` +
      `background-image:linear-gradient(to bottom,rgba(${rgb},0.26),rgba(${rgb},0)),` +
      `linear-gradient(to top,rgba(${rgb},0.26),rgba(${rgb},0)),` +
      `linear-gradient(to right,rgba(${rgb},0.2),rgba(${rgb},0)),` +
      `linear-gradient(to left,rgba(${rgb},0.2),rgba(${rgb},0)),` +
      `radial-gradient(75% 75% at 50% 50%,rgba(${rgb},0) 70%,rgba(${rgb},0.1) 100%);` +
      `background-size:100% 9%,100% 9%,7% 100%,7% 100%,100% 100%;` +
      `background-position:50% 0,50% 100%,0 50%,100% 50%,50% 50%;` +
      `box-shadow:inset 0 0 0 1px rgba(${rgb},0.18);animation:laya-aura 4.2s ease-in-out infinite;}`,
    `.aura.off{display:none;}`,
    tone("done"),
    tone("error"),
    tone("uncertain"),
    // Motion.
    `@keyframes laya-pop{0%{transform:scale(.94);opacity:.4}100%{transform:scale(1);opacity:1}}`,
    `@keyframes laya-press{0%{transform:scale(1)}40%{transform:scale(.82)}100%{transform:scale(1)}}`,
    `@keyframes laya-ripple{0%{transform:scale(.3);opacity:1}100%{transform:scale(1.6);opacity:0}}`,
    `@keyframes laya-core{0%{transform:scale(1);opacity:1}100%{transform:scale(.2);opacity:0}}`,
    `@keyframes laya-flash{0%{box-shadow:0 0 0 0 rgba(var(--accent-rgb),.45)}100%{box-shadow:0 0 0 12px rgba(var(--accent-rgb),0)}}`,
    `@keyframes laya-blink{0%,49%{opacity:1}50%,100%{opacity:0}}`,
    `@keyframes laya-dot{0%,100%{transform:translateY(0);opacity:.45}50%{transform:translateY(-3px);opacity:1}}`,
    `@keyframes laya-spin{to{transform:rotate(360deg)}}`,
    `@keyframes laya-glow{0%,100%{box-shadow:0 0 0 0 rgba(var(--accent-rgb),.35)}50%{box-shadow:0 0 0 6px rgba(var(--accent-rgb),0)}}`,
    `@keyframes laya-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}`,
    `@keyframes laya-slide{0%{opacity:0;transform:translateX(14px)}100%{opacity:1;transform:none}}`,
    `@keyframes laya-slide-up{0%{opacity:0;transform:translateY(6px)}100%{opacity:1;transform:none}}`,
    `@keyframes laya-aura{0%,100%{opacity:.72}50%{opacity:1}}`,
    `@media (prefers-reduced-motion: reduce){*,*::after{animation:none !important;transition:none !important;}}`,
  ].join("\n");
}
