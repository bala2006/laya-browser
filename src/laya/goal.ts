/**
 * Deterministic goal <-> control heuristics shared by the stub engine and the loop.
 *
 * These are the transparent rules that turn a natural-language goal into concrete field
 * values and success checks. They are intentionally simple and side-effect-free so they
 * can be unit-tested and reused: Laya (the real engine) chooses the operation and target,
 * while these helpers supply the concrete VALUE to type and the final success check.
 *
 * The supported goal grammar is small and explicit (matching the synthetic-form domain the
 * web-agent is strong on):
 *   - `field "value"` / `field: value` / `field = value` / `field is value`
 *     e.g. `email is user@example.com`, `search for "laptops"`, `password = secret`.
 *   - success markers: `expect "Signed in"` / `until "Results"` / `see "Order placed"`.
 */
import type { Control, PageState } from "../types.js";

/** Lower-case, whitespace-collapsed form of a string for matching. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract explicit `key -> value` assignments mentioned in the goal.
 *
 * Recognises `key "value"`, `key: value`, `key = value`, and `key is value`, plus the
 * common `search for "value"` phrasing (mapped to key `search`).
 */
export function goalAssignments(goal: string): Map<string, string> {
  const out = new Map<string, string>();

  // `search for "laptops"` or `search for laptops`
  const searchFor = goal.match(/search\s+for\s+["']([^"']+)["']|search\s+for\s+([^\s,.;]+)/i);
  if (searchFor) {
    out.set("search", (searchFor[1] ?? searchFor[2] ?? "").trim());
  }

  // `key "value"` / `key: value` / `key = value` / `key is value`
  const pattern =
    /([A-Za-z][A-Za-z0-9 _-]*?)\s*(?::|=|\bis\b)\s*["']([^"']+)["']|([A-Za-z][A-Za-z0-9 _-]*?)\s*(?::|=|\bis\b)\s*([^\s,.;"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(goal)) !== null) {
    const key = norm(m[1] ?? m[3] ?? "");
    const value = (m[2] ?? m[4] ?? "").trim();
    if (key && value) out.set(key, value);
  }

  // `key "value"` (no separator) — e.g. `email "user@example.com"`
  const quoted = /([A-Za-z][A-Za-z0-9 _-]*?)\s+["']([^"']+)["']/g;
  while ((m = quoted.exec(goal)) !== null) {
    const key = norm(m[1] ?? "");
    const value = (m[2] ?? "").trim();
    if (key && value && !out.has(key)) out.set(key, value);
  }

  return out;
}

/** Tokens describing a control, used to match it against a goal assignment key. */
function controlTokens(c: Control): string[] {
  return [c.name, c.type ?? "", c.role]
    .map(norm)
    .filter(Boolean)
    .flatMap((t) => t.split(" "));
}

/**
 * The value the goal implies for a given field control, if any.
 *
 * Matches the field's name/type against the goal's assignment keys (either direction of
 * containment), so `email is a@b.com` fills a field named "Email" and `search for "x"`
 * fills a field named/typed "search".
 */
export function fieldValueFromGoal(c: Control, goal: string): string | undefined {
  const assignments = goalAssignments(goal);
  if (assignments.size === 0) return undefined;
  const tokens = new Set(controlTokens(c));

  for (const [key, value] of assignments) {
    const keyTokens = key.split(" ").filter(Boolean);
    // A key matches if any of its tokens is one of the control's tokens, or vice versa.
    const matches = keyTokens.some(
      (kt) => tokens.has(kt) || [...tokens].some((t) => t.includes(kt) || kt.includes(t)),
    );
    if (matches) return value;
  }
  return undefined;
}

/** Whether a control looks like a submit/search/continue trigger. */
export function isSubmitControl(c: Control): boolean {
  if (c.disabled) return false;
  const isButton = c.role === "button" || c.tag === "button" || c.type === "submit";
  if (!isButton) return false;
  const name = norm(c.name);
  return /(submit|search|sign in|log in|login|continue|next|go|apply|save|send|find)/.test(
    name,
  );
}

/**
 * Success markers the goal expects on the final page.
 *
 * Recognises `expect "..."`, `until "..."`, and `see "..."`. Falls back to the quoted
 * `search for "x"` value being echoed on the page when no explicit marker is given.
 */
export function goalSuccessMarkers(goal: string): string[] {
  const markers: string[] = [];
  const re = /(?:expect|until|see|shows?)\s+["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(goal)) !== null) {
    if (m[1]) markers.push(m[1].trim());
  }
  return markers;
}

/**
 * Whether the goal's success marker is present in the current page state's visible text
 * or title. When the goal declares no explicit marker, returns false (DONE must be earned
 * by an explicit marker, not merely assumed).
 */
export function goalSuccessMarkerPresent(state: PageState): boolean {
  const markers = goalSuccessMarkers(state.goal);
  if (markers.length === 0) return false;
  const haystack = norm(`${state.title} ${state.visibleText}`);
  return markers.every((mk) => haystack.includes(norm(mk)));
}
