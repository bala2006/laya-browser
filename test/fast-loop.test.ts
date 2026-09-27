/**
 * (F1) Behavioral tests for the fast browser loop (real headless Chromium, no weights).
 *
 * These tests exercise the jev-adopted mechanics in TypeScript/Playwright:
 *   - captureFast persistent node identity (stable + pruned) and its atomic single evaluate;
 *   - the untrusted eval-output validator rejects a malformed structure;
 *   - freshGuard reports fresh vs stale for a targeted node and the whole-page marker;
 *   - actOnNode rejects an occluded control and succeeds once it is uncovered;
 *   - an end-to-end runGoal (StubEngine, flag ON) reaches the SAME verified final-page success
 *     as the flag-off run in FEWER-or-equal browser round trips (the actOnNode path is taken,
 *     not resolveRef/locate).
 *
 * They MUST fail if the fast-path behavior regresses. No em dashes anywhere in this file.
 */
import { BrowserSession } from "../src/browser.js";
import { captureFast, isRawFastSnapshot } from "../src/snapshot.js";
import { runGoal } from "../src/autopilot/loop.js";
import { StubEngine } from "../src/laya/index.js";
import type { Decision, LayaDecisionEngine, PageState } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

// The occlusion fixture exposes a page-global to uncover the target button.
declare function removeOverlay(): void;

describe("fast loop: captureFast persistent identity (real headless chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("assigns a persistent nodeId that is STABLE for the same element across two captures", async () => {
    const page = await session.getPage();
    const first = await captureFast(page);
    const second = await captureFast(page);

    const emailFirst = first.controls.find((c) => c.name === "Email");
    const emailSecond = second.controls.find((c) => c.name === "Email");
    expect(emailFirst).toBeDefined();
    expect(emailSecond).toBeDefined();
    // Same live element keeps the SAME persistent identity across captures.
    expect(emailSecond!.nodeId).toBe(emailFirst!.nodeId);

    // Every control carries a finite integer nodeId, a guard, and a numeric rect.
    for (const c of first.controls) {
      expect(Number.isInteger(c.nodeId)).toBe(true);
      expect(typeof c.guard.role).toBe("string");
      expect(typeof c.rect.w).toBe("number");
    }
  });

  it("prunes / drops the identity when the element is removed from the DOM", async () => {
    const page = await session.getPage();
    const before = await captureFast(page);
    const help = before.controls.find((c) => c.name === "Need help?");
    expect(help).toBeDefined();
    const removedId = help!.nodeId;

    // Remove the link and re-capture: its nodeId must no longer appear among the controls.
    await page.evaluate(() => document.getElementById("help")?.remove());
    const after = await captureFast(page);
    expect(after.controls.some((c) => c.nodeId === removedId)).toBe(false);
    expect(after.controls.some((c) => c.name === "Need help?")).toBe(false);

    // A surviving element keeps its identity across the mutation.
    const emailBefore = before.controls.find((c) => c.name === "Email")!;
    const emailAfter = after.controls.find((c) => c.name === "Email")!;
    expect(emailAfter.nodeId).toBe(emailBefore.nodeId);
  });

  it("performs exactly ONE page.evaluate for the whole snapshot", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    let evaluateCalls = 0;
    const original = page.evaluate.bind(page);
    const spy = (...args: unknown[]) => {
      evaluateCalls += 1;
      // @ts-expect-error passthrough to the real evaluate signature.
      return original(...args);
    };
    // @ts-expect-error install the counting spy for the duration of this capture.
    page.evaluate = spy;
    try {
      const snap = await captureFast(page);
      expect(snap.controls.length).toBeGreaterThan(0);
    } finally {
      // @ts-expect-error restore the real evaluate.
      page.evaluate = original;
    }
    expect(evaluateCalls).toBe(1);
  });

  it("returns a well-formed guard + pageKey + marker that the validator accepts", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    const snap = await captureFast(page);
    expect(typeof snap.pageKey).toBe("string");
    expect(snap.pageKey.length).toBeGreaterThan(0);
    expect(typeof snap.marker).toBe("string");
    expect(snap.marker.length).toBeGreaterThan(0);

    // The validator accepts the real, well-formed raw shape.
    const raw = {
      url: snap.url,
      title: snap.title,
      visibleText: snap.visibleText,
      text: snap.text,
      pageKey: snap.pageKey,
      marker: snap.marker,
      controls: snap.controls.map((c) => ({
        ref: c.ref,
        index: c.index,
        role: c.role,
        name: c.name,
        tag: c.tag,
        editable: c.editable,
        nodeId: c.nodeId,
        guard: c.guard,
        rect: c.rect,
      })),
    };
    expect(isRawFastSnapshot(raw)).toBe(true);
  });
});

describe("fast loop: boundary validation of malformed eval output", () => {
  it("rejects malformed structures (untrusted page.evaluate boundary)", () => {
    // Not an object.
    expect(isRawFastSnapshot(null)).toBe(false);
    expect(isRawFastSnapshot("nope")).toBe(false);
    // Missing string fields.
    expect(isRawFastSnapshot({ url: 1, title: "", visibleText: "", text: "", pageKey: "", marker: "", controls: [] })).toBe(
      false,
    );
    // controls not an array.
    expect(
      isRawFastSnapshot({ url: "", title: "", visibleText: "", text: "", pageKey: "", marker: "", controls: {} }),
    ).toBe(false);
    // A control with a non-integer nodeId.
    expect(
      isRawFastSnapshot({
        url: "",
        title: "",
        visibleText: "",
        text: "",
        pageKey: "",
        marker: "",
        controls: [
          {
            ref: "e1",
            index: 1,
            role: "button",
            name: "x",
            tag: "button",
            editable: false,
            nodeId: 1.5,
            guard: {
              role: "button",
              name: "x",
              value: null,
              checked: null,
              selectedIndex: null,
              disabled: false,
              ariaExpanded: null,
              ariaChecked: null,
              ariaSelected: null,
              href: null,
              scopeText: "",
            },
            rect: { x: 0, y: 0, w: 1, h: 1 },
          },
        ],
      }),
    ).toBe(false);
    // A control with a malformed guard (checked is a string).
    expect(
      isRawFastSnapshot({
        url: "",
        title: "",
        visibleText: "",
        text: "",
        pageKey: "",
        marker: "",
        controls: [
          {
            ref: "e1",
            index: 1,
            role: "button",
            name: "x",
            tag: "button",
            editable: false,
            nodeId: 1,
            guard: {
              role: "button",
              name: "x",
              value: null,
              checked: "yes",
              selectedIndex: null,
              disabled: false,
              ariaExpanded: null,
              ariaChecked: null,
              ariaSelected: null,
              href: null,
              scopeText: "",
            },
            rect: { x: 0, y: 0, w: 1, h: 1 },
          },
        ],
      }),
    ).toBe(false);
    // A control with a malformed rect (missing h).
    expect(
      isRawFastSnapshot({
        url: "",
        title: "",
        visibleText: "",
        text: "",
        pageKey: "",
        marker: "",
        controls: [
          {
            ref: "e1",
            index: 1,
            role: "button",
            name: "x",
            tag: "button",
            editable: false,
            nodeId: 1,
            guard: {
              role: "button",
              name: "x",
              value: null,
              checked: null,
              selectedIndex: null,
              disabled: false,
              ariaExpanded: null,
              ariaChecked: null,
              ariaSelected: null,
              href: null,
              scopeText: "",
            },
            rect: { x: 0, y: 0, w: 1 },
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("fast loop: freshGuard fresh vs stale (real headless chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("returns true on an unchanged target and false after its value / label / detach", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    const snap = await captureFast(page);
    const email = snap.controls.find((c) => c.name === "Email")!;

    // Unchanged: fresh.
    expect(
      await session.freshGuard(page, email.nodeId, { guard: email.guard, pageKey: snap.pageKey }),
    ).toBe(true);

    // Mutating the field value changes the pageKey (and the guard), so it is stale.
    await page.locator("#email").fill("changed@example.com");
    expect(
      await session.freshGuard(page, email.nodeId, { guard: email.guard, pageKey: snap.pageKey }),
    ).toBe(false);

    // A detached node is stale.
    const fresh2 = await captureFast(page);
    const help = fresh2.controls.find((c) => c.name === "Need help?")!;
    await page.evaluate(() => document.getElementById("help")?.remove());
    expect(
      await session.freshGuard(page, help.nodeId, { guard: help.guard, pageKey: fresh2.pageKey }),
    ).toBe(false);
  });

  it("compares the whole-page marker for non-targeted freshness", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("search-form.html"), { waitUntil: "domcontentloaded" });
    const snap = await captureFast(page);
    // Same page: the marker matches.
    expect(await session.freshGuard(page, undefined, { marker: snap.marker })).toBe(true);
    // After typing into the field the whole-page marker changes.
    await page.locator("#query").fill("laptops");
    expect(await session.freshGuard(page, undefined, { marker: snap.marker })).toBe(false);
  });

  it("stays fresh for controls named via title or a child img[alt] (name-derivation parity)", async () => {
    // The act-time guard recompute (currentGuardAndPageKey.nameFor) must derive the accessible
    // name with the SAME fallback chain as captureFast.accessibleName. A control named only via
    // its title attribute or a child img[alt] would otherwise recompute a different name and be
    // wrongly reported stale on an unchanged page.
    const page = await session.getPage();
    await page.goto(fixtures.url("fast-title-name.html"), { waitUntil: "domcontentloaded" });
    const snap = await captureFast(page);

    const byTitle = snap.controls.find((c) => c.name === "Settings")!;
    const byImgAlt = snap.controls.find((c) => c.name === "Search")!;
    expect(byTitle).toBeDefined();
    expect(byImgAlt).toBeDefined();

    // Unchanged page: both re-check as FRESH, proving the recomputed name matches the observed
    // one for the title and img[alt] fallbacks.
    expect(
      await session.freshGuard(page, byTitle.nodeId, { guard: byTitle.guard, pageKey: snap.pageKey }),
    ).toBe(true);
    expect(
      await session.freshGuard(page, byImgAlt.nodeId, { guard: byImgAlt.guard, pageKey: snap.pageKey }),
    ).toBe(true);
  });
});

describe("fast loop: occlusion hit-test (real headless chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("refuses a fully covered control with reason 'covered', then succeeds once uncovered", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("fast-occlusion.html"), { waitUntil: "domcontentloaded" });
    const snap = await captureFast(page);
    const target = snap.controls.find((c) => c.name === "Confirm")!;
    expect(target).toBeDefined();

    // Covered by the overlay: the pre-input occlusion hit-test rejects the click.
    const covered = await session.actOnNode(page, target.nodeId, "click");
    expect(covered.ok).toBe(false);
    if (!covered.ok) expect(covered.reason).toBe("covered");
    // Nothing was clicked.
    expect(await page.locator("#outcome").textContent()).toBe("");

    // Remove the overlay and act again: now it succeeds and the click lands.
    await page.evaluate(() => removeOverlay());
    const uncovered = await session.actOnNode(page, target.nodeId, "click");
    expect(uncovered.ok).toBe(true);
    expect(await page.locator("#outcome").textContent()).toBe("clicked target");
  });
});

describe("fast loop: adaptive combobox wait (real headless chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("fills a combobox via actOnNode then waits for the delayed options to appear", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("fast-autocomplete.html"), { waitUntil: "domcontentloaded" });
    const snap = await captureFast(page);
    const city = snap.controls.find((c) => c.role === "combobox")!;
    expect(city).toBeDefined();

    // Fill the field on the OBSERVED node (no fresh selector query).
    const result = await session.actOnNode(page, city.nodeId, "fill", { value: "L" });
    expect(result.ok).toBe(true);

    // The adaptive wait resolves after the delayed [role=option] list becomes visible (up to
    // the cap), so options are present immediately after it returns.
    await session.adaptiveWait(page, { nodeId: city.nodeId, kind: "fill", capMs: 200 });
    const optionCount = await page.locator("#listbox [role='option']").count();
    expect(optionCount).toBe(3);
  });
});

describe("fast loop: end-to-end runGoal parity + round-trip reduction (StubEngine)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeEach(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
  });

  afterEach(async () => {
    await session.close();
    await fixtures.close();
  });

  it("reaches the SAME verified success with the flag ON as OFF, taking the actOnNode path", async () => {
    // Count the browser round trips that resolve a target: the legacy path uses
    // resolveRef/locate per action, the fast path uses actOnNode instead.
    let locateCalls = 0;
    let actOnNodeCalls = 0;
    const realLocate = session.locate.bind(session);
    const realResolveRef = session.resolveRef.bind(session);
    const realActOnNode = session.actOnNode.bind(session);
    session.locate = ((target: string) => {
      locateCalls += 1;
      return realLocate(target);
    }) as typeof session.locate;
    session.resolveRef = ((target: string) => {
      locateCalls += 1;
      return realResolveRef(target);
    }) as typeof session.resolveRef;
    session.actOnNode = ((...args: Parameters<typeof realActOnNode>) => {
      actOnNodeCalls += 1;
      return realActOnNode(...args);
    }) as typeof session.actOnNode;

    const goal =
      'email is "user@example.com" and password is "hunter2" and expect "Signed in as user@example.com"';

    const fastResult = await runGoal({
      goal,
      session,
      engine: new StubEngine(),
      url: fixtures.url("login.html"),
      maxSteps: 8,
      fastLoop: true,
    });

    // The fast run reaches DONE and the INDEPENDENT final-page verification passes.
    expect(fastResult.outcome).toBe("done");
    expect(fastResult.verification.verified).toBe(true);
    // The persistent-identity execution path was taken (no legacy locator re-query for the
    // filled fields / submit click).
    expect(actOnNodeCalls).toBeGreaterThan(0);
    const fastLocateCalls = locateCalls;
    // The real DOM reflects the filled fields and the signed-in outcome.
    let page = await session.getPage();
    expect(await page.locator("#email").inputValue()).toBe("user@example.com");
    expect(await page.locator("#status").textContent()).toBe("Signed in as user@example.com");

    // Now run the SAME goal on a fresh session with the flag OFF and compare.
    await session.close();
    await fixtures.close();
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    locateCalls = 0;
    actOnNodeCalls = 0;
    const realLocate2 = session.locate.bind(session);
    const realResolveRef2 = session.resolveRef.bind(session);
    session.locate = ((target: string) => {
      locateCalls += 1;
      return realLocate2(target);
    }) as typeof session.locate;
    session.resolveRef = ((target: string) => {
      locateCalls += 1;
      return realResolveRef2(target);
    }) as typeof session.resolveRef;

    const slowResult = await runGoal({
      goal,
      session,
      engine: new StubEngine(),
      url: fixtures.url("login.html"),
      maxSteps: 8,
      fastLoop: false,
    });

    // SAME independently-verified final-page success as the fast run.
    expect(slowResult.outcome).toBe("done");
    expect(slowResult.verification.verified).toBe(true);
    page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("Signed in as user@example.com");

    // The fast path resolves targets WITHOUT the legacy locator round trips, so it makes
    // FEWER-or-equal target-resolution round trips than the flag-off run.
    expect(fastLocateCalls).toBeLessThan(locateCalls);
  });
});

/**
 * (F4) A decision engine that always returns the SAME fixed decision and counts how many times
 * decide() is called. Used to observe speculative-decide-during-settle: with speculation, the
 * top-of-iteration decide is skipped when the previous settle already computed and cached it.
 */
function countingEngine(fixed: Decision): LayaDecisionEngine & { calls: number } {
  return {
    calls: 0,
    available: true,
    async decide(_state: PageState): Promise<Decision> {
      this.calls += 1;
      return fixed;
    },
    async close(): Promise<void> {},
  };
}

/** A compact, comparable projection of a transcript for the identical-sequence assertion. */
function decisionSequence(
  transcript: { operation: string; target?: string; value?: string; source: string }[],
): string[] {
  return transcript.map(
    (s) => `${s.operation}\u0000${s.target ?? ""}\u0000${s.value ?? ""}\u0000${s.source}`,
  );
}

describe("fast loop: speculative decide during settle (real headless chromium)", () => {
  let fixtures: FixtureServer;

  beforeEach(async () => {
    fixtures = await startFixtureServer();
  });

  afterEach(async () => {
    await fixtures.close();
  });

  it("reuses the speculative decision on a settled page (no double decide) with an identical sequence", async () => {
    // A WAIT-returning engine never mutates the DOM, so the page stays settled between steps
    // and the whole-page marker freshness holds. With speculation ON, the decision computed
    // during step N's settle is reused at step N+1 instead of being recomputed there.
    const maxSteps = 4;
    const wait: Decision = {
      operation: "WAIT",
      operationConfidence: 1,
      targetConfidence: 1,
      source: "laya",
    };

    // Flag OFF: no speculation. decide() is called exactly once per step.
    const slowSession = new BrowserSession({ headless: true });
    const slowEngine = countingEngine(wait);
    const slow = await runGoal({
      goal: "wait on the page",
      session: slowSession,
      engine: slowEngine,
      url: fixtures.url("search-form.html"),
      maxSteps,
      waitMs: 5,
      // Disable loop detection so the WAIT loop uses the full step budget (a repeated WAIT
      // would otherwise be flagged as stuck) and the decide counts are predictable.
      loopDetection: false,
      fastLoop: false,
    });
    await slowSession.close();

    // Flag ON: speculation reuses each step's decision from the previous settle. The loop must
    // NOT decide twice per step (once speculatively during settle, once at the top): the
    // top-of-iteration decide is skipped on reuse.
    const fastSession = new BrowserSession({ headless: true });
    const fastEngine = countingEngine(wait);
    const fast = await runGoal({
      goal: "wait on the page",
      session: fastSession,
      engine: fastEngine,
      url: fixtures.url("search-form.html"),
      maxSteps,
      waitMs: 5,
      loopDetection: false,
      fastLoop: true,
    });
    await fastSession.close();

    // The OBSERVED decision sequence and outcome are IDENTICAL with and without speculation.
    expect(fast.outcome).toBe(slow.outcome);
    expect(decisionSequence(fast.transcript)).toEqual(decisionSequence(slow.transcript));

    // Reuse actually happened: had the loop decided twice per step (speculative + a redundant
    // top-of-iteration decide), the count would be about 2x the non-speculating count. It stays
    // within one extra decide (the final settle speculates a decision that is never used).
    expect(slowEngine.calls).toBe(maxSteps);
    expect(fastEngine.calls).toBeLessThanOrEqual(slowEngine.calls + 1);
    expect(fastEngine.calls).toBeLessThan(slowEngine.calls * 2);
  });

  it("discards the speculative decision on drift (probe observed a change)", async () => {
    // A SCROLL_DOWN-returning engine changes scrollY on every step, so the settle probe always
    // observes a change: the speculative prefetch is discarded and every step decides fresh.
    // The observed sequence must STILL be identical to the non-speculating run.
    const maxSteps = 3;
    const scroll: Decision = {
      operation: "SCROLL_DOWN",
      operationConfidence: 1,
      targetConfidence: 1,
      source: "laya",
    };

    const slowSession = new BrowserSession({ headless: true });
    const slowEngine = countingEngine(scroll);
    const slow = await runGoal({
      goal: "scroll the page",
      session: slowSession,
      engine: slowEngine,
      url: fixtures.url("big-text.html"),
      maxSteps,
      loopDetection: false,
      fastLoop: false,
    });
    await slowSession.close();

    const fastSession = new BrowserSession({ headless: true });
    const fastEngine = countingEngine(scroll);
    const fast = await runGoal({
      goal: "scroll the page",
      session: fastSession,
      engine: fastEngine,
      url: fixtures.url("big-text.html"),
      maxSteps,
      loopDetection: false,
      fastLoop: true,
    });
    await fastSession.close();

    // Identical observed decision sequence and outcome despite (discarded) speculation.
    expect(fast.outcome).toBe(slow.outcome);
    expect(decisionSequence(fast.transcript)).toEqual(decisionSequence(slow.transcript));

    // On drift the cached decision is never reused, so each step decides fresh: the same number
    // of real decides as the non-speculating run (plus at most the speculative attempts that a
    // changed probe discards, which never REPLACE a real top-of-iteration decide).
    expect(slowEngine.calls).toBe(maxSteps);
    expect(fastEngine.calls).toBeGreaterThanOrEqual(slowEngine.calls);
  });
});
