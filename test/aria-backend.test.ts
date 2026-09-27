/**
 * (C1) Accessibility-tree snapshot backend tests (real headless chromium).
 *
 * captureAria maps Playwright's ARIA snapshot into the SAME Snapshot / Control[] contract as
 * the DOM walk, and crucially stamps `data-laya-ref="eN"` so resolveRef('eN') still resolves
 * the matched elements. These tests assert the roles/names come through and that ref
 * resolution works after an aria capture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { capture, captureAria } from "../src/snapshot.js";
import { runGoal } from "../src/autopilot/loop.js";
import { StubEngine } from "../src/laya/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

describe("aria snapshot backend (real headless chromium, no weights)", () => {
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

  it("returns a valid Control[] with expected roles and names", async () => {
    const page = await session.getPage();
    const snap = await captureAria(page);

    expect(snap.title).toBe("Sign in");
    expect(snap.url).toContain("login.html");
    expect(snap.controls.length).toBeGreaterThan(0);

    const byName = (name: string) => snap.controls.find((c) => c.name === name);

    const email = byName("Email");
    expect(email).toBeDefined();
    expect(email!.role).toBe("textbox");
    expect(email!.type).toBe("email");
    expect(email!.editable).toBe(true);
    expect(email!.ref).toMatch(/^e\d+$/);

    const submit = snap.controls.find(
      (c) => c.role === "button" && c.name === "Sign in",
    );
    expect(submit).toBeDefined();
    expect(submit!.tag).toBe("button");

    const role = byName("Role");
    expect(role).toBeDefined();
    expect(role!.role).toBe("combobox");
    // The combobox options come through, mapped from the live <select> element.
    expect(role!.options).toEqual(["User", "Admin", "Guest"]);

    // Every ref is unique and monotonic.
    const refs = snap.controls.map((c) => c.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("stamps data-laya-ref so resolveRef('eN') still resolves the element", async () => {
    const page = await session.getPage();
    const snap = await captureAria(page);
    const email = snap.controls.find((c) => c.name === "Email")!;

    const locator = session.resolveRef(email.ref);
    expect(await locator.count()).toBe(1);
    expect(await locator.getAttribute("type")).toBe("email");
  });

  it("is selectable through capture({ backend: 'aria' })", async () => {
    const page = await session.getPage();
    const viaCapture = await capture(page, { backend: "aria" });
    expect(viaCapture.controls.some((c) => c.name === "Email")).toBe(true);
    expect(viaCapture.text).toMatch(/\[ref=e\d+\]/);
  });

  it("drives a goal to success with the aria backend", async () => {
    const runSession = new BrowserSession({ headless: true });
    try {
      const result = await runGoal({
        goal: 'email is "user@example.com" and expect "Signed in as user@example.com"',
        session: runSession,
        engine: new StubEngine(),
        url: fixtures.url("login.html"),
        maxSteps: 8,
        snapshotBackend: "aria",
      });
      expect(result.outcome).toBe("done");
      expect(result.verification.checked).toBe(true);
      expect(result.verification.verified).toBe(true);
    } finally {
      await runSession.close();
    }
  }, 30_000);
});
