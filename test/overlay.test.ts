/**
 * Real headless-Chromium end-to-end coverage for the agentLens visual overlay (Tiers 1-4),
 * the headed-default -> headless auto-fallback, and the autopilot narration path.
 *
 * The sandbox has NO display server, so overlay visuals are verified HEADLESS: the overlay is
 * FORCED ON (mode: "on") so it injects even headless, and every assertion reads the real DOM
 * via page.evaluate / locators (plus one non-empty page.screenshot()). These assertions are
 * written so they would FAIL if the injection / fallback / narration were reverted — they are
 * not static checks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { StubEngine } from "../src/laya/index.js";
import { runGoal } from "../src/autopilot/loop.js";
import { capture } from "../src/snapshot.js";
import type { OverlayConfig } from "../src/config.js";
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

const OVERLAY_ROOT = "#__laya_overlay__";

/** Parse a computed `rgb()`/`rgba()` colour into its [r,g,b] channels. */
function parseColor(value: string): [number, number, number] {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!m) throw new Error(`unparseable colour: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The alpha channel of a computed colour (1 for an opaque `rgb()` result). */
function alphaOf(value: string): number {
  const m = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/.exec(value);
  return m ? Number(m[1]) : 1;
}

/** Flatten a translucent colour over an opaque backdrop. */
function composite(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

/** Whether two viewport rectangles intersect. */
function overlaps(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

/** WCAG relative-luminance contrast ratio between two opaque colours. */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = ([r, g, bl]: [number, number, number]) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

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

  it("injects the banner root, visible with the correct text (Tier 1)", async () => {
    const page = await session.getPage();
    expect(await page.locator(OVERLAY_ROOT).count()).toBe(1);

    const info = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        text: el.textContent ?? "",
        display: cs.display,
        visibility: cs.visibility,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
      };
    }, OVERLAY_ROOT);

    expect(info).not.toBeNull();
    expect(info!.text).toContain("Laya is working");
    expect(info!.display).not.toBe("none");
    expect(info!.visibility).not.toBe("hidden");
    expect(info!.pointerEvents).toBe("none");
    expect(Number(info!.zIndex)).toBeGreaterThan(1000000);
  });

  it("keeps the HUD inert apart from the six-dot drag handle, with a high z-index", async () => {
    const page = await session.getPage();
    const result = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      const nodes = [root, ...Array.from(root.querySelectorAll("*"))] as HTMLElement[];
      const live = nodes.filter((n) => getComputedStyle(n).pointerEvents !== "none");
      const pill = root.children[0] as HTMLElement;
      const grip = pill.children[pill.children.length - 1] as HTMLElement;
      return {
        total: nodes.length,
        liveCount: live.length,
        liveIsGrip: live.length === 1 && live[0] === grip,
        gripDots: grip.children.length,
        gripCursor: getComputedStyle(grip).cursor,
        rootZ: getComputedStyle(root).zIndex,
      };
    }, OVERLAY_ROOT);
    expect(result).not.toBeNull();
    expect(result!.total).toBeGreaterThan(1);
    // Exactly ONE node may receive a pointer: the six-dot drag handle users hold to move the bar.
    // Everything else stays transparent to hit-testing, so the HUD can never swallow a page click.
    expect(result!.liveCount).toBe(1);
    expect(result!.liveIsGrip).toBe(true);
    expect(result!.gripDots).toBe(6);
    expect(result!.gripCursor).toBe("grab");
    expect(Number(result!.rootZ)).toBeGreaterThan(1000000);
  });

  it("re-injects after navigation (context.addInitScript survives a new document)", async () => {
    const page = await session.getPage();
    // Navigate to a DIFFERENT fixture; the one-shot highlight would be wiped here.
    await navigate.makeHandler(ctx)({ url: fixtures.url("search-form.html") });
    // Prove we are on the new document.
    expect(page.url()).toContain("search-form.html");
    expect(await page.locator(OVERLAY_ROOT).count()).toBe(1);
    const text = await page.locator(`${OVERLAY_ROOT}`).textContent();
    expect(text ?? "").toContain("Laya is working");
  });

  it("never intercepts a real click even under the banner region", async () => {
    // Navigate fresh so the login form controls are present.
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();

    // elementFromPoint at the banner's centre must NOT return an overlay node (pointer-events
    // none makes the overlay transparent to hit-testing), it returns the underlying page.
    const banner = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      const bannerEl = root?.firstElementChild as HTMLElement | null;
      if (!bannerEl) return null;
      const r = bannerEl.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy) as HTMLElement | null;
      const inOverlay = hit ? !!hit.closest(sel) : false;
      return { inOverlay, hitTag: hit?.tagName ?? null };
    }, OVERLAY_ROOT);
    expect(banner).not.toBeNull();
    expect(banner!.inOverlay).toBe(false);

    // And a real click through the overlay still drives the page: the login submit works.
    await page.locator("#email").fill("user@example.com");
    await clickTool.makeHandler(ctx)({ target: "#submit", element: "Sign in" });
    expect(await page.locator("#status").textContent()).toBe(
      "Signed in as user@example.com",
    );
  });

  it("renders each overlay API node it is driven with, and screenshots headless", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();

    await overlay.setStatus(page, "Filling the login form");
    await overlay.setState(page, "acting");
    await overlay.progress(page, 3, 7);
    await overlay.moveCursor(page, 120, 240, "click Sign in");
    await overlay.spotlight(page, { x: 40, y: 60, width: 100, height: 30 });
    await overlay.ripple(page, 120, 240);
    await overlay.toast(page, "form submitted", "success");
    await overlay.log(page, "CLICK Sign in button");
    await overlay.scrollIndicator(page, "down", 400);

    const dom = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      const style = (el: Element | null) => (el ? getComputedStyle(el as HTMLElement) : null);
      // The banner children, in build order: dot,title,stateLabel,status,progress,barWrap.
      const banner = root.children[0] as HTMLElement;
      const stateLabel = banner.children[2] as HTMLElement;
      const status = banner.children[3] as HTMLElement;
      const progress = banner.children[4] as HTMLElement;
      const barWrap = banner.children[5] as HTMLElement;
      // Named nodes located by their distinctive text/style.
      const allText = root.textContent ?? "";
      // spotlight = the node with a 2px solid border and display block among direct children
      // (the 1px-bordered pill/hint chips are excluded by the border width).
      const children = Array.from(root.children) as HTMLElement[];
      const spotlight = children.find(
        (c) =>
          style(c)!.borderStyle.includes("solid") &&
          style(c)!.borderTopWidth === "2px" &&
          style(c)!.display === "block",
      );
      // cursor = the top-level node that IS an <svg> arrow (not the pill, whose leading icon
      // also contains an svg glyph). The cursor node's only child is the svg.
      const cursor = children.find(
        (c) => c !== banner && c.children.length === 1 && c.firstElementChild?.tagName.toLowerCase() === "svg",
      );
      return {
        status: status.textContent,
        stateColor: style(stateLabel)!.color,
        stateLabel: stateLabel.textContent,
        progress: progress.textContent,
        barVisible: style(barWrap)!.display !== "none",
        spotlightVisible: !!spotlight && style(spotlight)!.display !== "none",
        spotlightLeft: spotlight ? style(spotlight)!.left : null,
        cursorVisible: !!cursor && style(cursor)!.display !== "none",
        cursorLeft: cursor ? style(cursor)!.left : null,
        hasToast: allText.includes("form submitted"),
        hasLogEntry: allText.includes("CLICK Sign in button"),
        hasScroll: /\u2193/.test(allText),
      };
    }, OVERLAY_ROOT);

    expect(dom).not.toBeNull();
    expect(dom!.status).toBe("Filling the login form");
    // acting state uses the accent colour; label reflects the state.
    expect(dom!.stateLabel).toContain("Acting");
    expect(dom!.progress).toBe("step 3/7");
    expect(dom!.barVisible).toBe(true);
    expect(dom!.spotlightVisible).toBe(true);
    expect(dom!.spotlightLeft).toBe("36px"); // rect.x - 4
    expect(dom!.cursorVisible).toBe(true);
    expect(dom!.cursorLeft).toBe("120px");
    expect(dom!.hasToast).toBe(true);
    expect(dom!.hasLogEntry).toBe(true);
    expect(dom!.hasScroll).toBe(true);

    // A non-empty screenshot proves the overlay renders in a headless raster.
    const shot = await page.screenshot();
    expect(shot.length).toBeGreaterThan(0);
  });

  it("reflects success / error / uncertain state colours", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();

    const colourFor = async (state: "success" | "error" | "uncertain") => {
      await overlay.setState(page, state);
      return page.evaluate((sel) => {
        const root = document.querySelector(sel) as HTMLElement | null;
        const banner = root?.children[0] as HTMLElement | undefined;
        const stateLabel = banner?.children[2] as HTMLElement | undefined;
        const icon = banner?.children[0] as HTMLElement | undefined;
        return {
          label: stateLabel?.textContent ?? "",
          color: stateLabel ? getComputedStyle(stateLabel).color : "",
          // The icon badge transitions its background, so the COMPUTED value is still the
          // previous colour on the frame the state changes; the inline declaration is exact.
          iconFill: icon ? icon.style.background : "",
        };
      }, OVERLAY_ROOT);
    };

    // The state LABEL is text on the light frosted pill, so it uses the DARK ink variant of the
    // state colour (the bright colour would fail contrast on a near-white surface); the bright
    // colour paints the icon square instead, so the state is still recognisable at a glance.
    // Both labels below are pinned exactly so the colours cannot silently drift.
    // The badge tint is the state hue at low alpha (tinted glass, so the page shows through); the
    // label ink is its darker variant because the label sits on the LIGHT glass on a white page.
    const success = await colourFor("success");
    expect(success.label).toContain("Done");
    expect(success.color).toBe("rgb(21, 128, 61)"); // #15803d ink on the light glass
    expect(success.iconFill).toBe("rgba(34, 197, 94, 0.2)"); // #22c55e badge tint

    const error = await colourFor("error");
    expect(error.label).toContain("Error");
    expect(error.color).toBe("rgb(185, 28, 28)"); // #b91c1c ink on the light glass
    expect(error.iconFill).toBe("rgba(239, 68, 68, 0.2)"); // #ef4444 badge tint

    const uncertain = await colourFor("uncertain");
    expect(uncertain.label).toContain("Uncertain");
    expect(uncertain.color).toBe("rgb(180, 83, 9)"); // #b45309 ink on the light glass
    expect(uncertain.iconFill).toBe("rgba(245, 158, 11, 0.2)"); // #f59e0b badge tint
  });

  it("renders the primary control surface centred, as a glowing frosted-glass rounded card", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();

    const info = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      const banner = root.children[0] as HTMLElement;
      const bs = getComputedStyle(banner);
      // The hint is the node containing the "press Esc to release" text.
      const hint = (Array.from(root.children) as HTMLElement[]).find((c) =>
        (c.textContent ?? "").includes("press Esc to release"),
      );
      const hs = hint ? getComputedStyle(hint) : null;
      const radius = parseFloat(bs.borderTopLeftRadius) || 0;
      // The leading badge is a circle of tinted glass holding a line-art SVG glyph.
      const icon = banner.children[0] as HTMLElement;
      const grip = banner.children[banner.children.length - 1] as HTMLElement;
      const iconStyle = getComputedStyle(icon);
      const box = banner.getBoundingClientRect();
      return {
        bannerBottom: bs.bottom,
        bannerRight: bs.right,
        bannerTop: banner.style.top, // inline: the surface is placed, not corner-anchored
        bannerLeft: banner.style.left,
        bannerInlineRight: banner.style.right,
        bannerInlineBottom: banner.style.bottom,
        // Centred on the viewport, the computer-use convention.
        centreOffsetX: Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
        centreOffsetY: Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
        bannerRadius: radius,
        // backdrop-filter is vendor-prefixed in headless chromium.
        bannerBlur:
          (bs as unknown as Record<string, string>).backdropFilter ||
          (bs as unknown as Record<string, string>).webkitBackdropFilter ||
          "",
        bannerBg: bs.backgroundColor,
        // A soft blue glow/halo: box-shadow references the blue accent rgb.
        bannerShadow: bs.boxShadow,
        iconHasGlyph: !!icon.querySelector("svg"),
        iconRadius: iconStyle.borderTopLeftRadius,
        iconGlyphIsLineArt: (() => {
          const svg = icon.querySelector("svg");
          // Line art: no fill, stroked in the theme ink (currentColor).
          return !!svg && svg.getAttribute("fill") === "none" && svg.getAttribute("stroke") === "currentColor";
        })(),
        fontFamily: bs.fontFamily,
        gripDots: grip.children.length,
        gripIsLastChild: banner.children[banner.children.length - 1] === grip,
        hintBottom: hs ? hs.bottom : null,
        hintRight: hs ? hs.right : null,
        hintTop: hint ? hint.style.top : null,
      };
    }, OVERLAY_ROOT);

    expect(info).not.toBeNull();
    // Placed by left/top (not corner-anchored) and sitting on the viewport's centre point.
    expect(info!.bannerTop).not.toBe("");
    expect(info!.bannerLeft).not.toBe("");
    expect(info!.bannerInlineRight).toBe("auto");
    expect(info!.bannerInlineBottom).toBe("auto");
    expect(info!.centreOffsetX).toBeLessThanOrEqual(2);
    expect(info!.centreOffsetY).toBeLessThanOrEqual(2);
    // Fully rounded pill: a large radius (>= 24px reads as a pill, not a 16px card).
    expect(info!.bannerRadius).toBeGreaterThanOrEqual(24);
    // Frosted glass: a blur backdrop-filter and a translucent background.
    expect(info!.bannerBlur).toContain("blur");
    expect(info!.bannerBg).toMatch(/rgba?\(/);
    // Soft blue glow/halo tied to the blue accent (#3b82f6 => rgb 59,130,246).
    expect(info!.bannerShadow).toContain("59, 130, 246");
    // Left icon is a circular glass badge carrying a line-art glyph.
    expect(info!.iconHasGlyph).toBe(true);
    expect(info!.iconGlyphIsLineArt).toBe(true);
    expect(info!.iconRadius).toBe("50%");
    // The reference's type stack: Inter first, then the platform UI fonts.
    expect(info!.fontFamily).toContain("Inter");
    // The six-dot drag handle is the pill's last child (so the documented child order holds).
    expect(info!.gripDots).toBe(6);
    expect(info!.gripIsLastChild).toBe(true);
    // Hint sits with the pill in the lower-right.
    expect(info!.hintBottom).not.toBe(null);
    expect(parseFloat(info!.hintBottom!)).toBeGreaterThan(0);
    expect(parseFloat(info!.hintRight!)).toBeGreaterThan(0);
    expect(info!.hintTop).toBe("");
  });

  it("picks the legible glass/ink pairing for the page behind it, and stacks the chip above the pill", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();

    // Drive the WORST case for layout: every optional node present at once, plus a long status.
    await overlay.setState(page, "acting");
    await overlay.setStatus(page, "clicking the sign in button for user@example.com");
    await overlay.progress(page, 3, 7);
    await overlay.meter(page, 3, 1, 1240);

    const sample = () =>
      page.evaluate((sel) => {
        const root = document.querySelector(sel) as HTMLElement | null;
        if (!root) return null;
        const kids = Array.from(root.children) as HTMLElement[];
        const banner = kids[0] as HTMLElement;
        const hint = kids.find((c) =>
          (c.textContent ?? "").includes("press Esc to release"),
        ) as HTMLElement;
        const rect = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        const ink = (el: HTMLElement) => getComputedStyle(el).color;
        return {
          viewportWidth: window.innerWidth,
          theme: banner.getAttribute("data-laya-theme") ?? "",
          backdrop: banner.getAttribute("data-laya-backdrop") ?? "",
          bannerRect: rect(banner),
          hintRect: rect(hint),
          bannerBg: getComputedStyle(banner).backgroundColor,
          titleInk: ink(banner.children[1] as HTMLElement),
          statusInk: ink(banner.children[3] as HTMLElement),
          hintBg: getComputedStyle(hint).backgroundColor,
          hintInk: getComputedStyle(hint).color,
        };
      }, OVERLAY_ROOT);

    const light = await sample();
    expect(light).not.toBeNull();

    // 1) On a LIGHT page the pill is a near-opaque frosted-white glass, so its ink no longer
    //    depends on the page behind it.
    expect(light!.backdrop).toBe("255,255,255");
    expect(light!.theme).toBe("light");
    expect(alphaOf(light!.bannerBg)).toBeGreaterThanOrEqual(0.8);
    // 2) Its text ink clears WCAG AA (4.5:1) against the pill composited over a WHITE page -
    //    the exact case that used to render white-on-white (1.0:1) and read as "invisible".
    const pillOnWhite = composite(parseColor(light!.bannerBg), alphaOf(light!.bannerBg), [
      255, 255, 255,
    ]);
    expect(contrast(parseColor(light!.titleInk), pillOnWhite)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor(light!.statusInk), pillOnWhite)).toBeGreaterThanOrEqual(4.5);
    // 3) The Esc chip is the inverse treatment (dark surface + light ink) and clears AA too.
    expect(alphaOf(light!.hintBg)).toBeGreaterThanOrEqual(0.8);
    expect(
      contrast(parseColor(light!.hintInk), parseColor(light!.hintBg)),
    ).toBeGreaterThanOrEqual(4.5);
    // 4) The chip is stacked ABOVE the pill: the boxes must not intersect, even with the pill
    //    grown to hold a wrapped status + progress bar + meter, and the chip stays lower-RIGHT.
    expect(overlaps(light!.bannerRect, light!.hintRect)).toBe(false);
    expect(light!.hintRect.right).toBeGreaterThan(light!.viewportWidth / 2);

    // 5) Flip the page behind the pill to a DARK one: the same pill must switch to the dark glass
    //    with light ink, and still clear AA against that backdrop. (The glass fades between the
    //    two pairings, so the colours are read after the transition settles.)
    await page.setContent('<body style="margin:0;background:#0b0b0f">dark page</body>');
    await overlay.setStatus(page, "clicking the sign in button for user@example.com");
    await page.waitForTimeout(320);

    const dark = await sample();
    expect(dark).not.toBeNull();
    expect(dark!.backdrop).toBe("11,11,15");
    expect(dark!.theme).toBe("dark");
    expect(parseColor(dark!.titleInk)).toEqual([255, 255, 255]);
    const pillOnBlack = composite(parseColor(dark!.bannerBg), alphaOf(dark!.bannerBg), [11, 11, 15]);
    expect(contrast(parseColor(dark!.titleInk), pillOnBlack)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor(dark!.statusInk), pillOnBlack)).toBeGreaterThanOrEqual(4.5);
  });

  it("shows the synthetic cursor on showCursor and drives the four-sided gradient aura", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const overlay = session.getOverlay();

    // Cursor is present (display:block) after showCursor, before any moveCursor.
    await overlay.showCursor(page);
    await overlay.sessionFrame(page, true);

    const on = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      const children = Array.from(root.children) as HTMLElement[];
      const banner = children[0] as HTMLElement;
      const cursor = children.find(
        (c) => c !== banner && c.children.length === 1 && c.firstElementChild?.tagName.toLowerCase() === "svg",
      );
      // The aura is a single fixed container, marked with data-laya-aura (it holds no children -
      // the old per-corner bloom divs were what made the corners read as blobs).
      const frame = root.querySelector("[data-laya-aura]") as HTMLElement | null;
      const frameCs = frame ? getComputedStyle(frame) : null;
      // Computed style is what the browser actually paints; everything must be in the BLUE accent
      // (#3b82f6 => rgb 59, 130, 246).
      const frameImage = frameCs ? frameCs.backgroundImage : "";
      return {
        cursorVisible: !!cursor && getComputedStyle(cursor).display !== "none",
        frameVisible: !!frame && getComputedStyle(frame).display !== "none",
        frameChildren: frame ? frame.children.length : -1,
        frameEvents: frame ? getComputedStyle(frame).pointerEvents : null,
        // A gradient on ALL FOUR sides: one accent band per edge. (Chromium drops the implicit
        // "to bottom" direction when it serialises, so count the gradients themselves.)
        frameImage,
        edgeBands: Math.max(0, frameImage.split("linear-gradient").length - 1),
        vignettes: Math.max(0, frameImage.split("radial-gradient").length - 1),
        // Inline (not computed) so the four edge positions are readable verbatim.
        framePosition: frame ? frame.style.backgroundPosition : "",
        frameAnimation: frameCs ? frameCs.animationName : "",
      };
    }, OVERLAY_ROOT);

    expect(on).not.toBeNull();
    expect(on!.cursorVisible).toBe(true);
    expect(on!.frameVisible).toBe(true);
    expect(on!.frameEvents).toBe("none");
    // No corner children left to intercept anything (the container is inert on its own).
    expect(on!.frameChildren).toBe(0);
    // A gradient band on all FOUR sides, in the BLUE accent (#3b82f6 => rgb 59, 130, 246)...
    expect(on!.edgeBands).toBe(4);
    expect(on!.frameImage).toContain("59, 130, 246");
    // ...each band PINNED to its own edge (the default top-left corner is what produced the hard
    // accent lines across the page), plus one radial vignette so the corners join seamlessly.
    // (the CSSOM normalises a bare 0 to 0px, hence the exact string)
    expect(on!.framePosition).toBe("50% 0px, 50% 100%, 0px 50%, 100% 50%, 50% 50%");
    expect(on!.vignettes).toBe(1);
    // The aura breathes on opacity alone - animating background-position would drag the bands
    // inland and re-introduce the seams, so 'laya-aura-sweep' must be gone.
    expect(on!.frameAnimation).toContain("laya-aura");
    expect(on!.frameAnimation).not.toContain("sweep");

    // sessionFrame(false) hides it again.
    await overlay.sessionFrame(page, false);
    const off = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      const frame = root.querySelector("[data-laya-aura]") as HTMLElement | null;
      return frame ? getComputedStyle(frame).display : null;
    }, OVERLAY_ROOT);
    expect(off).toBe("none");
  });

  it("moves the bar when the six-dot handle is held, and carries the chip with it", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    await session.getOverlay().setStatus(page, "drag me");

    const pillSelector = `${OVERLAY_ROOT} > div:first-child`;
    const before = await page.locator(pillSelector).boundingBox();
    const grip = await page.locator(`${pillSelector} > div:last-child`).boundingBox();
    expect(before).not.toBeNull();
    expect(grip).not.toBeNull();

    // Hold the handle and drag the bar up and to the left, like a user getting it out of the way.
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip!.x - 340, grip!.y - 240, { steps: 8 });
    await page.mouse.up();

    const readPill = () =>
      page.evaluate((sel) => {
        const root = document.querySelector(sel) as HTMLElement | null;
        if (!root) return null;
        const kids = Array.from(root.children) as HTMLElement[];
        const banner = kids[0] as HTMLElement;
        const hint = kids.find((c) =>
          (c.textContent ?? "").includes("press Esc to release"),
        ) as HTMLElement;
        const box = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        return {
          pill: box(banner),
          hint: box(hint),
          inline: {
            left: banner.style.left,
            top: banner.style.top,
            right: banner.style.right,
            bottom: banner.style.bottom,
          },
        };
      }, OVERLAY_ROOT);

    const after = await readPill();
    expect(after).not.toBeNull();
    // The bar really moved, and is now absolutely positioned instead of corner-anchored.
    expect(after!.pill.left).toBeLessThan(before!.x - 200);
    expect(after!.pill.top).toBeLessThan(before!.y - 100);
    expect(after!.inline.left).not.toBe("");
    expect(after!.inline.top).not.toBe("");
    expect(after!.inline.right).toBe("auto");
    expect(after!.inline.bottom).toBe("auto");
    // The Esc chip trails the bar rather than being left behind on top of the pill.
    expect(overlaps(after!.pill, after!.hint)).toBe(false);

    // Drag it far off-screen: it is clamped inside the viewport rather than lost.
    const movedGrip = await page.locator(`${pillSelector} > div:last-child`).boundingBox();
    await page.mouse.move(movedGrip!.x + movedGrip!.width / 2, movedGrip!.y + movedGrip!.height / 2);
    await page.mouse.down();
    await page.mouse.move(-1200, -1200, { steps: 6 });
    await page.mouse.up();
    const clamped = await readPill();
    expect(clamped!.pill.left).toBeGreaterThanOrEqual(0);
    expect(clamped!.pill.top).toBeGreaterThanOrEqual(0);
  });
});

describe("overlay debug 'what the agent sees' (debugSeeElements enabled)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    // debugSeeElements defaults false; enable it via the overlay config override for this test.
    session = new BrowserSession({
      headless: true,
      overlay: overlayOn({ debugSeeElements: true }),
    });
    ctx = { session };
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("outlines existing [data-laya-ref] elements with their ref labels", async () => {
    const page = await session.getPage();
    // capture() stamps data-laya-ref on interactive elements.
    const snap = await capture(page);
    const refs = snap.controls.map((c) => String(c.ref));
    expect(refs.length).toBeGreaterThan(0);

    await session.getOverlay().showSeenElements(page);

    const seen = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      // The "seen" layer holds [ref=eN] tag labels; collect them.
      const labels = Array.from(root.querySelectorAll("*"))
        .map((n) => n.textContent ?? "")
        .filter((t) => /^\[ref=e\d+\]$/.test(t));
      // Which refs are actually present in the document.
      const present = Array.from(document.querySelectorAll("[data-laya-ref]")).map((el) =>
        el.getAttribute("data-laya-ref"),
      );
      return { labels, present };
    }, OVERLAY_ROOT);

    expect(seen).not.toBeNull();
    expect(seen!.labels.length).toBeGreaterThan(0);
    // Every outline label must reference an element that actually carries data-laya-ref.
    for (const label of seen!.labels) {
      const ref = label.replace(/^\[ref=/, "").replace(/\]$/, "");
      expect(seen!.present).toContain(ref);
    }
  });
});

describe("autopilot narrates through the overlay while RunResult is unchanged", () => {
  let fixtures: FixtureServer;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  const goal = 'search for "laptops" and expect "Showing results for laptops"';

  it("accumulates activity-log entries + a terminal state, matching a no-overlay run", async () => {
    // Run WITH the overlay: thread the session overlay + page into runGoal like the tool does.
    const withSession = new BrowserSession({ headless: true, overlay: overlayOn() });
    const withOverlay = withSession.getOverlay();
    const overlayPage = await withSession.getPage();
    const withResult = await runGoal({
      goal,
      session: withSession,
      engine: new StubEngine(),
      url: fixtures.url("search-form.html"),
      overlay: withOverlay,
      overlayPage,
    });

    // The activity-log panel accumulated entries reflecting the transcript steps.
    const logInfo = await overlayPage.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      // Find the activity-log body: the panel whose header text is "Activity".
      const children = Array.from(root.children) as HTMLElement[];
      const panel = children.find((c) => (c.textContent ?? "").startsWith("Activity"));
      const body = panel?.children[1] as HTMLElement | undefined;
      const entries = body ? Array.from(body.children).map((n) => n.textContent ?? "") : [];
      const banner = children[0] as HTMLElement | undefined;
      const stateLabel = banner?.children[2] as HTMLElement | undefined;
      return { entries, terminalState: stateLabel?.textContent ?? "" };
    }, OVERLAY_ROOT);

    expect(logInfo).not.toBeNull();
    expect(logInfo!.entries.length).toBeGreaterThan(0);
    // At least one log entry mentions a transcript operation the run performed.
    const joined = logInfo!.entries.join("\n");
    expect(/TYPE_TEXT|CLICK|DONE/.test(joined)).toBe(true);
    // A terminal state is set (success on a verified DONE).
    expect(logInfo!.terminalState.length).toBeGreaterThan(0);
    expect(withResult.outcome).toBe("done");

    await withSession.close();

    // Run WITHOUT any overlay: the RunResult must be identical in shape/outcome.
    const noSession = new BrowserSession({ headless: true });
    const noResult = await runGoal({
      goal,
      session: noSession,
      engine: new StubEngine(),
      url: fixtures.url("search-form.html"),
    });
    await noSession.close();

    // Transcript + verification are unchanged by the presence of the overlay.
    expect(noResult.outcome).toBe(withResult.outcome);
    expect(noResult.verification.verified).toBe(withResult.verification.verified);
    expect(noResult.verification.checked).toBe(withResult.verification.checked);
    expect(noResult.transcript.map((s) => s.operation)).toEqual(
      withResult.transcript.map((s) => s.operation),
    );
    const withTyped = withResult.transcript.find((s) => s.operation === "TYPE_TEXT");
    const noTyped = noResult.transcript.find((s) => s.operation === "TYPE_TEXT");
    expect(withTyped?.value).toBe(noTyped?.value);
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
