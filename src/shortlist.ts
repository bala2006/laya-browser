/**
 * Relevance shortlist: which controls the model gets to see when a page has more than it can
 * be offered (Laya's option budget holds ~20).
 *
 * Keeping the first N in DOM order hands the model a site's navigation chrome and hides the
 * element the goal names further down (a 50-link store page, a 25-field settings form). The
 * model cannot pick what it is never offered, so on real-site scale the shortlist, not the
 * model, is the accuracy ceiling (the Mind2Web fine-tune reports the same: a lexical ranker
 * lifted recall of the correct element from 0.69 to 0.79).
 *
 * Score = rare-word overlap between the goal + recent actions and the control's own text
 * (name, value, options), weighted by inverse frequency across THIS page's controls, plus small
 * priors for being on screen and for being a form field. The kept controls are returned in
 * DOM order, as the model expects. Pure.
 */
import type { Control } from "./types.js";

const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "then", "into", "onto", "your", "you",
  "are", "was", "has", "have", "page", "open", "click", "select", "choose", "set", "type",
  "enter", "fill", "find", "show", "only", "all", "any", "its", "our", "out", "via", "expect",
]);

/** Folded word stems (first 5 chars), dropping stop words and 1-2 letter tokens (digits kept). */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.normalize("NFKD").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w)) continue;
    if (w.length < 3 && !/^\d+$/.test(w)) continue;
    out.add(w.slice(0, 5));
  }
  return out;
}

/** Non-matching controls still offered beside the goal-named ones (e.g. the form's submit). */
const EXTRA = 5;

function words(c: Control): Set<string> {
  return stems([c.name, c.value ?? "", ...(c.options ?? [])].join(" "));
}

function onScreen(c: Control, viewportHeight: number): boolean {
  const rect = (c as Control & { rect?: { y: number; h: number } }).rect;
  if (!rect) return true;
  return rect.y + rect.h > 0 && rect.y < viewportHeight;
}

/**
 * Keep at most `limit` controls, the most relevant to `context` (goal + recent action labels).
 * When everything fits, the list is returned unchanged.
 */
export function shortlist(
  controls: readonly Control[],
  context: string,
  limit: number,
  { viewportHeight = 800 }: { viewportHeight?: number } = {},
): Control[] {
  if (controls.length <= limit) return [...controls];
  const want = stems(context);
  const bags = controls.map(words);
  const df = new Map<string, number>();
  for (const bag of bags) for (const w of bag) df.set(w, (df.get(w) ?? 0) + 1);
  const n = controls.length;
  const lexical = bags.map((bag) => {
    let s = 0;
    for (const w of bag) if (want.has(w)) s += Math.log(1 + n / (df.get(w) ?? 1));
    return s;
  });
  const scores = controls.map(
    (c, i) =>
      lexical[i]! +
      (onScreen(c, viewportHeight) ? 0.5 : 0) +
      (c.editable || c.tag === "select" ? 0.3 : 0),
  );
  // When the goal names something on the page, offer those matches plus only a few others:
  // every extra look-alike is another way for the model to pick wrong.
  const matches = lexical.filter((s) => s > 0).length;
  const budget = matches > 0 ? Math.min(limit, matches + EXTRA) : limit;
  const keep = new Set(
    controls
      .map((_, i) => i)
      .sort((a, b) => scores[b]! - scores[a]! || a - b)
      .slice(0, budget),
  );
  return controls.filter((_, i) => keep.has(i));
}
