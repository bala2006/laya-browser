/**
 * Safety-guard tests.
 *
 * Asserts literal outcomes:
 *   - the domain allow-list blocks navigation to off-list hosts (both the pure guard, the
 *     Assist `browser_navigate` tool, and the Autopilot loop's initial navigation);
 *   - the destructive-form guard prevents Autopilot auto-submit on a fixture with a
 *     "Delete account" / "Pay now" button, surfacing the reason, and the page is NOT mutated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal } from "../src/autopilot/loop.js";
import { StubEngine } from "../src/laya/index.js";
import * as navigate from "../src/tools/navigate.js";
import * as click from "../src/tools/click.js";
import { capture } from "../src/snapshot.js";
import {
  checkDomainAllowed,
  checkDestructiveSubmit,
  hostOf,
} from "../src/safety.js";
import type { Control, PageState } from "../src/types.js";
import { asRef } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("domain allow-list (pure guard)", () => {
  it("allows everything when no list is configured", () => {
    expect(checkDomainAllowed("https://anything.example/", []).allowed).toBe(true);
  });

  it("allows a listed host and its subdomains", () => {
    expect(checkDomainAllowed("https://example.com/x", ["example.com"]).allowed).toBe(true);
    expect(checkDomainAllowed("https://app.example.com/x", ["example.com"]).allowed).toBe(true);
  });

  it("blocks an off-list host with a reason", () => {
    const v = checkDomainAllowed("https://evil.test/x", ["example.com"]);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("evil.test");
    expect(v.reason).toContain("allow-list");
  });

  it("fails closed on an unparseable target when a list is configured", () => {
    expect(checkDomainAllowed("not a url", ["example.com"]).allowed).toBe(false);
  });

  it("extracts hosts from URLs and bare hosts", () => {
    expect(hostOf("https://a.b.com/x")).toBe("a.b.com");
    expect(hostOf("a.b.com")).toBe("a.b.com");
    expect(hostOf("localhost")).toBe("localhost");
    expect(hostOf("garbage")).toBeUndefined();
  });
});

describe("destructive-form guard (pure guard)", () => {
  const deleteBtn: Control = {
    ref: asRef("e1"),
    index: 1,
    role: "button",
    name: "Delete account",
    tag: "button",
    editable: false,
  };
  const payBtn: Control = {
    ref: asRef("e2"),
    index: 1,
    role: "button",
    name: "Pay now",
    tag: "button",
    editable: false,
  };
  const baseState: PageState = {
    goal: "g",
    url: "http://x/",
    title: "t",
    visibleText: "",
    controls: [],
    recentActions: [],
  };

  it("refuses a 'Delete account' submit and surfaces the reason", () => {
    const v = checkDestructiveSubmit(deleteBtn, { ...baseState, controls: [deleteBtn] });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("destructive");
  });

  it("refuses a 'Pay now' submit", () => {
    const v = checkDestructiveSubmit(payBtn, { ...baseState, controls: [payBtn] });
    expect(v.allowed).toBe(false);
  });

  it("refuses a password + payment field combination", () => {
    const pwd: Control = { ref: asRef("e3"), index: 1, role: "textbox", name: "Password", tag: "input", type: "password", editable: true };
    const card: Control = { ref: asRef("e4"), index: 2, role: "textbox", name: "Card number", tag: "input", type: "text", editable: true };
    const submit: Control = { ref: asRef("e5"), index: 3, role: "button", name: "Continue", tag: "button", editable: false };
    const v = checkDestructiveSubmit(submit, { ...baseState, controls: [pwd, card, submit] });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("password");
  });

  it("allows a benign submit", () => {
    const ok: Control = { ref: asRef("e6"), index: 1, role: "button", name: "Search", tag: "button", editable: false };
    const v = checkDestructiveSubmit(ok, { ...baseState, controls: [ok] });
    expect(v.allowed).toBe(true);
  });

  it("is inert when disabled", () => {
    expect(checkDestructiveSubmit(deleteBtn, { ...baseState, controls: [deleteBtn] }, false).allowed).toBe(true);
  });
});

describe("browser_navigate honours the allow-list", () => {
  let session: BrowserSession;
  afterAll(async () => {
    await session.close();
  });

  it("blocks an off-list URL before touching the browser", async () => {
    session = new BrowserSession({ headless: true });
    const handler = navigate.makeHandler({ session, allowedDomains: ["example.com"] });
    const result = await handler({ url: "https://evil.test/" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("allow-list");
    // The browser was never launched because the guard rejected before getPage().
    expect(session.launched).toBe(false);
  });
});

describe("Autopilot safety (real chromium, no weights)", () => {
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

  it("(R3) proceeds off the allow-list with a warning when there is nobody to ask", async () => {
    // The allow-list used to abort the whole goal before a single step ran, so one off-list URL
    // left the goal command unable to do anything at all. It is now advisory when no confirm
    // callback is available: the run proceeds and SAYS SO, instead of silently doing nothing.
    const result = await runGoal({
      goal: 'search for "laptops" and expect "Showing results for laptops"',
      session,
      engine: new StubEngine(),
      url: fixtures.url("search-form.html"),
      allowedDomains: ["example.com"],
      maxSteps: 3,
    });
    expect(result.degraded).toBe(false);
    expect(result.outcome).not.toBe("blocked");
    expect(result.warnings?.join(" ")).toContain("allow-list");
    // It really ran against the real page (literal marker, not a self-report).
    const page = await session.getPage();
    expect(page.url()).toContain("search-form.html");
  });

  it("(R3) still blocks off the allow-list when a confirm callback refuses", async () => {
    let asked = "";
    const result = await runGoal({
      goal: 'search for "laptops"',
      session,
      engine: new StubEngine(),
      url: fixtures.url("search-form.html"),
      allowedDomains: ["example.com"],
      confirm: async (prompt) => {
        asked = prompt;
        return false;
      },
      maxSteps: 3,
    });
    expect(asked).toContain("allow-list");
    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("allow-list");
    expect(result.transcript.length).toBe(0);
  });

  it("refuses to auto-submit a 'Delete account' form and surfaces the reason", async () => {
    // An engine that wants to click the destructive button. The loop's destructive-form
    // guard must intercept it before the click executes.
    const clickDeleteEngine: import("../src/types.js").LayaDecisionEngine = {
      available: true,
      async decide(state) {
        const del = state.controls.find((c) => /delete/i.test(c.name));
        if (del) {
          return {
            operation: "CLICK",
            operationConfidence: 0.99,
            target: del.ref,
            targetConfidence: 0.99,
            source: "laya",
          };
        }
        return { operation: "BLOCKED", operationConfidence: 1, targetConfidence: 1, source: "laya" };
      },
      async close() {},
    };
    const result = await runGoal({
      goal: 'delete the account and expect "Account deleted"',
      session,
      engine: clickDeleteEngine,
      url: fixtures.url("delete-account.html"),
      maxSteps: 4,
    });
    // The guard must stop the run before the destructive submit executes.
    expect(result.outcome).toBe("blocked");
    const last = result.transcript.at(-1);
    expect(last?.operation).toBe("BLOCKED");
    expect(last?.detail).toContain("destructive-form guard");
    expect(last?.note).toMatch(/destructive|delete/i);

    // The page was NOT mutated: the account is still active.
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("Account active");
  });

  it("refuses to auto-submit a 'Pay now' checkout form", async () => {
    const clickPayEngine: import("../src/types.js").LayaDecisionEngine = {
      available: true,
      async decide(state) {
        const pay = state.controls.find((c) => /pay/i.test(c.name));
        if (pay) {
          return {
            operation: "CLICK",
            operationConfidence: 0.99,
            target: pay.ref,
            targetConfidence: 0.99,
            source: "laya",
          };
        }
        return { operation: "BLOCKED", operationConfidence: 1, targetConfidence: 1, source: "laya" };
      },
      async close() {},
    };
    const result = await runGoal({
      goal: 'pay for the order and expect "Payment complete"',
      session,
      engine: clickPayEngine,
      url: fixtures.url("checkout.html"),
      maxSteps: 4,
    });
    expect(result.outcome).toBe("blocked");
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("Cart pending");
  });
});

describe("B3 assist-tool destructive guard (opt-in, default OFF)", () => {
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

  it("refuses a 'Delete account' click when the guard is enabled and does not mutate the page", async () => {
    await navigate.makeHandler({ session })({ url: fixtures.url("delete-account.html") });
    const page = await session.getPage();
    const snap = await capture(page);
    const deleteRef = snap.controls.find((c) => /delete/i.test(c.name))!.ref;
    expect(await page.locator("#status").textContent()).toBe("Account active");

    const handler = click.makeHandler({ session, assistDestructiveGuard: true });
    const result = await handler({ target: deleteRef, element: "Delete account" });

    // The click is refused with the guard reason surfaced, and the page is NOT mutated.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/destructive|delete/i);
    expect(await page.locator("#status").textContent()).toBe("Account active");
  });

  it("clicks normally when the guard is off (default), mutating the page", async () => {
    await navigate.makeHandler({ session })({ url: fixtures.url("delete-account.html") });
    const page = await session.getPage();
    const snap = await capture(page);
    const deleteRef = snap.controls.find((c) => /delete/i.test(c.name))!.ref;

    // Default context: no assistDestructiveGuard -> behaviour unchanged, the click proceeds.
    const handler = click.makeHandler({ session });
    const result = await handler({ target: deleteRef, element: "Delete account" });

    expect(result.isError).toBeFalsy();
    expect(await page.locator("#status").textContent()).toBe("Account deleted");
  });
});
