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

/** Whether a control is an editable text-like field (input/textarea/textbox/searchbox). */
function isEditableTextLike(c: Control): boolean {
  if (!c.editable) return false;
  return (
    c.role === "textbox" ||
    c.role === "searchbox" ||
    c.tag === "input" ||
    c.tag === "textarea"
  );
}

/** Whether a control is explicitly typed/roled as a search field. */
function isSearchField(c: Control): boolean {
  return c.role === "searchbox" || norm(c.type ?? "") === "search";
}

/** Whether an assignment key matches a control by name/type/role tokens (either direction). */
function keyMatchesControl(key: string, tokens: Set<string>): boolean {
  const keyTokens = key.split(" ").filter(Boolean);
  return keyTokens.some(
    (kt) => tokens.has(kt) || [...tokens].some((t) => t.includes(kt) || kt.includes(t)),
  );
}

/**
 * The value the goal implies for a given field control, if any.
 *
 * Matches the field's name/type against the goal's assignment keys (either direction of
 * containment), so `email is a@b.com` fills a field named "Email" and `search for "x"`
 * fills a field named/typed "search".
 *
 * SEARCH-INTENT FALLBACK: when the goal expresses a search intent (the `search for "..."`
 * phrasing, i.e. the assignment key `search`) and no field matches by name/token, this
 * falls back to the single most plausible search field — a control explicitly typed/roled
 * as "search", or (only when exactly ONE editable text-like field exists on the page) that
 * sole field. This is deliberately conservative: on a multi-field form (e.g. email +
 * password) with no name match, the fallback does NOT fire, so a value is never dumped into
 * an arbitrary field. Pass the page's full control list via `allControls` to enable it.
 */
export function fieldValueFromGoal(
  c: Control,
  goal: string,
  allControls?: readonly Control[],
): string | undefined {
  const assignments = goalAssignments(goal);
  if (assignments.size === 0) return undefined;
  const tokens = new Set(controlTokens(c));

  for (const [key, value] of assignments) {
    if (keyMatchesControl(key, tokens)) return value;
  }

  // Search-intent fallback: only for the `search` assignment key, only when nothing on the
  // page matched it by name/token, and only for a plausible sole/typed search field.
  const searchValue = assignments.get("search");
  if (searchValue !== undefined && allControls !== undefined) {
    const anyNameMatch = allControls.some((other) =>
      keyMatchesControl("search", new Set(controlTokens(other))),
    );
    if (!anyNameMatch) {
      if (isSearchField(c)) return searchValue;
      const textFields = allControls.filter(isEditableTextLike);
      if (textFields.length === 1 && textFields[0]?.ref === c.ref) {
        return searchValue;
      }
    }
  }

  return undefined;
}

/** Whether a control is an editable text-like field (input/textarea/textbox/searchbox). */
export function isTextFieldControl(c: Control): boolean {
  return isEditableTextLike(c);
}

/**
 * The goal-mapped editable text fields that are still UNFILLED, paired with the value the
 * goal implies for each.
 *
 * This is the input to the "faster" batch-fill decision: when TWO OR MORE such fields exist,
 * the deterministic layer prefers a single FILL_FORM step over N sequential TYPE_TEXT steps.
 * A field is unfilled when its current value differs from the goal-implied value.
 */
export function unfilledGoalFields(
  goal: string,
  controls: readonly Control[],
): { control: Control; value: string }[] {
  const out: { control: Control; value: string }[] = [];
  for (const c of controls) {
    if (!isEditableTextLike(c)) continue;
    const value = fieldValueFromGoal(c, goal, controls);
    if (value === undefined) continue;
    if ((c.value ?? "").trim() === value.trim()) continue; // already filled
    out.push({ control: c, value });
  }
  return out;
}

/** Whether a control looks like a submit/search/continue trigger. */
export function isSubmitControl(c: Control): boolean {
  if (c.disabled) return false;
  // An explicit submit control (`<button type="submit">` / `<input type="submit">`) is a
  // submit control regardless of its accessible name — e.g. DuckDuckGo's button is named
  // "b" but is `type="submit"`.
  if (c.type === "submit") return true;
  const isButton = c.role === "button" || c.tag === "button";
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
  // Fallback: when no explicit marker is declared but the goal is a search
  // (`search for "x"`), treat the searched-for value being echoed on the page as the
  // success marker. This lets bare `search for "laptop"` goals be verified without an
  // explicit `expect "..."`, matching how a search result page echoes the query.
  if (markers.length === 0) {
    const search = goalAssignments(goal).get("search");
    if (search) markers.push(search);
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
