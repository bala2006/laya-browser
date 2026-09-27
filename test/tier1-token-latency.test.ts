/**
 * Tier 1 (token & latency) tests.
 *
 *  - T1.1 KV-cache-friendly prompt ordering: the STABLE role/instructions/response-format
 *    prefix comes FIRST and the VOLATILE page state comes LAST in both the full and delta
 *    escalation prompts, AND all the information the old prompt carried is preserved.
 *  - T1.2 extract/ask_page tool: focused answer via a FAKE sampler, the no-sampler fallback
 *    span, and secret redaction in the output.
 *  - T1.3 bounded visibleText: a huge-text page is clamped in the built state / rendered
 *    prompt, and a truncation hint pointing at `extract` is emitted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ESCALATION_PROMPT_PREFIX,
  buildEscalationPrompt,
  buildDeltaEscalationPrompt,
} from "../src/autopilot/escalation.js";
import {
  splitPassages,
  rankPassages,
  buildExtractPrompt,
  makeHandler as makeExtractHandler,
} from "../src/tools/extract.js";
import { buildState, renderState } from "../src/state-builder.js";
import { capture } from "../src/snapshot.js";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import type { PageState, SnapshotDiff } from "../src/types.js";
import { asRef } from "../src/types.js";
import { diffSnapshots } from "../src/snapshot-diff.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

const sampleState: PageState = {
  goal: "buy a red widget",
  url: "http://example.test/shop",
  title: "Shop",
  visibleText: "Widgets on sale",
  controls: [
    { ref: asRef("e1"), index: 1, role: "textbox", name: "Quantity", tag: "input", editable: true },
    { ref: asRef("e2"), index: 2, role: "button", name: "Add to cart", tag: "button", editable: false },
  ],
  recentActions: ["opened the shop"],
};

describe("T1.1 KV-cache-friendly escalation prompt ordering", () => {
  it("puts the stable prefix FIRST and the volatile page state LAST (full prompt)", () => {
    const prompt = buildEscalationPrompt(sampleState);
    expect(prompt.startsWith(ESCALATION_PROMPT_PREFIX)).toBe(true);
    const prefixEnd = ESCALATION_PROMPT_PREFIX.length;
    const stateStart = prompt.indexOf("GOAL: buy a red widget");
    // Everything volatile (goal/url/title/controls) appears AFTER the whole stable prefix.
    expect(stateStart).toBeGreaterThan(prefixEnd);
    // The response-format spec (stable) appears BEFORE the volatile goal line.
    expect(prompt.indexOf('"operation"')).toBeLessThan(stateStart);
  });

  it("preserves ALL the information the render carries (behaviour-preserving reorder)", () => {
    const prompt = buildEscalationPrompt(sampleState);
    const rendered = renderState(sampleState);
    // The full rendered state block is present verbatim in the prompt (just relocated).
    expect(prompt).toContain(rendered);
    // Spot-check individual facts survive.
    expect(prompt).toContain("buy a red widget");
    expect(prompt).toContain("[e1]");
    expect(prompt).toContain("[e2]");
    expect(prompt).toContain("Add to cart");
    expect(prompt).toContain("opened the shop");
  });

  it("puts the stable prefix FIRST in the delta prompt too, controls listed last", () => {
    const diff: SnapshotDiff = {
      added: [
        { ref: asRef("e2"), index: 2, role: "button", name: "Add to cart", tag: "button", editable: false },
      ],
      removed: [],
      changed: [],
    };
    const prompt = buildDeltaEscalationPrompt(sampleState, diff);
    expect(prompt.startsWith(ESCALATION_PROMPT_PREFIX)).toBe(true);
    expect(prompt.indexOf('"operation"')).toBeLessThan(prompt.indexOf("GOAL:"));
    // The delta's NEW CONTROLS and the CURRENT CONTROLS are both present (info preserved).
    expect(prompt).toContain("NEW CONTROLS");
    expect(prompt).toContain("CURRENT CONTROLS");
    expect(prompt).toContain("[e2]");
  });
});

describe("T1.2 extract ranking helpers (pure)", () => {
  it("splits paragraphs and ranks the passage most relevant to the question first", () => {
    const text =
      "Shipping is free for orders over fifty dollars.\n\n" +
      "Our return policy allows returns within thirty days with a receipt.\n\n" +
      "Contact support during business hours.";
    const passages = splitPassages(text);
    expect(passages.length).toBe(3);
    const top = rankPassages(passages, "what is the return policy", 1);
    expect(top[0]).toContain("return policy");
  });

  it("builds a scoped prompt that includes the question and only the given passages", () => {
    const prompt = buildExtractPrompt("return policy?", ["returns within thirty days"]);
    expect(prompt).toContain("return policy?");
    expect(prompt).toContain("returns within thirty days");
    expect(prompt).toContain("PAGE EXCERPTS");
  });
});

describe("T1.2/T1.3 extract tool + bounded visibleText (real headless chromium)", () => {
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

  it("answers a question via a FAKE sampler over a scoped slice (not the whole page)", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("big-text.html"), { waitUntil: "domcontentloaded" });

    let seenPromptLength = Number.POSITIVE_INFINITY;
    const ctx: ToolContext = {
      session,
      sample: async (prompt: string) => {
        seenPromptLength = prompt.length;
        // The sampler should receive only a scoped excerpt, not the ~15k-char page.
        expect(prompt).toContain("return policy");
        return "Returns are accepted within 30 days with a receipt.";
      },
    };
    const res = await makeExtractHandler(ctx)({ question: "What is the return policy?" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("30 days");
    // The scoped prompt is far smaller than the full page text.
    const fullLen = (await page.evaluate(() => document.body.innerText)).length;
    expect(seenPromptLength).toBeLessThan(fullLen);
  });

  it("falls back to the most relevant text span when no sampler is available", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("big-text.html"), { waitUntil: "domcontentloaded" });
    const ctx: ToolContext = { session }; // no sample callback
    const res = await makeExtractHandler(ctx)({ question: "What is the return policy?" });
    expect(res.isError).toBeFalsy();
    const out = textOf(res);
    expect(out).toContain("no MCP sampling");
    expect(out.toLowerCase()).toContain("return policy");
  });

  it("redacts a secret that appears in the sampler's answer", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("big-text.html"), { waitUntil: "domcontentloaded" });
    const ctx: ToolContext = {
      session,
      sample: async () => "The API key is sk-abcdefghij0123456789 per the docs.",
    };
    const res = await makeExtractHandler(ctx)({ question: "what is the key" });
    const out = textOf(res);
    expect(out).not.toContain("sk-abcdefghij0123456789");
    expect(out).toContain("\u2022\u2022\u2022\u2022");
  });

  it("clamps visible text in the built state and emits an extract hint", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("big-text.html"), { waitUntil: "domcontentloaded" });
    const snap = await capture(page);
    // Build state with an explicit small budget (as the loop does from stateTextLimit).
    const state = buildState("read the handbook", snap, [], { maxVisibleText: 500 });
    expect(state.visibleText.length).toBeLessThanOrEqual(501); // 500 + ellipsis
    expect(state.visibleText.endsWith("\u2026")).toBe(true);
    const rendered = renderState(state);
    expect(rendered).toContain("use the `extract`");
  });
});
