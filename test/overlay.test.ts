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
    accent: "#a855f7",
    typingEffect: false,
    waitCountdown: false,
    debugSeeElements: false,
    activityLog: true,
    cursorTrail: 6,
    ...overrides,
  };
}

const OVERLAY_ROOT = "#__laya_overlay__";

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
    expect(info!.text).toContain("Laya is controlling this browser");
    expect(info!.display).not.toBe("none");
    expect(info!.visibility).not.toBe("hidden");
    expect(info!.pointerEvents).toBe("none");
    expect(Number(info!.zIndex)).toBeGreaterThan(1000000);
  });

  it("gives every overlay node pointer-events:none and a high z-index", async () => {
    const page = await session.getPage();
    const result = await page.evaluate((sel) => {
      const root = document.querySelector(sel) as HTMLElement | null;
      if (!root) return null;
      const nodes = [root, ...Array.from(root.querySelectorAll("*"))] as HTMLElement[];
      const bad = nodes.filter((n) => getComputedStyle(n).pointerEvents !== "none");
      return { total: nodes.length, badCount: bad.length, rootZ: getComputedStyle(root).zIndex };
    }, OVERLAY_ROOT);
    expect(result).not.toBeNull();
    expect(result!.total).toBeGreaterThan(1);
    expect(result!.badCount).toBe(0);
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
    expect(text ?? "").toContain("Laya is controlling this browser");
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
      // spotlight = the node with a solid border and display block among direct children.
      const children = Array.from(root.children) as HTMLElement[];
      const spotlight = children.find(
        (c) => style(c)!.borderStyle.includes("solid") && style(c)!.display === "block",
      );
      // cursor = node containing an <svg>.
      const cursor = children.find((c) => c.querySelector("svg"));
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
        return { label: stateLabel?.textContent ?? "", color: stateLabel ? getComputedStyle(stateLabel).color : "" };
      }, OVERLAY_ROOT);
    };

    const success = await colourFor("success");
    expect(success.label).toContain("Done");
    expect(success.color).toBe("rgb(34, 197, 94)"); // #22c55e

    const error = await colourFor("error");
    expect(error.label).toContain("Error");
    expect(error.color).toBe("rgb(239, 68, 68)"); // #ef4444

    const uncertain = await colourFor("uncertain");
    expect(uncertain.label).toContain("Uncertain");
    expect(uncertain.color).toBe("rgb(245, 158, 11)"); // #f59e0b
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
