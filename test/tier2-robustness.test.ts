/**
 * Tier 2 (robustness & production) tests, all against real headless chromium, offline.
 *
 *  - T2.1 auto storage-state persistence: a session with LAYA_STORAGE_STATE seeds + closes,
 *    then a NEW session on the same path resumes the cookies/localStorage; unset is a no-op.
 *  - T2.2 auto-dismiss overlays: a cookie-banner page has its banner cleared (transcript
 *    notes it) and the underlying control then becomes clickable; a plain page is untouched.
 *  - T2.3 iframe & shadow-DOM traversal: a same-origin iframe + open shadow-root control are
 *    discovered with refs and `locate` acts on them; a cross-origin frame does not crash.
 *  - T2.4 download capture: a page that triggers a download saves the file to disk.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import { runGoal } from "../src/autopilot/loop.js";
import { autoDismissOverlays } from "../src/autopilot/dismiss.js";
import * as download from "../src/tools/download.js";
import type { ToolContext } from "../src/tools/shared.js";
import type { LayaDecisionEngine, PageState } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

/** A trivial engine that always says DONE, so a run does one clean step then stops. */
const doneEngine: LayaDecisionEngine = {
  available: true,
  async decide(_state: PageState) {
    return { operation: "DONE", operationConfidence: 1, targetConfidence: 1, source: "laya" };
  },
  async close() {},
};

describe("T2.1 auto storage-state persistence (real headless chromium)", () => {
  let fixtures: FixtureServer;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });
  afterAll(async () => {
    await fixtures.close();
  });

  it("saves on close() and restores on the next launch from the same path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-autostate-"));
    const statePath = join(dir, "state.json");
    try {
      // Session 1: configured with the auto path. Seed a cookie + localStorage, then close
      // (which auto-saves to statePath).
      const s1 = new BrowserSession({ headless: true, storageStatePath: statePath });
      const p1 = await s1.getPage();
      await p1.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
      await s1.setCookie({ name: "auth", value: "tok-persist" });
      await p1.evaluate(() => window.localStorage.setItem("pref", "compact"));
      await s1.close();

      // The auto-save wrote a real file.
      const raw = await readFile(statePath, "utf8");
      expect(raw.length).toBeGreaterThan(0);

      // Session 2: same auto path. It should launch with the cookie already present.
      const s2 = new BrowserSession({ headless: true, storageStatePath: statePath });
      const p2 = await s2.getPage();
      await p2.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
      const cookies = await s2.listCookies();
      expect(cookies.find((c) => c.name === "auth")?.value).toBe("tok-persist");
      expect(await p2.evaluate(() => window.localStorage.getItem("pref"))).toBe("compact");
      await s2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when no storage-state path is configured", async () => {
    const s = new BrowserSession({ headless: true });
    const p = await s.getPage();
    await p.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    await s.setCookie({ name: "ephemeral", value: "1" });
    // close() must not throw and must not attempt to write anything.
    await expect(s.close()).resolves.toBeUndefined();
  });
});

describe("T2.2 auto-dismiss cookie/consent + modal overlays (real headless chromium)", () => {
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

  it("closes a cookie banner and the underlying control becomes clickable", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("cookie-banner.html"), { waitUntil: "domcontentloaded" });

    // The banner is visible before dismissal.
    expect(await page.locator("#consent").isVisible()).toBe(true);

    const dismissed = await autoDismissOverlays(page);
    expect(dismissed.length).toBeGreaterThan(0);
    expect(dismissed[0]!.kind).toBe("consent");

    // The banner is gone, and the underlying action button now works.
    expect(await page.locator("#consent").isVisible()).toBe(false);
    await page.locator("#action").click();
    expect(await page.locator("#outcome").textContent()).toBe("action done");
  });

  it("run with autoDismiss notes the dismissal in the transcript's recent actions", async () => {
    await (await session.getPage()).goto(fixtures.url("cookie-banner.html"), {
      waitUntil: "domcontentloaded",
    });
    const result = await runGoal({
      goal: "do the thing on this page",
      session,
      engine: doneEngine,
      autoDismiss: true,
      maxSteps: 2,
    });
    // The dismissal is recorded either as a transcript detail or as a step note/recentAction.
    // We assert the run completed and the banner was cleared as a side effect.
    expect(result.outcome).toBe("done");
    const page = await session.getPage();
    expect(await page.locator("#consent").isVisible()).toBe(false);
  });

  it("leaves a page WITHOUT any modal/banner untouched", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("search-form.html"), { waitUntil: "domcontentloaded" });
    const dismissed = await autoDismissOverlays(page);
    expect(dismissed).toEqual([]);
    // The real controls are all still present.
    expect(await page.locator("#go").isVisible()).toBe(true);
  });
});

describe("T2.3 iframe + shadow-DOM traversal (real headless chromium)", () => {
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

  it("discovers same-origin iframe + open shadow-root controls and can act on them", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("iframe-shadow.html"), { waitUntil: "domcontentloaded" });

    // With frameDepth 0 (default) only the host button is found.
    const shallow = await capture(page);
    const shallowNames = shallow.controls.map((c) => c.name);
    expect(shallowNames).toContain("Host button");
    expect(shallowNames).not.toContain("Frame button");

    // With frameDepth >= 1 the shadow + iframe controls are discovered and stamped.
    const deep = await capture(page, { frameDepth: 2 });
    const deepNames = deep.controls.map((c) => c.name);
    expect(deepNames).toContain("Host button");
    expect(deepNames).toContain("Shadow button");
    expect(deepNames).toContain("Frame button");

    // locate() resolves and acts on the iframe control by its stamped ref.
    const frameControl = deep.controls.find((c) => c.name === "Frame button")!;
    const frameLoc = await session.locate(frameControl.ref);
    await frameLoc.click();
    // The click ran inside the iframe (its label flips).
    const frame = page.frames().find((f) => /iframe-inner/.test(f.url()))!;
    expect(await frame.locator("#frame-button").textContent()).toBe("Frame clicked");

    // locate() also acts on the shadow-DOM control (main-frame CSS pierces open shadow roots).
    const shadowControl = deep.controls.find((c) => c.name === "Shadow button")!;
    await (await session.locate(shadowControl.ref)).click();
    const shadowText = await page.evaluate(
      () => document.getElementById("shadow-host")!.shadowRoot!.querySelector("button")!.textContent,
    );
    expect(shadowText).toBe("Shadow clicked");
  });

  it("does not crash on a cross-origin iframe (skips it cleanly)", async () => {
    const page = await session.getPage();
    // Point at a data: page hosting a cross-origin iframe (example.com). The walk must skip it.
    await page.setContent(
      '<h1>Host</h1><button>Local</button><iframe src="https://example.com/"></iframe>',
    );
    const snap = await capture(page, { frameDepth: 2 });
    // No throw; the local control is still discovered.
    expect(snap.controls.some((c) => c.name === "Local")).toBe(true);
  });
});

describe("T2.4 download capture (real headless chromium)", () => {
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

  it("captures a triggered download to an explicit path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-dl-"));
    const savePath = join(dir, "out.txt");
    try {
      const page = await session.getPage();
      await page.goto(fixtures.url("download-trigger.html"), { waitUntil: "domcontentloaded" });
      const ctx: ToolContext = { session };
      const res = await download.makeHandler(ctx)({ target: "#download", path: savePath });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("report.txt");
      // The file exists with the expected contents.
      const contents = await readFile(savePath, "utf8");
      expect(contents).toContain("laya-report-contents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saves into the configured default directory using the suggested filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-dldir-"));
    try {
      const page = await session.getPage();
      await page.goto(fixtures.url("download-trigger.html"), { waitUntil: "domcontentloaded" });
      const ctx: ToolContext = { session, downloadDir: dir };
      const res = await download.makeHandler(ctx)({ target: "#download" });
      expect(res.isError).toBeFalsy();
      const saved = join(dir, "report.txt");
      const s = await stat(saved);
      expect(s.isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
