/**
 * Safety guards for navigation and auto-submission.
 *
 * Two independent, PURE guards (no IO — they take already-captured data and return a
 * verdict) that both the Assist tools and the Autopilot loop apply at their edges:
 *
 *   1. {@link checkDomainAllowed} — a domain allow-list. When an allow-list is configured,
 *      navigation to a host that is not on the list (nor a subdomain of a listed host) is
 *      rejected. An empty allow-list means "no restriction" (allow all).
 *
 *   2. {@link checkDestructiveSubmit} — a destructive-form guard. Before Autopilot
 *      auto-submits (clicks a submit-like control), it inspects text SCOPED TO THE TARGET
 *      control — the target's own accessible name, current value, and option labels — plus
 *      the names of the other actionable controls (buttons/links) on the page, for
 *      destructive signals (delete / remove / pay / purchase / confirm order / transfer /
 *      deactivate), and it flags the password + payment-field combination. It deliberately
 *      does NOT scan the whole page's visible body text, which would false-positive on any
 *      page that merely mentions a destructive word in prose. When a signal is present it
 *      refuses the auto-submit and surfaces the reason so the client can confirm explicitly.
 *      The guard covers the Autopilot auto-submit (CLICK) path only; the human-driven Assist
 *      tools apply no destructive check by design.
 */
import type { Control, PageState } from "./types.js";

/** Verdict returned by a guard: allowed, or blocked with a human-readable reason. */
export interface GuardVerdict {
  /** Whether the action is permitted. */
  allowed: boolean;
  /** When not allowed, a short explanation of why. */
  reason?: string;
}

/** Lower-case, whitespace-collapsed form of a string for matching. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract the lower-cased hostname from a URL or bare host string.
 *
 * Accepts full URLs (`https://a.com/x`) and bare hosts (`a.com`). Returns undefined when the
 * value cannot be parsed as either (so callers can decide how to treat it).
 */
export function hostOf(urlOrHost: string): string | undefined {
  const raw = urlOrHost.trim();
  if (raw === "") return undefined;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    // Not a full URL; try treating it as `host[:port][/path]`.
    const hostPart = raw.replace(/^\/*/, "").split(/[/?#]/)[0];
    const host = (hostPart ?? "").split(":")[0]?.toLowerCase();
    // A plausible host contains a dot or is `localhost`.
    if (host && (host.includes(".") || host === "localhost")) return host;
    return undefined;
  }
}

/** Whether `host` equals `allowed` or is a subdomain of it. */
function hostMatches(host: string, allowed: string): boolean {
  const a = allowed.toLowerCase().replace(/^\*\./, "");
  return host === a || host.endsWith(`.${a}`);
}

/**
 * Check a candidate navigation URL against the configured domain allow-list.
 *
 * When `allowedDomains` is empty, every navigation is allowed. Otherwise the URL's host
 * must equal or be a subdomain of a listed domain; a URL whose host cannot be parsed is
 * rejected (fail-closed) when a list is configured.
 */
export function checkDomainAllowed(
  urlOrHost: string,
  allowedDomains: string[],
): GuardVerdict {
  if (allowedDomains.length === 0) return { allowed: true };
  const host = hostOf(urlOrHost);
  if (host === undefined) {
    return {
      allowed: false,
      reason: `Cannot determine the host of ${JSON.stringify(
        urlOrHost,
      )}; blocked because a domain allow-list is configured.`,
    };
  }
  const ok = allowedDomains.some((d) => hostMatches(host, d));
  if (ok) return { allowed: true };
  return {
    allowed: false,
    reason: `Navigation to host ${JSON.stringify(
      host,
    )} is blocked: not on the allow-list [${allowedDomains
      .map((d) => JSON.stringify(d))
      .join(", ")}].`,
  };
}

/** Words that indicate a destructive / high-stakes action. */
const DESTRUCTIVE_PATTERN =
  /\b(delete|remove|pay|purchase|confirm order|place order|transfer|deactivate|close account|wipe|erase)\b/i;

/** Whether a control looks like a payment-related field. */
function isPaymentField(c: Control): boolean {
  const hay = norm(`${c.name} ${c.type ?? ""}`);
  return /(card number|credit card|cardnumber|cvv|cvc|card code|expiry|expiration|iban|account number|routing)/.test(
    hay,
  );
}

/** Whether a control is a password input. */
function isPasswordField(c: Control): boolean {
  return c.type === "password";
}

/**
 * Inspect a submit action for destructive signals.
 *
 * `target` is the control about to be clicked (the submit trigger). The text check is SCOPED
 * TO THE TARGET (its accessible name, current value, and option labels) and to the other
 * actionable controls on the page — it does NOT scan the whole page's visible body text,
 * which would false-positive on any page that merely mentions a destructive word in prose.
 * Returns a verdict that refuses the auto-submit when:
 *   - the target control's own text (name / value / options) matches a destructive keyword, OR
 *   - any other actionable control (a button/link) matches a destructive keyword, OR
 *   - the page combines a password field with a payment-like field (a signal of a
 *     sensitive credential + payment form).
 *
 * The verdict still errs toward refusing (fail-safe); scoping only removes the whole-page
 * body-text false positive, it does not loosen the target/neighbour/password+payment signals.
 *
 * When `enabled` is false the guard is inert and always allows (the operator opted out).
 */
export function checkDestructiveSubmit(
  target: Control,
  state: PageState,
  enabled = true,
): GuardVerdict {
  if (!enabled) return { allowed: true };

  // Text scoped to the target control itself: its label/name, current value, and any option
  // labels it exposes. This is the text a human would read on/around the control it clicks.
  const targetText = norm(
    [target.name, target.value ?? "", ...(target.options ?? [])].join(" "),
  );
  if (DESTRUCTIVE_PATTERN.test(targetText)) {
    return {
      allowed: false,
      reason: `Refusing to auto-submit: the control ${JSON.stringify(
        target.name,
      )} looks destructive (matched a delete/pay/purchase/transfer/deactivate signal). Confirm explicitly before submitting.`,
    };
  }

  // Another actionable control on the page matches a destructive keyword.
  const destructiveNeighbour = state.controls.find(
    (c) =>
      c.ref !== target.ref &&
      (c.role === "button" || c.role === "link" || c.tag === "button") &&
      DESTRUCTIVE_PATTERN.test(norm(c.name)),
  );
  if (destructiveNeighbour) {
    return {
      allowed: false,
      reason: `Refusing to auto-submit: a nearby control ${JSON.stringify(
        destructiveNeighbour.name,
      )} indicates a destructive action on this page. Confirm explicitly before submitting.`,
    };
  }

  // Password + payment-field combination.
  const hasPassword = state.controls.some(isPasswordField);
  const hasPayment = state.controls.some(isPaymentField);
  if (hasPassword && hasPayment) {
    return {
      allowed: false,
      reason:
        "Refusing to auto-submit: the form combines a password field with a payment-like field, a sensitive combination. Confirm explicitly before submitting.",
    };
  }

  return { allowed: true };
}
