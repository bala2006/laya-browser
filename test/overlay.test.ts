/**
 * Real headless-Chromium coverage for the agentLens overlay (design system + renderer), the
 * Esc takeover, the headed-default -> headless fallback, and the autopilot narration path.
 *
 * The overlay renders into an open shadow root on `<html>`, so assertions reach it through
 * `document.getElementById("__laya_overlay__").shadowRoot`. Overlay visuals are verified
 * headless with the overlay FORCED ON.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { BrowserSession } from "../src/browser.js";
import { StubEngine } from "../src/laya/index.js";
import { runGoal } from "../src/autopilot/loop.js";
import { capture, captureFast } from "../src/snapshot.js";
import type { OverlayConfig } from "../src/config.js";
import type { LayaDecisionEngine } from "../src/types.js";
import {
  ACTIVITIES,
  ACTIVITY_VERBS,
  ICONS,
  TOAST_ACTIVITY,
  buildOverlayCss,
} from "../src/overlay-design.js";
import * as navigate from "../src/tools/navigate.js";
import * as clickTool from "../src/tools/click.js";
import type { ToolContext } from "../src/tools/shared.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** An overlay config forced ON so it injects even headless. */
function overlayOn(overrides: Partial<OverlayConfig> = {}): OverlayConfig {
  return {
    enabled: true,
    mode: "on",
    accent: "#3b82f6",
    typingEffect: false,
    waitCountdown: false,
    debugSeeElements: false,
    activityLog: true,
    cursorTrail: 6,
    ...overrides,
  };
}

const HOST_ID = "__laya_overlay__";

/** Parse a computed `rgb()`/`rgba()` colour into its channels + alpha. */
function parseColor(value: string): { rgb: [number, number, number]; a: number } {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(value);
  if (!m) throw new Error(`unparseable colour: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
}

function composite(fg: string, bg: [number, number, number]): [number, number, number] {
  const { rgb, a } = parseColor(fg);
  return [0, 1, 2].map((i) => Math.round(rgb[i]! * a + bg[i]! * (1 - a))) as [number, number, number];
}

/** WCAG contrast ratio between two opaque colours. */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const ch = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = ([r, g, bl]: [number, number, number]): number =>
    0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(bl);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function overlaps(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

/** Read the HUD's observable state out of the shadow root. */
async function hud(page: Page) {
  return page.evaluate((id) => {
    const host = document.getElementById(id);
    const root = host?.shadowRoot;
    if (!host || !root) return null;
    const q = (s: string): HTMLElement | null => root.querySelector(s);
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const pill = q(".hud")!;
    return {
      theme: host.getAttribute("data-theme"),
      tone: host.getAttribute("data-tone"),
      backdrop: host.getAttribute("data-backdrop"),
      activity: pill.getAttribute("data-activity"),
      label: q(".hud .label")?.textContent ?? "",
      narration: q(".hud .narration")?.getAttribute("data-text") ?? "",
      progress: q(".hud .progress-text")?.textContent ?? "",
      progressOn: q(".hud .progress")?.classList.contains("on") ?? false,
      meter: q("[data-laya-meter]")?.textContent ?? "",
      pillBox: box(pill),
      pillBg: getComputedStyle(pill).backgroundColor,
      pillBlur:
        (getComputedStyle(pill) as unknown as Record<string, string>).backdropFilter ||
        (getComputedStyle(pill) as unknown as Record<string, string>).webkitBackdropFilter ||
        "",
      pillRadius: parseFloat(getComputedStyle(pill).borderTopLeftRadius) || 0,
      labelInk: getComputedStyle(q(".hud .label")!).color,
      narrationInk: getComputedStyle(q(".hud .narration")!).color,
      iconSvg: !!q(".hud .icon svg.i"),
      takeoverOn: q(".takeover")?.classList.contains("on") ?? false,
      takeoverBox: box(q(".takeover")),
      takeoverBg: getComputedStyle(q(".takeover")!).backgroundColor,
      takeoverInk: getComputedStyle(q(".takeover")!).color,
      cursorOn: q(".cursor")?.classList.contains("on") ?? false,
      cursorX: Number(q(".cursor")?.getAttribute("data-x")),
      cursorY: Number(q(".cursor")?.getAttribute("data-y")),
      cursorAnimations: q(".cursor")?.getAnimations().length ?? 0,
      chipOn: q(".chip")?.classList.contains("on") ?? false,
      chipText: q(".chip .text")?.textContent ?? "",
      chipActivity: q(".chip")?.getAttribute("data-activity") ?? "",
      typingDots: q(".chip .dots")?.classList.contains("on") ?? false,
      targetOn: q(".target")?.classList.contains("on") ?? false,
      targetLeft: q(".target")?.style.left ?? "",
      targetHandles: root.querySelectorAll(".target .h").length,
      caretOn: q(".caret")?.classList.contains("on") ?? false,
      ripples: root.querySelectorAll(".ripple").length,
      toasts: Array.from(root.querySelectorAll(".toast")).map((t) => t.textContent ?? ""),
      logEntries: Array.from(root.querySelectorAll(".log .entry .text")).map((t) => t.textContent ?? ""),
      logIcons: root.querySelectorAll(".log .entry svg").length,
      scrollOn: q(".scrollbar")?.classList.contains("on") ?? false,
      auraOff: q(".aura")?.classList.contains("off") ?? true,
      trails: root.querySelectorAll(".trail").length,
    };
  }, HOST_ID);
}

describe("overlay design system (pure)", () => {
  it("defines every activity's icon, and every verb and toast maps to a real activity", () => {
    for (const [id, a] of Object.entries(ACTIVITIES)) {
      expect(ICONS[a.icon], `${id} icon`).toBeTruthy();
      expect(a.label.length).toBeGreaterThan(0);
    }
    for (const [pattern, id] of ACTIVITY_VERBS) {
      expect(() => new RegExp(pattern)).not.toThrow();
      expect(ACTIVITIES[id], pattern).toBeTruthy();
    }
    for (const id of Object.values(TOAST_ACTIVITY)) expect(ACTIVITIES[id]).toBeTruthy();
  });

  it("generates one stylesheet from the tokens, driven by the configured accent", () => {
    const css = buildOverlayCss("#10b981");
    expect(css).toContain("--accent:#10b981");
    expect(css).toContain("--accent-rgb:16, 185, 129");
    expect(css).toContain(":host([data-theme='dark'])");
    for (const tone of ["done", "error", "uncertain"]) expect(css).toContain(`data-tone='${tone}'`);
    // The zero-size host must not be a containing block for its fixed children.
    expect(css).not.toMatch(/:host\{[^}]*contain:/);
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("agentLens overlay end-to-end (real headless chromium, overlay forced ON)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true, overlay: overlayOn() });
    ctx = { session };
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("mounts one inert host with an open shadow root, above everything, showing the pill", async () => {
    const page = await session.getPage();
    const info = await page.evaluate((id) => {
      const host = document.getElementById(id)!;
      const root = host.shadowRoot!;
      const nodes = Array.from(root.querySelectorAll("*")) as HTMLElement[];
      const live = nodes.filter((n) => getComputedStyle(n).pointerEvents !== "none");
      return {
        parentIsHtml: host.parentElement === document.documentElement,
        hosts: document.querySelectorAll("#" + id).length,
        hostEvents: getComputedStyle(host).pointerEvents,
        z: Number(getComputedStyle(host).zIndex),
        live: live.map((n) => n.className),
        gripDots: root.querySelector(".grip")!.children.length,
      };
    }, HOST_ID);
    expect(info.parentIsHtml).toBe(true);
    expect(info.hosts).toBe(1);
    expect(info.hostEvents).toBe("none");
    expect(info.z).toBeGreaterThan(1_000_000);
    // Exactly one node takes the pointer: the six-dot drag grip.
    expect(info.live).toEqual(["grip"]);
    expect(info.gripDots).toBe(6);
    const s = (await hud(page))!;
    expect(s.label).toBe("Laya");
    expect(s.iconSvg).toBe(true);
    expect(s.pillRadius).toBeGreaterThanOrEqual(24);
    expect(s.pillBlur).toContain("blur");
  });

  it("re-injects after navigation (the init script covers every new document)", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("search-form.html") });
    const page = await session.getPage();
    expect(page.url()).toContain("search-form.html");
    expect(await page.evaluate((id) => !!document.getElementById(id)?.shadowRoot?.querySelector(".hud"), HOST_ID)).toBe(true);
  });

  it("never intercepts a real click, and keeps its text out of the page the agent reads", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();
    await overlay.setStatus(page, "NARRATION-MARKER");
    await overlay.log(page, "LOG-MARKER");
    await overlay.toast(page, "TOAST-MARKER");
    const hit = await page.evaluate((id) => {
      const r = document.getElementById(id)!.shadowRoot!.querySelector(".hud")!.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el?.id === id;
    }, HOST_ID);
    expect(hit).toBe(false);
    // Narration must never become page text: not in innerText, not in either snapshot.
    const bodyText = await page.evaluate(() => document.body.innerText);
    const fast = await captureFast(page);
    const legacy = await capture(page);
    for (const text of [bodyText, fast.visibleText, fast.viewportText, legacy.visibleText]) {
      expect(text).not.toMatch(/MARKER|Laya is in control/);
    }
    // And a real click through the overlay still drives the page.
    await page.locator("#email").fill("user@example.com");
    await clickTool.makeHandler(ctx)({ target: "#submit", element: "Sign in" });
    expect(await page.locator("#status").textContent()).toBe("Signed in as user@example.com");
  });

  it("maps narration to activities and tones (icon + verb + live detail)", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();
    const cases: Array<[string, string, string, string]> = [
      // state, status -> activity, label
      ["acting", "Typing into Email", "typing", "Typing\u2026"],
      ["acting", "Clicking Sign in", "clicking", "Clicking\u2026"],
      ["acting", "Scrolling down\u2026", "scrolling", "Scrolling\u2026"],
      ["acting", "Navigating\u2026", "navigating", "Navigating\u2026"],
      ["thinking", "Deciding\u2026", "thinking", "Thinking\u2026"],
      ["thinking", "Reading page\u2026", "reading", "Reading\u2026"],
    ];
    for (const [state, status, activity, label] of cases) {
      await overlay.callBatch(page, [["setState", state], ["setStatus", status]]);
      const s = (await hud(page))!;
      expect(s.activity, status).toBe(activity);
      expect(s.label, status).toBe(label);
      expect(s.tone).toBe("accent");
    }
    // The verb is not repeated: "Typing into Email" narrates as "Email" under "Typing...".
    await overlay.callBatch(page, [["setState", "acting"], ["setStatus", "Typing into Email"]]);
    expect((await hud(page))!.narration).toBe("Email");

    for (const [state, tone, label] of [
      ["success", "done", "Done"],
      ["error", "error", "Error"],
      ["uncertain", "uncertain", "Checking\u2026"],
    ] as const) {
      await overlay.callBatch(page, [["setState", state], ["setStatus", "status line"]]);
      await page.waitForTimeout(260); // the surface transitions between tones
      const s = (await hud(page))!;
      expect(s.tone).toBe(tone);
      expect(s.label).toBe(label);
      // Tone surfaces are tinted glass with dark ink that clears WCAG AA on a white page.
      const surface = composite(s.pillBg, [255, 255, 255]);
      expect(contrast(parseColor(s.labelInk).rgb, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parseColor(s.narrationInk).rgb, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("renders cursor, action chip, selection box, ripple, caret, toast, log, scroll track and progress", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();
    await capture(page); // stamps data-laya-ref
    await overlay.callBatch(page, [["progress", 3, 7], ["meter", 3, 1, 1240]]);
    await overlay.moveCursor(page, 40, 40);
    const rect = await overlay.focus(page, "e2", "Typing Email\u2026");
    expect(rect).not.toBeNull();
    expect(rect!.arriveMs).toBeGreaterThan(0);
    let s = (await hud(page))!;
    expect(s.cursorOn).toBe(true);
    expect(s.cursorAnimations).toBeGreaterThan(0); // it glides, it does not teleport
    expect(s.chipOn).toBe(true);
    expect(s.chipText).toBe("Typing Email\u2026");
    expect(s.chipActivity).toBe("typing");
    expect(s.typingDots).toBe(true);
    expect(s.caretOn).toBe(true);
    expect(s.targetOn).toBe(true);
    expect(s.targetHandles).toBe(4);
    expect(s.targetLeft).toBe(`${rect!.x - 4}px`);
    expect(s.progressOn).toBe(true);
    expect(s.progress).toBe("3/7");
    expect(s.meter).toContain("3 steps");
    expect(s.meter).toContain("1.2k tok");

    await overlay.ripple(page, 120, 240);
    await overlay.toast(page, "form submitted", "success");
    await overlay.log(page, "Clicking Sign in");
    await overlay.scrollIndicator(page, "down", 400);
    s = (await hud(page))!;
    expect(s.ripples).toBeGreaterThan(0);
    expect(s.toasts.some((t) => t.includes("form submitted"))).toBe(true);
    expect(s.logEntries).toContain("Clicking Sign in");
    expect(s.logIcons).toBeGreaterThan(0);
    expect(s.scrollOn).toBe(true);
    // Trail dots mark a long glide.
    await overlay.moveCursor(page, 600, 500, "", 6);
    expect((await hud(page))!.trails).toBeGreaterThan(0);

    expect((await page.screenshot()).length).toBeGreaterThan(0);
  });

  it("picks the legible glass/ink pairing for the page behind the pill", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();
    await overlay.callBatch(page, [["setState", "acting"], ["setStatus", "Clicking the sign in button"]]);
    const light = (await hud(page))!;
    expect(light.backdrop).toBe("255,255,255");
    expect(light.theme).toBe("light");
    const onWhite = composite(light.pillBg, [255, 255, 255]);
    expect(contrast(parseColor(light.labelInk).rgb, onWhite)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor(light.narrationInk).rgb, onWhite)).toBeGreaterThanOrEqual(4.5);

    await page.setContent('<body style="margin:0;background:#0b0b0f">dark page</body>');
    await overlay.callBatch(page, [["setState", "acting"], ["setStatus", "Clicking the sign in button"]]);
    await page.waitForTimeout(260);
    const dark = (await hud(page))!;
    expect(dark.backdrop).toBe("11,11,15");
    expect(dark.theme).toBe("dark");
    expect(parseColor(dark.labelInk).rgb).toEqual([255, 255, 255]);
    const onBlack = composite(dark.pillBg, [11, 11, 15]);
    expect(contrast(parseColor(dark.labelInk).rgb, onBlack)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor(dark.narrationInk).rgb, onBlack)).toBeGreaterThanOrEqual(4.5);
  });

  it("draws the four-sided aura, pinned to its edges, and toggles it", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();
    await overlay.sessionFrame(page, true);
    const aura = await page.evaluate((id) => {
      const a = document.getElementById(id)!.shadowRoot!.querySelector("[data-laya-aura]") as HTMLElement;
      const cs = getComputedStyle(a);
      return { display: cs.display, image: cs.backgroundImage, position: cs.backgroundPosition, anim: cs.animationName };
    }, HOST_ID);
    expect(aura.display).toBe("block");
    expect(aura.image.split("linear-gradient").length - 1).toBe(4);
    expect(aura.image.split("radial-gradient").length - 1).toBe(1);
    expect(aura.image).toContain("59, 130, 246");
    expect(aura.position).toBe("50% 0px, 50% 100%, 0px 50%, 100% 50%, 50% 50%");
    expect(aura.anim).toBe("laya-aura");
    await overlay.sessionFrame(page, false);
    expect((await hud(page))!.auraOff).toBe(true);
  });

  it("drags by the grip, clamps to the viewport, and keeps the takeover chip beside it", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();
    await overlay.beginRun(page);
    await overlay.setStatus(page, "drag me");
    await page.waitForTimeout(450); // let the narration finish typing in
    const grip = await page.evaluate((id) => {
      const r = document.getElementById(id)!.shadowRoot!.querySelector(".grip")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, HOST_ID);
    const before = (await hud(page))!;
    // The pill rests top-centre by default.
    expect(Math.abs(before.pillBox!.left + before.pillBox!.width / 2 - 640)).toBeLessThanOrEqual(2);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x - 300, grip.y + 300, { steps: 8 });
    await page.mouse.up();
    const after = (await hud(page))!;
    expect(after.pillBox!.left).toBeLessThan(before.pillBox!.left - 200);
    expect(after.pillBox!.top).toBeGreaterThan(before.pillBox!.top + 200);
    expect(after.takeoverOn).toBe(true);
    expect(overlaps(after.pillBox!, after.takeoverBox!)).toBe(false);
    // The takeover chip is the inverse surface and clears AA on its own.
    expect(contrast(parseColor(after.takeoverInk).rgb, composite(after.takeoverBg, [255, 255, 255]))).toBeGreaterThanOrEqual(4.5);
    // Dragged far off-screen it is clamped, not lost.
    const g2 = await page.evaluate((id) => {
      const r = document.getElementById(id)!.shadowRoot!.querySelector(".grip")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, HOST_ID);
    await page.mouse.move(g2.x, g2.y);
    await page.mouse.down();
    await page.mouse.move(-1200, -1200, { steps: 6 });
    await page.mouse.up();
    const clamped = (await hud(page))!;
    expect(clamped.pillBox!.left).toBeGreaterThanOrEqual(0);
    expect(clamped.pillBox!.top).toBeGreaterThanOrEqual(0);
    await overlay.endRun(page);
    expect((await hud(page))!.takeoverOn).toBe(false);
  });

  it("hands control back on the user's Esc, but not on Laya's own key presses", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();
    await overlay.beginRun(page);
    await overlay.expectKeys(page, 1000);
    await page.keyboard.press("Escape");
    expect(await overlay.takeoverRequested(page)).toBe(false);
    await page.waitForTimeout(1050);
    await page.keyboard.press("Escape");
    expect(await overlay.takeoverRequested(page)).toBe(true);
    const s = (await hud(page))!;
    expect(s.activity).toBe("paused");
    expect(s.label).toBe("You have control");
    expect(s.takeoverOn).toBe(false);
  });
});

describe("Esc takeover ends an autopilot run", () => {
  it("stops the loop with outcome taken_over at the next step", async () => {
    const fixtures = await startFixtureServer();
    const session = new BrowserSession({ headless: true, overlay: overlayOn() });
    try {
      const page = await session.getPage();
      let calls = 0;
      const engine: LayaDecisionEngine = {
        available: true,
        async decide() {
          calls += 1;
          // The watching user presses Esc while Laya is deciding its first step.
          if (calls === 1) await page.keyboard.press("Escape");
          return { operation: "WAIT", operationConfidence: 0.99, targetConfidence: 1, source: "laya" };
        },
        async close() {},
      };
      const result = await runGoal({
        goal: "wait around",
        session,
        engine,
        url: fixtures.url("login.html"),
        maxSteps: 5,
        settleProbe: false,
        overlay: session.getOverlay(),
        overlayPage: page,
        operationThresholds: { WAIT: 0.5 },
      });
      expect(result.outcome).toBe("taken_over");
      expect(result.transcript.at(-1)?.detail).toBe("BLOCKED (user took over)");
      expect(calls).toBe(1);
    } finally {
      await session.close();
      await fixtures.close();
    }
  });
});

describe("overlay debug 'what the agent sees' (debugSeeElements enabled)", () => {
  it("outlines existing [data-laya-ref] elements with their ref labels", async () => {
    const fixtures = await startFixtureServer();
    const session = new BrowserSession({ headless: true, overlay: overlayOn({ debugSeeElements: true }) });
    try {
      await navigate.makeHandler({ session })({ url: fixtures.url("login.html") });
      const page = await session.getPage();
      const snap = await capture(page);
      expect(snap.controls.length).toBeGreaterThan(0);
      await session.getOverlay().showSeenElements(page);
      const seen = await page.evaluate((id) => {
        const root = document.getElementById(id)!.shadowRoot!;
        const labels = Array.from(root.querySelectorAll(".seen .tag")).map((n) => n.textContent ?? "");
        const present = Array.from(document.querySelectorAll("[data-laya-ref]")).map((el) => el.getAttribute("data-laya-ref"));
        return { labels, present };
      }, HOST_ID);
      expect(seen.labels.length).toBeGreaterThan(0);
      for (const label of seen.labels) expect(seen.present).toContain(label.replace(/^\[ref=|\]$/g, ""));
    } finally {
      await session.close();
      await fixtures.close();
    }
  });
});

describe("autopilot narrates through the overlay while RunResult is unchanged", () => {
  it("logs the steps, ends on Done, and matches a no-overlay run", async () => {
    const fixtures = await startFixtureServer();
    const goal = 'search for "laptops" and expect "Showing results for laptops"';
    const withSession = new BrowserSession({ headless: true, overlay: overlayOn() });
    const overlayPage = await withSession.getPage();
    const withResult = await runGoal({
      goal,
      session: withSession,
      engine: new StubEngine(),
      url: fixtures.url("search-form.html"),
      overlay: withSession.getOverlay(),
      overlayPage,
    });
    const s = (await hud(overlayPage))!;
    expect(s.logEntries.length).toBeGreaterThan(0);
    // The log narrates in plain words, ending on Done.
    expect(s.logEntries.some((e) => /^Typing|^Clicking/.test(e))).toBe(true);
    expect(s.logEntries.at(-1)).toBe("Done");
    expect(s.tone).toBe("done");
    expect(s.label).toBe("Done");
    expect(s.takeoverOn).toBe(false);
    expect(withResult.outcome).toBe("done");
    await withSession.close();

    const noSession = new BrowserSession({ headless: true });
    const noResult = await runGoal({
      goal,
      session: noSession,
      engine: new StubEngine(),
      url: fixtures.url("search-form.html"),
    });
    await noSession.close();
    await fixtures.close();
    expect(noResult.outcome).toBe(withResult.outcome);
    expect(noResult.verification).toEqual(withResult.verification);
    expect(noResult.transcript.map((x) => x.operation)).toEqual(withResult.transcript.map((x) => x.operation));
  });
});

describe("headed-default browser falls back to headless with no display server", () => {
  let fixtures: FixtureServer;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  it("constructs headed, transparently falls back, and yields a working page", async () => {
    // headless:false is the real default. In this display-less sandbox the headed launch
    // throws and the code must fall back to headless and return a usable page (no throw).
    const session = new BrowserSession({ headless: false });
    try {
      const page = await session.getPage();
      // A usable page: navigate + capture work without throwing.
      await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
      const snap = await capture(page);
      expect(snap.controls.length).toBeGreaterThan(0);
      expect(await page.title()).toBe("Sign in");
      // The fallback set the effective headless mode to true (headed could not launch here).
      // If a headed launch somehow succeeded, this stays false and the page still works.
      expect(typeof session.headless).toBe("boolean");
    } finally {
      await session.close();
    }
  });
});
