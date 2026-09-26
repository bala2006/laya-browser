import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as cookies from "../src/tools/cookies.js";
import * as localStorageTools from "../src/tools/localstorage.js";
import * as sessionStorageTools from "../src/tools/sessionstorage.js";
import * as storageState from "../src/tools/storage_state.js";
import { assistToolNames } from "../src/tools/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("STORAGE capability tools (real headless chromium, offline)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    ctx = { session };
    // Land on a real http origin so cookies + web storage have a valid scope.
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("cookie set -> get round-trips, and clear empties the list", async () => {
    const setRes = await cookies.makeSetHandler(ctx)({ name: "session_id", value: "abc123" });
    expect(setRes.isError).toBeFalsy();

    const getRes = await cookies.makeGetHandler(ctx)({ name: "session_id" });
    expect(getRes.isError).toBeFalsy();
    expect(textOf(getRes)).toContain("session_id=abc123");

    // Verify via the raw boundary too, not only via the tool's own rendering.
    const raw = await session.listCookies();
    expect(raw.find((c) => c.name === "session_id")?.value).toBe("abc123");

    const clearRes = await cookies.makeClearHandler(ctx)();
    expect(clearRes.isError).toBeFalsy();
    const listRes = await cookies.makeListHandler(ctx)();
    expect(textOf(listRes)).toBe("No cookies set.");
    expect(await session.listCookies()).toHaveLength(0);
  });

  it("cookie delete removes a single named cookie", async () => {
    await cookies.makeSetHandler(ctx)({ name: "keep", value: "1" });
    await cookies.makeSetHandler(ctx)({ name: "drop", value: "2" });
    await cookies.makeDeleteHandler(ctx)({ name: "drop" });
    const names = (await session.listCookies()).map((c) => c.name);
    expect(names).toContain("keep");
    expect(names).not.toContain("drop");
    await cookies.makeClearHandler(ctx)();
  });

  it("localStorage set/get round-trips (verified via page.evaluate too)", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();

    const setRes = await localStorageTools.set.makeHandler(ctx)({ key: "theme", value: "dark" });
    expect(setRes.isError).toBeFalsy();

    const getRes = await localStorageTools.get.makeHandler(ctx)({ key: "theme" });
    expect(textOf(getRes)).toBe("dark");

    // Independent verification straight from the page.
    expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe("dark");

    const listRes = await localStorageTools.list.makeHandler(ctx)();
    expect(textOf(listRes)).toContain("theme=dark");

    await localStorageTools.del.makeHandler(ctx)({ key: "theme" });
    expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBeNull();

    await localStorageTools.set.makeHandler(ctx)({ key: "a", value: "1" });
    await localStorageTools.clear.makeHandler(ctx)();
    expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  });

  it("sessionStorage set/get round-trips (verified via page.evaluate too)", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();

    await sessionStorageTools.set.makeHandler(ctx)({ key: "step", value: "2" });
    const getRes = await sessionStorageTools.get.makeHandler(ctx)({ key: "step" });
    expect(textOf(getRes)).toBe("2");
    expect(await page.evaluate(() => window.sessionStorage.getItem("step"))).toBe("2");

    await sessionStorageTools.clear.makeHandler(ctx)();
    expect(await page.evaluate(() => window.sessionStorage.length)).toBe(0);
  });

  it("storage_state writes a non-empty JSON file that set_storage_state restores", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-storage-"));
    const statePath = join(dir, "state.json");
    try {
      // Seed a cookie + localStorage entry, then persist.
      await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
      await cookies.makeSetHandler(ctx)({ name: "auth", value: "tok-xyz" });
      await localStorageTools.set.makeHandler(ctx)({ key: "pref", value: "compact" });

      const saveRes = await storageState.makeSaveHandler(ctx)({ path: statePath });
      expect(saveRes.isError).toBeFalsy();

      // The file exists, parses, and actually contains the seeded data.
      const raw = await readFile(statePath, "utf8");
      expect(raw.length).toBeGreaterThan(0);
      const parsed = JSON.parse(raw) as {
        cookies: Array<{ name: string; value: string }>;
        origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
      };
      expect(parsed.cookies.find((c) => c.name === "auth")?.value).toBe("tok-xyz");
      const originEntry = parsed.origins
        .flatMap((o) => o.localStorage)
        .find((e) => e.name === "pref");
      expect(originEntry?.value).toBe("compact");

      // Wipe the live state, then restore from the file and confirm both come back.
      await cookies.makeClearHandler(ctx)();
      await localStorageTools.clear.makeHandler(ctx)();
      expect(await session.listCookies()).toHaveLength(0);

      const restoreRes = await storageState.makeRestoreHandler(ctx)({ path: statePath });
      expect(restoreRes.isError).toBeFalsy();

      const cookiesAfter = await session.listCookies();
      expect(cookiesAfter.find((c) => c.name === "auth")?.value).toBe("tok-xyz");
      const page = await session.getPage();
      expect(await page.evaluate(() => window.localStorage.getItem("pref"))).toBe("compact");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("storage tools are gated behind the 'storage' capability", async () => {
    const coreOnly = assistToolNames([]);
    expect(coreOnly).not.toContain("browser_cookie_set");
    expect(coreOnly).not.toContain("browser_localstorage_set");
    expect(coreOnly).not.toContain("browser_storage_state");

    const withStorage = assistToolNames(["storage"]);
    expect(withStorage).toContain("browser_cookie_list");
    expect(withStorage).toContain("browser_cookie_get");
    expect(withStorage).toContain("browser_cookie_set");
    expect(withStorage).toContain("browser_cookie_delete");
    expect(withStorage).toContain("browser_cookie_clear");
    expect(withStorage).toContain("browser_localstorage_list");
    expect(withStorage).toContain("browser_localstorage_get");
    expect(withStorage).toContain("browser_localstorage_set");
    expect(withStorage).toContain("browser_localstorage_delete");
    expect(withStorage).toContain("browser_localstorage_clear");
    expect(withStorage).toContain("browser_sessionstorage_set");
    expect(withStorage).toContain("browser_storage_state");
    expect(withStorage).toContain("browser_set_storage_state");
  });
});
