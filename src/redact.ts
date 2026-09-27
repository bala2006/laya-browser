/**
 * Pure, dependency-free secret redaction for LOGGED / DISPLAYED text.
 *
 * Boundary Discipline: this module masks only the *representation* of a secret that would
 * otherwise be written to a log, an Autopilot step-detail string, or the activity overlay.
 * It NEVER touches the value that is actually typed into the page: the browser still
 * receives the real password/token; only the human- or machine-readable echo of it is
 * masked. All exports are pure functions that never throw (they defensively coerce
 * non-string input and fall back to returning the input unchanged on any internal error).
 *
 * Used by feature B1 (redact secrets in step details) and reused by B2/B3.
 */

/** The fixed mask token: four bullet characters (U+2022). */
export const REDACTION_MASK = "\u2022\u2022\u2022\u2022";

/**
 * Common secret patterns found in free text. Each is matched globally and replaced with
 * {@link REDACTION_MASK}. Ordered from most-specific to least-specific so that, for
 * example, a JWT is masked as a whole before its base64 segments are considered.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // JSON Web Tokens: three base64url segments separated by dots.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // "Bearer <token>" authorization values (mask the token, keep the scheme readable).
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/g,
  // OpenAI-style keys: sk-... (and sk-proj-...).
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // AWS access key ids: AKIA / ASIA followed by 16 uppercase alphanumerics.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // GitHub-style tokens: ghp_/gho_/ghu_/ghs_/ghr_ + alphanumerics.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Google API keys: AIza + 35 chars.
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  // Long hex blobs (>= 32 hex chars), e.g. hashed tokens / signatures.
  /\b[0-9a-fA-F]{32,}\b/g,
  // Long base64-ish blobs (>= 40 chars), e.g. opaque API keys / secrets.
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/** Field names/types whose value should always be masked when displayed/logged. */
const SECRET_FIELD_HINTS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "cvv",
  "ssn",
  "pin",
];

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decide whether a form field is "secret" based on its name or input type.
 *
 * A field is treated as secret when `fieldNameOrType` is exactly `"password"` (an input
 * type) or contains any of: password, secret, token, apikey/api_key, cvv, ssn, pin. This is
 * the single shared field-secret test reused by {@link redactValueForField} (which masks the
 * value) and by the Autopilot loop (which captures the ACTUAL typed value into a run-scoped
 * secret set so it can be masked wherever it later appears in logs/details).
 *
 * Pure and never throws: non-string input is coerced and yields `false`.
 */
export function isSecretField(fieldNameOrType: string): boolean {
  try {
    const hint = (typeof fieldNameOrType === "string" ? fieldNameOrType : "").toLowerCase();
    if (!hint) return false;
    return SECRET_FIELD_HINTS.some((h) => hint.includes(h));
  } catch {
    return false;
  }
}

/**
 * Mask secrets in `text` for logging/display.
 *
 * Masks, in order:
 *   1. any literal string in `extraSecrets` (the actual typed secret values, so a captured
 *      password value is masked wherever it later appears in a log line), and
 *   2. common secret patterns in free text (JWTs, `Bearer` tokens, `sk-...` API keys,
 *      AWS `AKIA...` ids, long hex/base64 blobs).
 *
 * Returns the masked string. Pure and never throws: non-string input is coerced, and any
 * internal failure falls back to returning the (coerced) input unchanged.
 *
 * This masks only the DISPLAYED/LOGGED representation, never the value typed into the page.
 */
export function redactText(text: string, extraSecrets: string[] = []): string {
  let out: string;
  try {
    out = typeof text === "string" ? text : String(text ?? "");
  } catch {
    return "";
  }
  try {
    // 1. Literal secret values first (longest first, so overlapping values mask cleanly).
    const literals = (Array.isArray(extraSecrets) ? extraSecrets : [])
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .sort((a, b) => b.length - a.length);
    for (const secret of literals) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTION_MASK);
    }
    // 2. Structural secret patterns.
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, REDACTION_MASK);
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * Decide whether a form field's value should be masked based on its name or input type, and
 * return the masked token when so (else the value unchanged).
 *
 * A field is treated as secret when `fieldNameOrType` is exactly `"password"` (an input
 * type) or contains any of: password, secret, token, apikey/api_key, cvv, ssn, pin.
 *
 * Pure and never throws: non-string input falls back to returning `value` (coerced).
 */
export function redactValueForField(fieldNameOrType: string, value: string): string {
  try {
    const safeValue = typeof value === "string" ? value : String(value ?? "");
    return isSecretField(fieldNameOrType) ? REDACTION_MASK : safeValue;
  } catch {
    try {
      return typeof value === "string" ? value : String(value ?? "");
    } catch {
      return "";
    }
  }
}
