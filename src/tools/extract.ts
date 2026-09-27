/**
 * (T1.2) `browser_extract` (a.k.a. `ask_page`) — answer a natural-language question from the
 * current page's readable text WITHOUT dumping the whole page into the model context.
 *
 * Frontier browser-agent work (browser-use "Speed Matters"; Playwright-MCP token-bloat
 * analyses) shows that shipping the entire DOM/text of a page to the LLM on every read is the
 * dominant token cost. This tool inverts that: it reads a BOUNDED slice of the page's readable
 * text, ranks the passages by lexical overlap with the question, and then:
 *   - if the client supports MCP sampling (a {@link SampleFn} was threaded into the tool
 *     context, mirroring how the Autopilot loop wires `samplerFromServer`), it runs a SCOPED
 *     sampling call over only the most relevant passages and returns the model's focused
 *     answer; otherwise
 *   - it degrades to returning the single most relevant text span (no sampling, never throws).
 *
 * Secrets are redacted from the returned text (B1 reuse), so a token/key that happens to sit
 * in the page text is masked in the answer/span. No stdout writes — the result is an MCP text
 * block. Registered under the `vision` capability group (it is a read/perception aid).
 */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";
import { redactText } from "../redact.js";

/** How much readable text we pull from the page before ranking. Bounds the token cost. */
const DEFAULT_MAX_CHARS = 20000;
/** How many top-ranked passages we hand to the sampler / consider for the best span. */
const DEFAULT_TOP_K = 6;
/** How much text (chars) we send to the sampler at most, after selecting the top passages. */
const SAMPLING_CONTEXT_BUDGET = 6000;

export const inputSchema = {
  question: z
    .string()
    .describe(
      "The natural-language question to answer from the current page's readable text, e.g. 'What is the return policy?'.",
    ),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum characters of page text to read before ranking. Defaults to 20000; clamped to a sane range.",
    ),
};

type Args = { question: string; maxChars?: number };

/**
 * Split page text into passages (paragraph-ish blocks). We split on blank lines first, then
 * fall back to single newlines, so both dense and sparse pages yield reasonable passages.
 */
export function splitPassages(text: string): string[] {
  const byBlank = text
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  if (byBlank.length > 1) return byBlank;
  // Single-block page: split on newlines so we still get rankable passages.
  return text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/** Tokenise into lower-cased word tokens for lexical overlap scoring. */
function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Common English stopwords dropped from the QUERY terms so that content words (e.g. "return",
 * "policy") drive the ranking instead of high-frequency filler ("the", "is", "what"). Kept
 * small and dependency-free.
 */
const STOPWORDS = new Set<string>([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "of", "to", "in", "on", "for",
  "and", "or", "what", "which", "who", "whom", "how", "when", "where", "why", "do", "does",
  "did", "this", "that", "these", "those", "it", "its", "as", "at", "by", "with", "about",
  "page", "say", "says", "tell", "me", "please",
]);

/** Query terms with stopwords removed (falls back to all terms if that would empty the set). */
function queryTermSet(question: string): Set<string> {
  const all = tokens(question);
  const contentful = all.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  return new Set(contentful.length > 0 ? contentful : all);
}

/**
 * Score a passage against the question's terms by term-frequency overlap, lightly normalised
 * by passage length so a huge passage does not dominate purely by size. Deterministic and
 * dependency-free (no embeddings) so it stays fast and testable offline.
 */
export function scorePassage(passage: string, queryTerms: Set<string>): number {
  const words = tokens(passage);
  if (words.length === 0) return 0;
  let hits = 0;
  for (const w of words) if (queryTerms.has(w)) hits += 1;
  if (hits === 0) return 0;
  // Reward overlap, mildly penalise very long passages (length normalisation with a floor).
  return hits / Math.sqrt(Math.max(20, words.length));
}

/** Rank passages against the question, returning the top `k` (highest score first). */
export function rankPassages(
  passages: string[],
  question: string,
  k: number,
): string[] {
  const queryTerms = queryTermSet(question);
  if (queryTerms.size === 0) return passages.slice(0, k);
  const scored = passages
    .map((p, i) => ({ p, i, score: scorePassage(p, queryTerms) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i));
  if (scored.length === 0) return passages.slice(0, k);
  return scored.slice(0, k).map((e) => e.p);
}

/**
 * Build the SCOPED sampling prompt: a small, stable instruction prefix followed by only the
 * most relevant page passages and the question. Bounded by {@link SAMPLING_CONTEXT_BUDGET} so
 * the model never receives the whole page. Kept prefix-first for KV-cache-friendliness (T1.1).
 */
export function buildExtractPrompt(question: string, passages: string[]): string {
  let budget = SAMPLING_CONTEXT_BUDGET;
  const kept: string[] = [];
  for (const p of passages) {
    if (budget <= 0) break;
    const slice = p.slice(0, budget);
    kept.push(slice);
    budget -= slice.length;
  }
  return [
    "You answer a question using ONLY the page excerpts below. Be concise and factual.",
    "If the excerpts do not contain the answer, say you could not find it on the page.",
    "",
    "----- PAGE EXCERPTS -----",
    kept.join("\n\n"),
    "----- QUESTION -----",
    question,
  ].join("\n");
}

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      const page = await ctx.session.getPage();
      // (T3.2) Surface a distinct "reading page" state on the HUD while extracting. Best-effort
      // and guarded (no-op when the overlay is disabled), so it never affects the read.
      const overlay = ctx.session.getOverlay();
      await overlay.setState(page, "thinking");
      await overlay.setStatus(page, "Reading page\u2026");
      await overlay.toast(page, "Extracting from page\u2026", "info");
      const maxChars = Math.max(500, Math.min(60000, args.maxChars ?? DEFAULT_MAX_CHARS));

      // Read a BOUNDED slice of the page's readable text (never the whole DOM). innerText
      // gives rendered, visible text; we clamp before any ranking so token cost is bounded.
      const rawText = await page
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => "");
      const text = rawText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      const bounded = text.slice(0, maxChars);

      if (bounded.length === 0) {
        return textResult("The page has no readable text to extract from.");
      }

      const passages = splitPassages(bounded);
      const top = rankPassages(passages, args.question, DEFAULT_TOP_K);

      // If the client supports sampling, run a SCOPED sampling call over only the top
      // passages and return the focused answer. Redact secrets from the model's answer.
      if (ctx.sample) {
        try {
          const prompt = buildExtractPrompt(args.question, top);
          const answer = await ctx.sample(prompt);
          const cleaned = answer.trim();
          if (cleaned.length > 0) {
            return textResult(redactText(cleaned));
          }
          // Empty answer: fall through to the span fallback below.
        } catch {
          // Sampling failed at runtime; degrade to the best-span fallback (never throw).
        }
      }

      // No sampler (or sampling failed/empty): return the single most relevant span.
      const best = top[0] ?? bounded.slice(0, 800);
      const span = best.length > 1200 ? best.slice(0, 1200).trimEnd() + "\u2026" : best;
      const header = ctx.sample
        ? "(sampling unavailable for this answer; most relevant page text:)"
        : "(no MCP sampling; most relevant page text for your question:)";
      return textResult(`${header}\n\n${redactText(span)}`);
    } catch (err) {
      return textResult(`browser_extract failed: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "browser_extract",
  description:
    "Answer a natural-language question from the CURRENT page's readable text without dumping the whole page: reads a bounded text slice, ranks the most relevant passages, and (when the client supports MCP sampling) runs a scoped sampling call over just those passages; otherwise returns the most relevant text span. Also known as ask_page. Secrets in the text are redacted.",
  inputSchema,
};
