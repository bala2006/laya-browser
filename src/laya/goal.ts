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
 *
 * WIDENED LOCAL RESOLUTION: to resolve more values on-device with ZERO network (deleting the
 * most expensive per-step operation a remote-model agent has, its text LLM), the grammar also
 * recognizes these shapes WITHOUT requiring quotes, lifting the documented "quote values with
 * dots" limitation for exactly these cases:
 *   - an email-shaped value, e.g. `email is a@b.com` (dots and the @ no longer truncate it);
 *   - a date-shaped value, ISO `2024-01-15` or `MM/DD/YYYY` `01/15/2024`;
 *   - an unquoted multi-word value that stops at a clause boundary (a comma, a semicolon, a
 *     sentence period, or a joining word like `and`), e.g. `city is New York`,
 *     `name is Ada Lovelace`.
 * These are additive: an already-quoted value keeps its exact quoted content, and the
 * multi-field no-name-match safety in fieldValueFromGoal is unchanged, so a value is never
 * dumped into an arbitrary field.
 */
import type { Control, PageState } from "../types.js";

/** Lower-case, whitespace-collapsed form of a string for matching. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Matches an email-shaped token (a single local part, an @, and a dotted domain). Anchored
 * with ^...$ so it validates a whole extracted value; used to accept an UNQUOTED email whose
 * dots would otherwise truncate the generic value capture.
 */
const EMAIL_RE = /^[^\s@"']+@[^\s@"']+\.[^\s@"']+$/;

/**
 * Matches a date-shaped token: ISO `YYYY-MM-DD` or `MM/DD/YYYY` (also `M/D/YYYY`). Anchored so
 * it validates a whole extracted value; used to accept an UNQUOTED date whose separators would
 * otherwise truncate the generic value capture.
 */
const DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/;

/**
 * Reduce a captured no-separator key to the field label immediately before the quote: the
 * trailing run of label words after the last clause/joining boundary (a joining word like
 * `and`/`then`, or the assignment word `is`). So `first name is ada and last name` becomes
 * `last name`, and a plain `email` stays `email`. Keeps a two-word label like `last name`
 * whole while discarding an unrelated leading clause.
 */
function lastLabelWord(key: string): string {
  const parts = key.split(" ").filter(Boolean);
  let start = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "and" || parts[i] === "then" || parts[i] === "is") start = i + 1;
  }
  return parts.slice(start).join(" ");
}

/**
 * Trim an unquoted assignment value at the first clause boundary so a multi-word value like
 * `New York` is kept whole while a trailing clause (`, and ...` / `. ...` / `; ...` /
 * ` and ...`) is dropped. Also strips a lone trailing sentence period so `name is Ada Lovelace.`
 * yields `Ada Lovelace`. Returns the trimmed value (never widens past the original span).
 */
function trimUnquotedValue(raw: string): string {
  let v = raw;
  // Cut at a comma / semicolon / a joining word (` and ` / ` then `) that starts a new clause.
  const clause = v.search(/\s*(?:,|;|\band\b|\bthen\b)\s/i);
  if (clause >= 0) v = v.slice(0, clause);
  // Drop a single trailing sentence period (but keep dotted tokens like emails/decimals: those
  // are handled by the email/date shapes before this trim runs).
  v = v.replace(/\.\s*$/, "");
  return v.trim();
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

  // `type/enter/put/fill "laptops" into the search box` (or `... search field/input`). The
  // value is quoted and the target clause names a search control, so this is a search intent:
  // map the quoted value to the `search` key. The value clause is captured before the general
  // `key "value"` scan below so the phrase `search box` never gets parsed as a field label.
  if (!out.has("search")) {
    const typeIntoSearch = goal.match(
      /(?:type|enter|put|fill)\s+["']([^"']+)["'](?:\s+\w+)*?\s+(?:into|in)\b[^"']*?\bsearch\b/i,
    );
    if (typeIntoSearch && typeIntoSearch[1]) {
      out.set("search", typeIntoSearch[1].trim());
    }
  }

  // `key "value"` / `key: value` / `key = value` / `key is value`.
  //
  // A quoted value keeps its exact content. An UNQUOTED value captures the rest of the clause
  // (up to end-of-string) and is then normalized by shape: an email or date token is taken
  // whole (dots/@/slashes no longer truncate it), otherwise the value is trimmed at the first
  // clause boundary so a multi-word value like `New York` survives while a trailing clause is
  // dropped. A quoted match takes precedence over an unquoted one for the same key.
  //
  // The unquoted value stops at a CLAUSE BOUNDARY (a comma, a semicolon, a newline, or a
  // joining word ` and `/` then `) so a second assignment on the same line is still matched;
  // it may contain internal spaces (multi-word) and dots/@/slashes (email/date). A lone
  // trailing sentence period is stripped afterwards by shape.
  const pattern =
    /([A-Za-z][A-Za-z0-9 _-]*?)\s*(?::|=|\bis\b)\s*["']([^"']+)["']|([A-Za-z][A-Za-z0-9 _-]*?)\s*(?::|=|\bis\b)\s*((?:(?!\s+(?:and|then)\b)[^,;"'\n])+)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(goal)) !== null) {
    if (m[2] !== undefined) {
      // Quoted value: exact content.
      const key = norm((m[1] ?? "").replace(/^\s*(?:and|then)\b\s*/i, ""));
      const value = m[2].trim();
      if (key && value) out.set(key, value);
      continue;
    }
    // Unquoted value: normalize by shape. Strip a leading joining word (`and`/`then`) that the
    // previous clause's boundary left attached to this key (e.g. `... and email is ...`).
    const key = norm((m[3] ?? "").replace(/^\s*(?:and|then)\b\s*/i, ""));
    const rest = (m[4] ?? "").trim();
    if (!key || !rest) continue;
    if (out.has(key)) continue;
    // First whitespace-delimited token, used to test the email/date shapes.
    const firstToken = rest.split(/\s/)[0] ?? "";
    let value: string;
    if (EMAIL_RE.test(firstToken) || DATE_RE.test(firstToken)) {
      // An email/date is a single self-contained token: take it whole and ignore any trailing
      // words the clause capture happened to include.
      value = firstToken;
    } else {
      // A multi-word value: strip only a lone trailing sentence period.
      value = trimUnquotedValue(rest);
    }
    if (value) out.set(key, value);
  }

  // `key "value"` (no separator), e.g. `email "user@example.com"`. The key is capped to its
  // trailing word (the field label immediately before the quote) so it never runs back across
  // a whole clause (`first name is Ada and last name ... "value"`) and swallows unrelated words
  // that would then spuriously match other fields.
  const quoted = /([A-Za-z][A-Za-z0-9 _-]*?)\s+["']([^"']+)["']/g;
  while ((m = quoted.exec(goal)) !== null) {
    const key = lastLabelWord(norm(m[1] ?? ""));
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
  return keyMatchScore(key, tokens) > 0;
}

/**
 * Score how well an assignment key matches a control's tokens: the count of key tokens that
 * are present in (or contained by / containing) the control's tokens. `0` means no match.
 *
 * A SCORE (rather than a boolean) lets a multi-field goal disambiguate fields that share a
 * generic token: `last name` scores 2 against a "Last name" field (both "last" and "name"
 * match) but only 1 against a "First name" field (only "name" matches), so each value lands in
 * the field that matches it best instead of the first field that happens to share "name".
 */
function keyMatchScore(key: string, tokens: Set<string>): number {
  const keyTokens = key.split(" ").filter(Boolean);
  let score = 0;
  for (const kt of keyTokens) {
    if (tokens.has(kt) || [...tokens].some((t) => t.includes(kt) || kt.includes(t))) {
      score += 1;
    }
  }
  return score;
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

  // Pick the assignment whose key matches this control BEST (highest token-overlap score),
  // breaking ties by insertion order. This keeps a single unambiguous match behaving exactly
  // as before (first positive score wins when nothing scores higher) while letting a
  // multi-field goal route each value to the field it fits best (e.g. last name -> "Last name"
  // rather than the first field that merely shares the generic "name" token).
  let bestValue: string | undefined;
  let bestScore = 0;
  for (const [key, value] of assignments) {
    const score = keyMatchScore(key, tokens);
    if (score > bestScore) {
      bestScore = score;
      bestValue = value;
    }
  }
  if (bestValue !== undefined) return bestValue;

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
export function goalSuccessMarkers(
  goal: string,
  { explicitOnly = false }: { explicitOnly?: boolean } = {},
): string[] {
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
  if (markers.length === 0 && !explicitOnly) {
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
export function goalSuccessMarkerPresent(
  state: PageState,
  options: { explicitOnly?: boolean } = {},
): boolean {
  const markers = goalSuccessMarkers(state.goal, options);
  if (markers.length === 0) return false;
  const haystack = norm(`${state.title} ${state.pageText ?? state.visibleText}`);
  return markers.every((mk) => haystack.includes(norm(mk)));
}

/**
 * Goal-mapped native `<select>` controls whose current value is not yet the goal's option,
 * paired with the matching option label. Only an option that exists (case-insensitively) is
 * returned, so a value is never forced into a select that cannot hold it.
 */
export function unsetGoalSelects(
  goal: string,
  controls: readonly Control[],
): { control: Control; value: string }[] {
  const out: { control: Control; value: string }[] = [];
  for (const c of controls) {
    if (c.tag !== "select" || c.disabled) continue;
    const value = fieldValueFromGoal(c, goal, controls);
    if (value === undefined) continue;
    const option = (c.options ?? []).find((o) => norm(o) === norm(value));
    if (option === undefined) continue;
    if (norm(c.value ?? "") === norm(option)) continue;
    out.push({ control: c, value: option });
  }
  return out;
}

/**
 * Unchecked checkboxes/radios the goal names verbatim (e.g. `check Free breakfast`), so a
 * requested filter is set before the form is submitted. Conservative: the control's whole name
 * must appear in the goal, and any negation (`uncheck`, `untick`, `without`, `no <name>`)
 * disqualifies it, so a toggle is never flipped against the goal.
 */
export function goalToggles(goal: string, controls: readonly Control[]): Control[] {
  const words = (t: string): string => norm(t).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const g = ` ${words(goal)} `;
  if (/ (?:uncheck|untick|deselect|without|disable) /.test(g)) return [];
  // A name the goal uses as a field VALUE (`destination is "Paris"` vs a "Paris" filter
  // checkbox) is not a request to tick that box. Radios are exempt: for a radio group the value
  // IS the choice (`class is "Economy"`).
  const values = new Set([...goalAssignments(goal).values()].map(words));
  return controls.filter((c) => {
    if (c.disabled || c.checked !== false) return false;
    const radio = c.type === "radio" || c.role === "radio";
    if (!radio && c.type !== "checkbox" && c.role !== "checkbox") return false;
    const name = words(c.name);
    if (name.length < 3 || !g.includes(` ${name} `)) return false;
    if (!radio && values.has(name)) return false;
    return !g.includes(` no ${name} `);
  });
}
