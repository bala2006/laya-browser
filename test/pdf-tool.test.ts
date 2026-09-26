import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as pdf from "../src/tools/pdf.js";
import { assistToolNames } from "../src/tools/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("PDF capability tool (real headless chromium, offline)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    ctx = { session };
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("browser_pdf_save writes a non-empty PDF file starting with %PDF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-pdf-test-"));
    const outPath = join(dir, "out.pdf");
    try {
      const res = await pdf.makeHandler(ctx)({ path: outPath });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain(outPath);

      const bytes = await readFile(outPath);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pdf tool is gated behind the 'pdf' capability", async () => {
    expect(assistToolNames([])).not.toContain("browser_pdf_save");
    expect(assistToolNames(["pdf"])).toContain("browser_pdf_save");
    // Not pulled in by unrelated capabilities.
    expect(assistToolNames(["testing"])).not.toContain("browser_pdf_save");
  });
});
