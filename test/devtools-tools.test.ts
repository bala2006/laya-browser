import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as devtools from "../src/tools/devtools.js";
import { assistToolNames } from "../src/tools/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("DEVTOOLS capability tools (real headless chromium, offline)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    ctx = { session };
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("start_tracing + stop_tracing writes a non-empty trace zip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-trace-"));
    const tracePath = join(dir, "trace.zip");
    try {
      const start = await devtools.makeStartTracingHandler(ctx)();
      expect(start.isError).toBeFalsy();

      // Do some work so the trace has content.
      await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });

      const stop = await devtools.makeStopTracingHandler(ctx)({ path: tracePath });
      expect(stop.isError).toBeFalsy();
      expect(textOf(stop)).toContain(tracePath);

      const info = await stat(tracePath);
      expect(info.size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("highlight adds an outline to the target and hide_highlight removes it", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
    const page = await session.getPage();

    const res = await devtools.makeHighlightHandler(ctx)({ target: "#ready" });
    expect(res.isError).toBeFalsy();
    const outline = await page.locator("#ready").evaluate((el) => (el as HTMLElement).style.outline);
    expect(outline).toContain("solid");

    const hide = await devtools.makeHideHighlightHandler(ctx)();
    expect(hide.isError).toBeFalsy();
    const cleared = await page.locator("#ready").evaluate((el) => (el as HTMLElement).style.outline);
    expect(cleared).toBe("");
  });

  it("highlight returns an error when no element matches", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
    const res = await devtools.makeHighlightHandler(ctx)({ target: "#does-not-exist" });
    expect(res.isError).toBe(true);
  });

  it("interactive/codegen tools honestly report they are not supported headless (no fake success)", async () => {
    const recording = await devtools.startRecordingModule.makeHandler(ctx)(undefined as never);
    expect(textOf(recording)).toContain("not fully supported");
    expect(recording.isError).toBeFalsy();

    const video = await devtools.startVideoModule.makeHandler(ctx)(undefined as never);
    expect(textOf(video)).toContain("not fully supported");

    const resume = await devtools.resumeModule.makeHandler(ctx)(undefined as never);
    expect(textOf(resume)).toContain("not fully supported");

    const annotate = await devtools.annotateModule.makeHandler(ctx)(undefined as never);
    expect(textOf(annotate)).toContain("not fully supported");
  });

  it("devtools tools are gated behind the 'devtools' capability", () => {
    const coreOnly = assistToolNames([]);
    expect(coreOnly).not.toContain("browser_start_tracing");
    expect(coreOnly).not.toContain("browser_highlight");

    const withDevtools = assistToolNames(["devtools"]);
    expect(withDevtools).toContain("browser_start_tracing");
    expect(withDevtools).toContain("browser_stop_tracing");
    expect(withDevtools).toContain("browser_highlight");
    expect(withDevtools).toContain("browser_hide_highlight");
    expect(withDevtools).toContain("browser_start_video");
    expect(withDevtools).toContain("browser_stop_video");
    expect(withDevtools).toContain("browser_video_chapter");
    expect(withDevtools).toContain("browser_video_show_actions");
    expect(withDevtools).toContain("browser_video_hide_actions");
    expect(withDevtools).toContain("browser_start_recording");
    expect(withDevtools).toContain("browser_stop_recording");
    expect(withDevtools).toContain("browser_annotate");
    expect(withDevtools).toContain("browser_resume");
    expect(withDevtools).not.toContain("browser_pdf_save");
  });
});
