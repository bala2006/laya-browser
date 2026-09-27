/**
 * (T2.2) Bounded, conservative auto-dismissal of cookie/consent banners and blocking modal
 * overlays.
 *
 * Production browser flows are routinely blocked by a cookie/consent banner or a "subscribe"
 * modal that steals focus and hides the real controls. A robust agent must clear these before
 * it can act. The heuristic here is deliberately CONSERVATIVE:
 *   - it only considers containers that look like consent/cookie banners (by text/aria) OR
 *     blocking modals (role=dialog / aria-modal / a high-z fixed overlay), and
 *   - within such a container it clicks ONLY an affirmative dismissal affordance
 *     (accept / agree / got it / OK / close / dismiss / reject-all-cookies), and
 *   - it NEVER clicks anything whose label looks destructive (delete/remove/pay/buy/…),
 *
 * so it cannot progress a real form or take a dangerous action by accident. Detection +
 * clicking run INSIDE the page via a single `page.evaluate`, so the whole scan is one round
 * trip. The function returns a short list of what it dismissed (already plain text) for the
 * loop to surface on the overlay and note in the transcript. It NEVER throws into the caller.
 *
 * This module is the decision/scan half; the loop (src/autopilot/loop.ts) calls it and does
 * the narration. The scan closes over nothing from Node (it is serialised into the page).
 */
import type { Page } from "playwright";

/** One dismissed overlay: the kind detected and the label of the affordance that cleared it. */
export interface DismissedOverlay {
  /** Whether it was detected as a cookie/consent banner or a blocking modal. */
  kind: "consent" | "modal";
  /** The accessible label of the button/element that was clicked to dismiss it. */
  clicked: string;
}

/**
 * Scan the active page for cookie/consent banners and blocking modals and dismiss them
 * conservatively. Returns the list of overlays dismissed (empty when none matched). Bounded:
 * it dismisses at most a handful per call and never clicks destructive-looking controls.
 * Best-effort and never throws.
 */
export async function autoDismissOverlays(page: Page): Promise<DismissedOverlay[]> {
  try {
    const dismissed = (await page.evaluate(() => {
      // --- In-page heuristic. Everything below runs inside the document. ---
      const AFFIRM =
        /\b(accept all|accept|agree|allow all|allow|got it|ok(?:ay)?|understood|continue|reject all|dismiss|close|no thanks|not now|decline)\b/i;
      const DESTRUCTIVE =
        /\b(delete|remove|pay|buy|purchase|checkout|order|transfer|withdraw|confirm delete|unsubscribe|deactivate|cancel account)\b/i;
      const CONSENT_HINT =
        /\b(cookie|consent|gdpr|privacy|tracking|we use cookies|your privacy)\b/i;

      function accName(el: Element): string {
        const he = el as HTMLElement;
        const aria = he.getAttribute("aria-label");
        if (aria && aria.trim()) return aria.trim();
        const txt = (he.textContent || "").replace(/\s+/g, " ").trim();
        if (txt) return txt.length > 60 ? txt.slice(0, 60) : txt;
        const val = he.getAttribute("value");
        return val ? val.trim() : "";
      }

      function isVisible(el: Element): boolean {
        const he = el as HTMLElement;
        const s = getComputedStyle(he);
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") {
          return false;
        }
        const r = he.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      // Candidate containers: explicit dialogs, aria-modal, common cookie/consent ids/classes,
      // and high-z fixed overlays.
      const containers = new Set<Element>();
      const bySelector = document.querySelectorAll(
        [
          '[role="dialog"]',
          '[role="alertdialog"]',
          "[aria-modal='true']",
          "dialog[open]",
          '[id*="cookie" i]',
          '[class*="cookie" i]',
          '[id*="consent" i]',
          '[class*="consent" i]',
          '[id*="gdpr" i]',
          '[class*="gdpr" i]',
          '[class*="modal" i]',
          '[class*="banner" i]',
        ].join(","),
      );
      for (const el of Array.from(bySelector)) containers.add(el);

      // High z-index fixed/absolute overlays covering a large area (blocking modals).
      for (const el of Array.from(document.body?.querySelectorAll("*") ?? [])) {
        const s = getComputedStyle(el as HTMLElement);
        if (s.position !== "fixed" && s.position !== "absolute") continue;
        const z = parseInt(s.zIndex, 10);
        if (!Number.isFinite(z) || z < 1000) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width * r.height > (window.innerWidth * window.innerHeight) / 4) {
          containers.add(el);
        }
      }

      const results: { kind: "consent" | "modal"; clicked: string }[] = [];
      const clickedEls = new Set<Element>();

      for (const container of Array.from(containers)) {
        if (results.length >= 4) break; // bound the work per call
        if (!isVisible(container)) continue;
        const containerText = (container.textContent || "").slice(0, 400);
        const kind: "consent" | "modal" = CONSENT_HINT.test(containerText)
          ? "consent"
          : "modal";

        // Find a conservative dismissal affordance INSIDE this container.
        const clickable = container.querySelectorAll(
          'button, [role="button"], a, input[type="button"], input[type="submit"]',
        );
        let chosen: Element | null = null;
        for (const c of Array.from(clickable)) {
          if (clickedEls.has(c) || !isVisible(c)) continue;
          const label = accName(c);
          if (!label) continue;
          if (DESTRUCTIVE.test(label)) continue; // never click a destructive control
          if (AFFIRM.test(label)) {
            chosen = c;
            break;
          }
        }
        if (!chosen) continue;
        try {
          (chosen as HTMLElement).click();
          clickedEls.add(chosen);
          results.push({ kind, clicked: accName(chosen) });
        } catch {
          // Click may fail if the node detaches; skip it.
        }
      }
      return results;
    })) as DismissedOverlay[];
    return Array.isArray(dismissed) ? dismissed : [];
  } catch {
    // Any evaluate failure (navigation mid-scan, etc.) yields no dismissals; never throw.
    return [];
  }
}
