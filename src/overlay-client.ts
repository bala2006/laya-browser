/**
 * The in-page half of the overlay: a renderer for the design system in ./overlay-design.ts.
 *
 * {@link overlayClient} is serialised with `Function.prototype.toString` and injected as an init
 * script, so it must close over NOTHING from this module: everything it needs arrives in its
 * single `cfg` argument (the generated stylesheet, the activity registry, the icons, options).
 *
 * It renders into an OPEN shadow root on a host attached to `<html>` (not `<body>`):
 *   - page CSS cannot restyle the HUD and the HUD's CSS cannot touch the page;
 *   - the HUD's text is not part of `document.body.innerText`, so narration never leaks into
 *     the page text the model reads or the success check scans;
 *   - a page that rewrites `body.innerHTML` does not wipe the HUD.
 * Every node is `pointer-events:none` except the six-dot drag grip.
 *
 * It exposes `window.__layaOverlay` with the methods the server drives (see BrowserOverlay).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OverlayClientConfig {
  css: string;
  activities: Record<string, { label: string; icon: string; tone: string }>;
  verbs: ReadonlyArray<readonly [string, string]>;
  icons: Record<string, string>;
  toastActivity: Record<string, string>;
  motion: {
    cursor: { min: number; max: number; perPx: number };
    narration: { perChar: number; max: number };
  };
  options: {
    typingEffect: boolean;
    waitCountdown: boolean;
    debugSeeElements: boolean;
    activityLog: boolean;
    cursorTrail: number;
  };
}

export function overlayClient(cfg: OverlayClientConfig): void {
  const w = window as any;
  if (w.__layaOverlayInstalled) return;
  w.__layaOverlayInstalled = true;

  const HOST_ID = "__laya_overlay__";
  const OPTS = cfg.options;
  const reduced = (): boolean =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  const el: Record<string, HTMLElement> = {};

  let state = "ready"; // thinking | acting | success | error | uncertain | ready
  let status = "";
  let activity = "ready";
  let cursorAt: { x: number; y: number } | null = null;
  let cursorAnim: Animation | null = null;
  let chipAnim: Animation | null = null;
  let narrationTimer = 0;
  let runActive = false;
  let keysExpectedUntil = 0;
  let logCount = 0;

  // --- tiny DOM helpers ----------------------------------------------------------------
  function h(tag: string, cls?: string, parent?: Node | null): HTMLElement {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }
  function icon(name: string): string {
    return (
      "<svg class='i' viewBox='0 0 24 24' fill='none' stroke='currentColor' aria-hidden='true'>" +
      (cfg.icons[name] || cfg.icons.info) +
      "</svg>"
    );
  }
  function activityOf(id: string): { label: string; icon: string; tone: string } {
    return cfg.activities[id] || cfg.activities.working!;
  }
  /** Narration text -> activity id via the shared verb table. */
  function inferActivity(text: string, fallback: string): string {
    const t = String(text || "").trim().toLowerCase();
    for (const [pattern, id] of cfg.verbs) {
      if (new RegExp(pattern).test(t)) return id;
    }
    return fallback;
  }
  /** "Clicking Sign in" under the "Clicking..." label reads as "Sign in". */
  function stripVerb(text: string, label: string): string {
    const words = String(text || "").trim().split(/\s+/);
    const stem = label.toLowerCase().slice(0, 4);
    if (words.length > 1 && stem.length === 4 && words[0]!.toLowerCase().startsWith(stem)) {
      let rest = words.slice(1);
      if (rest.length > 1 && /^(?:into|in|on|to|the)$/i.test(rest[0]!)) rest = rest.slice(1);
      return rest.join(" ").replace(/\u2026$/, "");
    }
    return String(text || "").replace(/\u2026$/, "");
  }

  // --- mount -------------------------------------------------------------------------------
  function ensure(): boolean {
    if (host && host.isConnected && shadow) return true;
    const parent = document.documentElement;
    if (!parent) return false;
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("data-theme", "light");
    host.setAttribute("data-tone", "accent");
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = cfg.css;
    shadow.appendChild(style);
    build(shadow);
    parent.appendChild(host);
    renderPill(false);
    layout();
    return true;
  }

  function build(root: ShadowRoot): void {
    el.aura = h("div", "aura", root);
    el.aura.setAttribute("data-laya-aura", "1");
    el.seen = h("div", "seen", root);
    el.target = h("div", "target", root);
    for (const c of ["tl", "tr", "bl", "br"]) h("span", "h " + c, el.target);
    el.focus = h("div", "focus", root);
    el.caret = h("div", "caret", root);
    el.scrollbar = h("div", "scrollbar glass", root);
    el.thumb = h("div", "thumb", el.scrollbar);
    el.scrollDir = h("div", "dir glass", el.scrollbar);
    el.toasts = h("div", "toasts", root);
    el.log = h("div", "log glass", root);
    el.logHead = h("div", "head", el.log);
    el.logHead.innerHTML = "<span>Activity</span>";
    el.logCount = h("span", "count", el.logHead);
    el.logBody = h("div", "body", el.log);
    el.log.style.display = "none"; // shown with its first entry

    // The status pill. Order: icon, label, narration, progress, meter, grip.
    el.hud = h("div", "hud glass", root);
    el.hud.setAttribute("data-laya-hud", "1");
    el.icon = h("div", "icon", el.hud);
    el.label = h("div", "label", el.hud);
    el.narration = h("div", "narration", el.hud);
    el.progress = h("div", "progress", el.hud);
    el.progress.innerHTML =
      "<svg class='ring' viewBox='0 0 24 24'><circle class='track' cx='12' cy='12' r='9'/>" +
      "<circle class='value' cx='12' cy='12' r='9' stroke-dasharray='56.55' stroke-dashoffset='56.55'/></svg>";
    el.progressText = h("span", "progress-text", el.progress);
    el.meter = h("div", "meter", el.hud);
    el.meter.setAttribute("data-laya-meter", "1");
    el.grip = h("div", "grip", el.hud);
    for (let i = 0; i < 6; i++) h("i", "", el.grip);

    el.takeover = h("div", "takeover", root);
    el.takeover.innerHTML = "<span class='live'></span><span class='t'>Laya is in control</span><kbd>Esc</kbd><span>to take over</span>";
    el.countdown = h("div", "countdown glass", root);

    el.cursor = h("div", "cursor", root);
    el.cursor.innerHTML =
      "<svg viewBox='0 0 28 28'><path class='arrow' d='M5 3.2 L5 22.4 L10.1 17.6 L13.4 24.6 L16.8 23.1 L13.6 16.2 L20.6 15.7 Z'/>" +
      "<path class='shine' d='M6.6 6.6 L6.6 18.6 L9.9 15.5 Z'/></svg>";
    el.chip = h("div", "chip glass", root);
    el.chipIcon = h("span", "", el.chip);
    el.chipText = h("span", "text", el.chip);
    el.dots = h("span", "dots", el.chip);
    el.dots.innerHTML = "<i></i><i></i><i></i>";

    el.grip.addEventListener("pointerdown", onGripDown);
    el.grip.addEventListener("pointermove", onGripMove);
    el.grip.addEventListener("pointerup", onGripUp);
    el.grip.addEventListener("pointercancel", onGripUp);
  }

  // --- theme: glass/ink pairing from what is actually behind the pill ------------------------
  function rgbOf(value: string): [number, number, number, number] | null {
    const open = value.indexOf("(");
    const close = value.lastIndexOf(")");
    if (open < 0 || close < open) return null;
    const p = value.slice(open + 1, close).split(/[ ,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
  }
  function hexColors(text: string): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (const m of text.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []) {
      const x = m.length === 4 ? m.slice(1).split("").map((c) => c + c).join("") : m.slice(1);
      const n = parseInt(x, 16);
      out.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
    }
    let i = text.indexOf("rgb");
    while (i >= 0) {
      const c = rgbOf(text.slice(i, text.indexOf(")", i) + 1));
      if (c) out.push([c[0], c[1], c[2]]);
      i = text.indexOf("rgb", i + 3);
    }
    return out;
  }
  function backdrop(): [number, number, number] | null {
    if (!el.hud || typeof document.elementsFromPoint !== "function") return null;
    const box = el.hud.getBoundingClientRect();
    const x = Math.min(Math.max(box.left + 16, 1), innerWidth - 1);
    const y = Math.min(Math.max(box.top + box.height / 2, 1), innerHeight - 1);
    let node = document.elementsFromPoint(x, y).find((n) => n !== host) as Element | undefined;
    if (!node) return [255, 255, 255];
    if (/^(IMG|VIDEO|CANVAS|IFRAME)$/.test(node.tagName)) return null;
    const layers: Array<[number, number, number, number]> = [];
    while (node) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        if (cs.backgroundImage.indexOf("url(") >= 0) return null;
        const cols = hexColors(cs.backgroundImage);
        if (!cols.length) return null;
        const avg = cols.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
        layers.push([avg[0] / cols.length, avg[1] / cols.length, avg[2] / cols.length, 1]);
        break;
      }
      const c = rgbOf(cs.backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] >= 0.999) break;
      node = node.parentElement as Element;
    }
    let acc: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const f = layers[i]!;
      acc = [0, 1, 2].map((k) => f[k]! * f[3] + acc[k]! * (1 - f[3])) as [number, number, number];
    }
    return acc;
  }
  function luminance(c: [number, number, number]): number {
    const f = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function applyTheme(): void {
    if (!host) return;
    const b = backdrop();
    host.setAttribute("data-theme", b && luminance(b) < 0.42 ? "dark" : "light");
    host.setAttribute("data-backdrop", b ? b.map((v) => Math.round(v)).join(",") : "unknown");
  }

  // --- layout: pill (top centre unless dragged), then takeover chip, then countdown ----------
  let pinned: { x: number; y: number } | null = null;
  function layout(): void {
    if (!el.hud) return;
    const box = el.hud.getBoundingClientRect();
    const want = pinned || { x: (innerWidth - box.width) / 2, y: 16 };
    const left = Math.round(Math.max(8, Math.min(Math.max(8, innerWidth - box.width - 8), want.x)));
    const top = Math.round(Math.max(8, Math.min(Math.max(8, innerHeight - box.height - 8), want.y)));
    el.hud.style.left = left + "px";
    el.hud.style.top = top + "px";
    // The countdown rides under the pill; the takeover chip sits at the bottom centre, clear of
    // the page's own controls (it used to sit on top of forms right under the pill).
    const cd = el.countdown!;
    if (getComputedStyle(cd).display !== "none") {
      const nb = cd.getBoundingClientRect();
      cd.style.left = Math.round(Math.max(8, left + box.width / 2 - nb.width / 2)) + "px";
      cd.style.top = top + box.height + 8 + "px";
    }
    const tk = el.takeover!;
    if (getComputedStyle(tk).display !== "none") {
      const nb = tk.getBoundingClientRect();
      tk.style.left = Math.round(Math.max(8, (innerWidth - nb.width) / 2)) + "px";
      tk.style.top = Math.round(innerHeight - nb.height - 18) + "px";
    }
    applyTheme();
  }

  // --- drag the pill by its grip ------------------------------------------------------------
  let drag: { dx: number; dy: number } | null = null;
  function onGripDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = el.hud!.getBoundingClientRect();
    drag = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    el.grip!.classList.add("dragging");
    try { el.grip!.setPointerCapture(e.pointerId); } catch { /* best effort */ }
  }
  function onGripMove(e: PointerEvent): void {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    place(e.clientX - drag.dx, e.clientY - drag.dy);
  }
  function onGripUp(e: PointerEvent): void {
    if (!drag) return;
    e.stopPropagation();
    drag = null;
    el.grip!.classList.remove("dragging");
    try { el.grip!.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (pinned) {
      try { if (typeof w.__layaReportPos === "function") w.__layaReportPos(pinned); } catch { /* best effort */ }
    }
  }
  function place(x: number, y: number): void {
    const box = el.hud!.getBoundingClientRect();
    pinned = {
      x: Math.round(Math.max(8, Math.min(Math.max(8, innerWidth - box.width - 8), Number(x) || 0))),
      y: Math.round(Math.max(8, Math.min(Math.max(8, innerHeight - box.height - 8), Number(y) || 0))),
    };
    api.__pos = pinned;
    layout();
  }

  // --- the pill ---------------------------------------------------------------------------
  function toneFor(): string {
    if (state === "success") return "done";
    if (state === "error") return "error";
    if (state === "uncertain" || activity === "paused" || activity === "asking") return "uncertain";
    return "accent";
  }
  function resolveActivity(): string {
    if (state === "success") return "done";
    if (state === "error") return "error";
    if (!runActive && api.__released) return "paused";
    if (state === "uncertain") return inferActivity(status, "uncertain") === "asking" ? "asking" : "uncertain";
    if (state === "thinking") return inferActivity(status, "thinking");
    if (state === "acting") return inferActivity(status, "working");
    return status ? inferActivity(status, "working") : "ready";
  }
  function renderPill(animate: boolean): void {
    if (!el.hud) return;
    const next = resolveActivity();
    const changed = next !== activity;
    activity = next;
    const a = activityOf(activity);
    el.icon!.innerHTML = icon(a.icon);
    el.label!.textContent = a.label;
    el.hud.className = "hud glass " + activity + (changed && animate ? " pop" : "");
    el.hud.setAttribute("data-activity", activity);
    host!.setAttribute("data-tone", toneFor());
    if (activity === "done") {
      const value = el.progress!.querySelector(".value") as SVGCircleElement | null;
      if (value) value.style.strokeDashoffset = "0";
    }
    const text = activity === "ready" && !status ? "Ready" : stripVerb(status, a.label);
    reveal(el.narration!, text, animate);
  }
  /** Live narration: reveal the new line progressively (bounded), never slower than max. */
  function reveal(node: HTMLElement, text: string, animate: boolean): void {
    clearInterval(narrationTimer);
    node.setAttribute("data-text", text);
    if (!animate || reduced() || !text || node.textContent === text) {
      node.textContent = text;
      layout();
      return;
    }
    const steps = Math.max(1, Math.ceil(Math.min(cfg.motion.narration.max, text.length * cfg.motion.narration.perChar) / 16));
    const per = Math.ceil(text.length / steps);
    let shown = 0;
    node.textContent = "";
    narrationTimer = setInterval(() => {
      shown = Math.min(text.length, shown + per);
      node.textContent = text.slice(0, shown);
      layout(); // the pill grows as the line types in; keep it centred
      if (shown >= text.length) clearInterval(narrationTimer);
    }, 16) as unknown as number;
    layout();
  }

  // --- cursor + action chip -----------------------------------------------------------------
  function glide(node: HTMLElement, from: { x: number; y: number } | null, to: { x: number; y: number }, dx: number, dy: number, ms: number): Animation | null {
    const end = "translate(" + (to.x + dx) + "px," + (to.y + dy) + "px)";
    node.style.transform = end;
    if (!from || ms <= 0 || reduced() || typeof node.animate !== "function") return null;
    // A slight arc (perpendicular to the path) reads as a hand moving, not a teleport.
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const bow = Math.min(60, len * 0.12);
    const nx = -(to.y - from.y) / len;
    const ny = (to.x - from.x) / len;
    return node.animate(
      [
        { transform: "translate(" + (from.x + dx) + "px," + (from.y + dy) + "px)" },
        { transform: "translate(" + (mx + nx * bow + dx) + "px," + (my + ny * bow + dy) + "px)", offset: 0.5 },
        { transform: end },
      ],
      { duration: ms, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }
  function moveTo(x: number, y: number, caption: string, trail: number): number {
    const to = { x: Math.round(x), y: Math.round(y) };
    const from = cursorAt;
    const dist = from ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
    const m = cfg.motion.cursor;
    const ms = from && dist > 2 ? Math.round(Math.max(m.min, Math.min(m.max, m.min + dist * m.perPx))) : 0;
    el.cursor!.classList.add("on");
    el.cursor!.setAttribute("data-x", String(to.x));
    el.cursor!.setAttribute("data-y", String(to.y));
    cursorAnim?.cancel();
    cursorAnim = glide(el.cursor!, from, to, 0, 0, ms);
    if (from && trail > 0 && dist > 24) drawTrail(from, to, trail, ms);
    cursorAt = to;
    showChip(caption, to, from, ms);
    return ms;
  }
  function drawTrail(from: { x: number; y: number }, to: { x: number; y: number }, n: number, ms: number): void {
    for (let i = 1; i <= n; i++) {
      const f = i / (n + 1);
      const dot = h("div", "trail", shadow);
      dot.style.left = from.x + (to.x - from.x) * f + "px";
      dot.style.top = from.y + (to.y - from.y) * f + "px";
      dot.style.opacity = String(0.45 * (1 - f) + 0.1);
      setTimeout(() => { dot.style.opacity = "0"; }, (ms * f) | 0);
      setTimeout(() => dot.remove(), ((ms * f) | 0) + 560);
    }
  }
  function showChip(caption: string, to: { x: number; y: number }, from: { x: number; y: number } | null, ms: number): void {
    if (!caption) {
      el.chip!.classList.remove("on");
      return;
    }
    const act = inferActivity(caption, "working");
    const a = activityOf(act);
    el.chipIcon!.innerHTML = icon(a.icon);
    el.chipText!.textContent = caption;
    el.dots!.classList.toggle("on", act === "typing" || act === "thinking");
    el.chip!.setAttribute("data-activity", act);
    el.chip!.classList.add("on");
    // Keep the chip on screen: flip to the cursor's left when it would overflow the right edge.
    const width = el.chip!.getBoundingClientRect().width || 120;
    const dx = to.x + 22 + width > innerWidth - 8 ? -width - 14 : 22;
    const dy = to.y + 50 > innerHeight ? -34 : 16;
    chipAnim?.cancel();
    chipAnim = glide(el.chip!, from, to, dx, dy, ms);
  }
  function pressAt(x: number, y: number): void {
    const ring = h("div", "ripple", shadow);
    ring.style.left = x + "px";
    ring.style.top = y + "px";
    ring.innerHTML = "<i></i><i></i><b></b>";
    setTimeout(() => ring.remove(), 900);
    el.cursor!.classList.remove("press");
    void el.cursor!.offsetWidth;
    el.cursor!.classList.add("press");
    if (el.target!.classList.contains("on")) {
      el.target!.classList.remove("flash");
      void el.target!.offsetWidth;
      el.target!.classList.add("flash");
    }
  }
  function select(rect: { x: number; y: number; width: number; height: number }): void {
    const t = el.target!;
    t.classList.add("on");
    t.style.left = rect.x - 4 + "px";
    t.style.top = rect.y - 4 + "px";
    t.style.width = rect.width + 8 + "px";
    t.style.height = rect.height + 8 + "px";
  }
  function refElement(ref: string): Element | null {
    return document.querySelector('[data-laya-ref="' + String(ref).replace(/"/g, "") + '"]');
  }
  function rectOf(node: Element): { x: number; y: number; width: number; height: number } {
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  /** A blinking caret at the end of the field's current text. */
  function caretIn(node: Element | null): void {
    const c = el.caret!;
    if (!node || !(node instanceof HTMLElement)) {
      c.classList.remove("on");
      return;
    }
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const value = "value" in node ? String((node as HTMLInputElement).value || "") : node.textContent || "";
    let width = 0;
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      if (ctx) {
        ctx.font = cs.font;
        width = ctx.measureText(value).width;
      }
    } catch { /* measurement is cosmetic */ }
    const padLeft = parseFloat(cs.paddingLeft) || 6;
    const lineH = Math.min(r.height - 6, (parseFloat(cs.fontSize) || 14) * 1.25);
    c.style.left = Math.min(r.right - 6, r.left + padLeft + width + 1) + "px";
    c.style.top = r.top + (r.height - lineH) / 2 + "px";
    c.style.height = Math.max(10, lineH) + "px";
    c.classList.add("on");
  }

  // --- activity log ---------------------------------------------------------------------------
  function logLine(line: string): void {
    if (!OPTS.activityLog || !el.logBody) return;
    const act = inferActivity(line, "working");
    const a = activityOf(act);
    const entry = h("div", "entry tone-" + a.tone, el.logBody);
    entry.innerHTML = icon(a.icon);
    h("span", "text", entry).textContent = line;
    const time = h("time", "", entry);
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    while (el.logBody.childNodes.length > 60) el.logBody.firstChild!.remove();
    logCount += 1;
    el.log!.style.display = "";
    el.logCount!.textContent = logCount + (logCount === 1 ? " step" : " steps");
  }

  // --- takeover: Esc hands control back to the human ----------------------------------------
  addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !e.isTrusted || !runActive) return;
      if (Date.now() < keysExpectedUntil) return; // Laya's own key press, not the user's
      api.__released = true;
      runActive = false;
      el.takeover?.classList.remove("on");
      state = "ready";
      status = "Laya stopped. Your turn.";
      renderPill(true);
    },
    true,
  );

  const api: Record<string, any> = {
    enabled: true,
    __pos: null as { x: number; y: number } | null,
    __pinned: null as { x: number; y: number } | null,
    __fresh: true,
    __released: false,
    __lastCursor: null as { x: number; y: number } | null,
    get host(): HTMLElement | null {
      return host;
    },
    setStatus(text: unknown): void {
      if (!ensure()) return;
      status = text == null ? "" : String(text);
      renderPill(true);
    },
    setState(next: unknown): void {
      if (!ensure()) return;
      state = ["thinking", "acting", "success", "error", "uncertain"].includes(String(next)) ? String(next) : "thinking";
      renderPill(true);
    },
    setPosition(x: unknown, y: unknown): void {
      if (x == null || y == null || !ensure()) return;
      place(Number(x), Number(y));
    },
    progress(step: unknown, max: unknown): void {
      if (!ensure()) return;
      const n = Number(step) || 0;
      const m = Number(max) || 0;
      el.progress!.classList.toggle("on", m > 0);
      el.progress!.setAttribute("data-value", m > 0 ? String(n / m) : "");
      el.progressText!.textContent = m > 0 ? n + "/" + m : "";
      const value = el.progress!.querySelector(".value") as SVGCircleElement | null;
      if (value) value.style.strokeDashoffset = String(56.55 * (1 - Math.max(0, Math.min(1, m > 0 ? n / m : 0))));
      layout();
    },
    meter(steps: unknown, escalations: unknown, tokens: unknown): void {
      if (!ensure()) return;
      const t = Number(tokens) || 0;
      const tok = t >= 1000 ? (t / 1000).toFixed(1) + "k" : String(t);
      el.meter!.classList.add("on");
      el.meter!.textContent = (Number(steps) || 0) + " steps \u00B7 " + (Number(escalations) || 0) + " LLM \u00B7 " + tok + " tok";
      layout();
    },
    beginRun(): void {
      if (!ensure()) return;
      runActive = true;
      api.__released = false;
      el.takeover!.classList.add("on");
      logCount = 0;
      if (el.logBody) el.logBody.textContent = "";
      if (el.logCount) el.logCount.textContent = "";
      if (el.log) el.log.style.display = "none";
      layout();
    },
    endRun(): void {
      if (!ensure()) return;
      runActive = false;
      el.takeover!.classList.remove("on");
      el.chip!.classList.remove("on");
      el.caret!.classList.remove("on");
      el.focus!.classList.remove("on");
      el.target!.classList.remove("on", "flash");
      layout();
    },
    /** Laya is about to press keys itself: an Escape in this window is not a takeover. */
    expectKeys(ms: unknown): void {
      keysExpectedUntil = Date.now() + Math.max(0, Math.min(5000, Number(ms) || 0));
    },
    showCursor(x: unknown, y: unknown): void {
      if (!ensure()) return;
      const to = { x: x == null ? Math.round(innerWidth / 2) : Number(x), y: y == null ? Math.round(innerHeight / 2) : Number(y) };
      if (!cursorAt) {
        cursorAt = to;
        el.cursor!.style.transform = "translate(" + to.x + "px," + to.y + "px)";
        el.cursor!.setAttribute("data-x", String(to.x));
        el.cursor!.setAttribute("data-y", String(to.y));
      }
      el.cursor!.classList.add("on");
      api.__lastCursor = cursorAt;
    },
    sessionFrame(on: unknown): void {
      if (!ensure()) return;
      el.aura!.classList.toggle("off", !on);
    },
    moveCursor(x: unknown, y: unknown, caption: unknown, trailLength: unknown): number {
      if (!ensure()) return 0;
      const trail = trailLength == null ? OPTS.cursorTrail : Number(trailLength) || 0;
      const ms = moveTo(Number(x) || 0, Number(y) || 0, caption == null ? "" : String(caption), Math.max(0, Math.min(24, trail)));
      api.__lastCursor = cursorAt;
      return ms;
    },
    ripple(x: unknown, y: unknown): void {
      if (!ensure()) return;
      pressAt(Number(x) || 0, Number(y) || 0);
    },
    spotlight(rect: any): void {
      if (!ensure() || !rect) return;
      select(rect);
    },
    hideSpotlight(): void {
      if (!shadow) return;
      el.target!.classList.remove("on", "flash");
      el.focus!.classList.remove("on");
      el.caret!.classList.remove("on");
      el.chip!.classList.remove("on");
    },
    toast(message: unknown, kind: unknown): void {
      if (!ensure()) return;
      const act = cfg.toastActivity[String(kind)] || "working";
      const a = activityOf(act === "working" ? inferActivity(String(message), "working") : act);
      const t = h("div", "toast glass tone-" + a.tone, el.toasts);
      t.setAttribute("data-kind", String(kind || "info"));
      t.innerHTML = icon(a.icon);
      h("span", "", t).textContent = String(message);
      while (el.toasts!.childNodes.length > 3) el.toasts!.firstChild!.remove();
      setTimeout(() => {
        t.classList.add("out");
        setTimeout(() => t.remove(), 260);
      }, 3200);
    },
    log(line: unknown): void {
      if (!ensure()) return;
      logLine(String(line));
    },
    countdown(ms: unknown): void {
      if (!OPTS.waitCountdown || !ensure()) return;
      const total = Number(ms) || 0;
      const node = el.countdown!;
      if (total <= 0) {
        node.classList.remove("on");
        layout();
        return;
      }
      node.classList.add("on");
      const start = Date.now();
      const tick = (): void => {
        const left = Math.max(0, total - (Date.now() - start));
        node.innerHTML = icon("dashedCircle") + "<span>Waiting " + (left / 1000).toFixed(1) + "s</span>";
        if (left > 0) requestAnimationFrame(tick);
        else {
          node.classList.remove("on");
          layout();
        }
      };
      tick();
      layout();
    },
    scrollIndicator(direction: unknown, pos: unknown): void {
      if (!ensure()) return;
      const bar = el.scrollbar!;
      const doc = document.documentElement;
      const total = Math.max(1, doc.scrollHeight);
      const frac = Math.min(1, innerHeight / total);
      const top = Math.min(1 - frac, scrollY / total);
      el.thumb!.style.height = Math.max(18, 116 * frac) + "px";
      el.thumb!.style.transform = "translateY(" + Math.round(116 * top) + "px)";
      const up = direction === "up";
      el.scrollDir!.innerHTML = (up ? "<span style='display:inline-block;transform:rotate(180deg)'>" + icon("arrowDown") + "</span>" : icon("arrowDown")) + "<span>Scrolling" + (pos === "" || pos == null ? "" : " \u00B7 " + String(pos) + "px") + "</span>";
      bar.setAttribute("data-direction", String(direction || "down"));
      bar.classList.add("on");
      clearTimeout((bar as any).__t);
      (bar as any).__t = setTimeout(() => bar.classList.remove("on"), 1400);
    },
    showSeenElements(): void {
      if (!OPTS.debugSeeElements || !ensure()) return;
      api.hideSeenElements();
      for (const node of Array.from(document.querySelectorAll("[data-laya-ref]"))) {
        const r = node.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const box = h("div", "box", el.seen);
        box.style.cssText = "left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
        const tag = h("div", "tag", el.seen);
        tag.style.cssText = "left:" + r.left + "px;top:" + Math.max(0, r.top - 13) + "px";
        tag.textContent = "[ref=" + node.getAttribute("data-laya-ref") + "]";
      }
    },
    hideSeenElements(): void {
      if (el.seen) el.seen.textContent = "";
    },
    refRect(ref: unknown): { x: number; y: number; width: number; height: number } | null {
      const node = refElement(String(ref));
      return node ? rectOf(node) : null;
    },
    /** Aim the cursor at a ref, select it, and caption the action. Returns the rect or null. */
    focus(ref: unknown, caption: unknown): { x: number; y: number; width: number; height: number; arriveMs: number } | null {
      if (!ensure()) return null;
      const node = refElement(String(ref));
      if (!node) return null;
      const rect = rectOf(node);
      const text = caption == null ? "" : String(caption);
      const arriveMs = api.moveCursor(rect.x + Math.min(rect.width / 2, 40), rect.y + rect.height / 2, text);
      select(rect);
      const act = inferActivity(text, "working");
      if (act === "typing") caretIn(node);
      else el.caret!.classList.remove("on");
      const f = el.focus!;
      if (act === "inspecting" || act === "selecting") {
        f.style.left = rect.x + rect.width / 2 + "px";
        f.style.top = rect.y + rect.height / 2 + "px";
        f.classList.add("on");
      } else f.classList.remove("on");
      return { ...rect, arriveMs };
    },
    batch(ops: unknown): void {
      if (!Array.isArray(ops)) return;
      for (const op of ops) {
        if (!Array.isArray(op) || typeof op[0] !== "string" || op[0] === "batch") continue;
        const fn = api[op[0]];
        if (typeof fn !== "function") continue;
        try { fn.apply(api, op.slice(1)); } catch { /* one bad entry never aborts the batch */ }
      }
    },
  };

  w.__layaOverlay = api;
  addEventListener("resize", layout);
  addEventListener("scroll", () => requestAnimationFrame(applyTheme), { passive: true });
  if (!ensure()) document.addEventListener("DOMContentLoaded", () => ensure(), { once: true });
}
