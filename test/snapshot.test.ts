import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

describe("snapshot capture (real headless chromium, no weights)", () => {
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

  it("extracts controls with stable refs, roles, and names", async () => {
    const page = await session.getPage();
    const snap = await capture(page);

    expect(snap.title).toBe("Sign in");
    expect(snap.url).toContain("login.html");

    const byName = (name: string) => snap.controls.find((c) => c.name === name);

    const email = byName("Email");
    expect(email).toBeDefined();
    expect(email!.role).toBe("textbox");
    expect(email!.type).toBe("email");
    expect(email!.editable).toBe(true);
    expect(email!.ref).toMatch(/^e\d+$/);

    const password = snap.controls.find((c) => c.type === "password");
    expect(password).toBeDefined();
    expect(password!.role).toBe("textbox");

    const role = byName("Role");
    expect(role).toBeDefined();
    expect(role!.role).toBe("combobox");
    expect(role!.options).toEqual(["User", "Admin", "Guest"]);

    const submit = snap.controls.find((c) => c.role === "button" && c.name === "Sign in");
    expect(submit).toBeDefined();
    expect(submit!.tag).toBe("button");

    const checkbox = snap.controls.find((c) => c.type === "checkbox");
    expect(checkbox).toBeDefined();
    expect(checkbox!.role).toBe("checkbox");
    expect(checkbox!.checked).toBe(false);

    // Refs are monotonic and unique.
    const refs = snap.controls.map((c) => c.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("renders a compact text snapshot with [ref=eN] markers", async () => {
    const page = await session.getPage();
    const snap = await capture(page);

    expect(snap.text).toContain("URL:");
    expect(snap.text).toContain('- button "Sign in" [ref=');
    expect(snap.text).toMatch(/\[ref=e\d+\]/);
  });

  it("resolveRef locates the element by the stamped ref", async () => {
    const page = await session.getPage();
    const snap = await capture(page);
    const email = snap.controls.find((c) => c.name === "Email")!;

    const locator = session.resolveRef(email.ref);
    expect(await locator.count()).toBe(1);
    expect(await locator.getAttribute("type")).toBe("email");
  });

  it("treats an unknown target as a raw Playwright selector", async () => {
    const locator = session.resolveRef("#password");
    expect(await locator.count()).toBe(1);
    expect(await locator.getAttribute("type")).toBe("password");
  });

  it("is re-runnable and assigns refs idempotently", async () => {
    const page = await session.getPage();
    const first = await capture(page);
    const second = await capture(page);
    expect(second.controls.map((c) => c.name)).toEqual(first.controls.map((c) => c.name));
    expect(second.controls.map((c) => c.ref)).toEqual(first.controls.map((c) => c.ref));
  });
});
