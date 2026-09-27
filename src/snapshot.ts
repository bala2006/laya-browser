/**
 * The ref/snapshot boundary — owned in-house, not by any Playwright private API.
 *
 * {@link capture} injects a self-contained DOM walk (via `page.evaluate`) that finds
 * interactive + landmark elements, stamps each with a stable `data-laya-ref="eN"`
 * attribute, and returns:
 *   (a) a compact, human-readable snapshot string (lines like `- button "Search" [ref=e5]`),
 *   (b) a `Control[]` array with role/name/tag/type/value/options/editable/checked/disabled, and
 *   (c) page-level `url`, `title`, and a truncated `visibleText`.
 *
 * The same capture backs both Assist-mode `browser_snapshot` output and (later) Autopilot
 * state building, so it is deliberately robust to detached nodes and re-runnable: each call
 * re-numbers refs monotonically (`e1`, `e2`, ...) so a ref is only meaningful within the
 * snapshot that produced it, and re-running on the same page yields the same assignment.
 *
 * The walk runs entirely in the page (it is serialised into the browser and executed there),
 * so it must not close over anything from the Node side.
 */
import type { Control, Ref } from "./types.js";
import { asRef } from "./types.js";
import type { SnapshotBackend } from "./config.js";
import type { Page } from "playwright";

/** Raw per-control record returned from the in-page walk (before branding refs). */
interface RawControl {
  ref: string;
  index: number;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  options?: string[];
  editable: boolean;
  checked?: boolean;
  disabled?: boolean;
  /**
   * (C3) Viewport-proximity distance in CSS pixels: `0` when the element intersects the
   * viewport, otherwise the shortest gap to the visible rectangle. Present only when the
   * in-page walk computed it (viewport-priority ordering); used to sort the returned list.
   */
  viewportDistance?: number;
}

/** Raw result returned from the in-page walk. */
interface RawSnapshot {
  url: string;
  title: string;
  visibleText: string;
  controls: RawControl[];
}

/** A full page snapshot: compact text, typed controls, and page metadata. */
export interface Snapshot {
  /** Current page URL. */
  url: string;
  /** Current document title. */
  title: string;
  /** Condensed visible text of the page (truncated). */
  visibleText: string;
  /** Extracted interactive/landmark controls, each carrying a stable ref. */
  controls: Control[];
  /** Compact human-readable snapshot with `[ref=eN]` markers. */
  text: string;
}

/** Default cap on the amount of visible text returned, in characters. */
const DEFAULT_VISIBLE_TEXT_LIMIT = 2000;

/** Options for {@link capture}. */
export interface CaptureOptions {
  /** Maximum characters of visible text to return. Defaults to 2000. */
  visibleTextLimit?: number;
  /**
   * (C1) Which backend enumerates the page controls: `domwalk` (default, the in-page DOM
   * walk) or `aria` (Playwright's accessibility tree). Both produce the SAME Snapshot /
   * Control[] contract and both stamp `data-laya-ref="eN"` so `resolveRef('eN')` works
   * afterward. Defaults to `domwalk`, so existing callers are entirely unaffected.
   */
  backend?: SnapshotBackend;
  /**
   * (C3) When true, the in-page DOM walk sorts the RETURNED control list so controls that
   * intersect or are near the viewport come first (keeping `eN` assignment in DOM order so
   * `resolveRef` stays correct). This makes the downstream ~20-control cap keep the nearest
   * controls. Defaults to false, preserving pure DOM order for existing callers.
   */
  viewportPriority?: boolean;
}

/**
 * Capture a snapshot of the current page state.
 *
 * Stamps `data-laya-ref` attributes on the page as a side effect (so subsequent
 * `resolveRef` calls can find the elements), then formats the compact text snapshot.
 *
 * The `backend` option selects how controls are enumerated: the default `domwalk` runs the
 * in-page DOM walk; `aria` maps Playwright's accessibility tree into the same contract. Both
 * stamp `data-laya-ref="eN"` on the matched elements so ref resolution is identical.
 */
export async function capture(
  page: Page,
  options: CaptureOptions = {},
): Promise<Snapshot> {
  if (options.backend === "aria") {
    return captureAria(page, options);
  }
  const limit = options.visibleTextLimit ?? DEFAULT_VISIBLE_TEXT_LIMIT;
  const raw = (await page.evaluate(domWalk, {
    visibleTextLimit: limit,
    viewportPriority: options.viewportPriority ?? false,
  })) as RawSnapshot;

  const controls: Control[] = raw.controls.map((c) => ({
    ref: asRef(c.ref) as Ref,
    index: c.index,
    role: c.role,
    name: c.name,
    tag: c.tag,
    ...(c.type !== undefined ? { type: c.type } : {}),
    ...(c.value !== undefined ? { value: c.value } : {}),
    ...(c.options !== undefined ? { options: c.options } : {}),
    editable: c.editable,
    ...(c.checked !== undefined ? { checked: c.checked } : {}),
    ...(c.disabled !== undefined ? { disabled: c.disabled } : {}),
  }));

  return {
    url: raw.url,
    title: raw.title,
    visibleText: raw.visibleText,
    controls,
    text: formatSnapshot(raw, controls),
  };
}

/**
 * One node of Playwright's AI-optimized ARIA snapshot JSON (a subset of the documented
 * shape, only the fields this mapping consumes). Non-element static text fragments are
 * plain strings, so the `children` array is a union of nodes and strings.
 */
interface AriaNode {
  role?: string;
  name?: string;
  text?: string;
  ref?: string;
  checked?: boolean | string;
  disabled?: boolean;
  selected?: boolean;
  level?: number;
  children?: Array<AriaNode | string>;
  [key: string]: unknown;
}

/** The faithful element details read off a live element for an aria-mapped control. */
interface AriaElementDetail {
  tag: string;
  type?: string;
  value?: string;
  options?: string[];
  editable: boolean;
  checked?: boolean;
  disabled?: boolean;
}

/**
 * ARIA roles this backend surfaces as controls, mirroring the DOM-walk selection: interactive
 * roles plus headings. `generic`/`text`/structural wrappers are walked through but not
 * emitted, so the aria backend produces a comparable Control[] to the DOM walk.
 */
const ARIA_CONTROL_ROLES = new Set<string>([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "heading",
]);

/**
 * (C1) Alternate capture backend built on Playwright's accessibility tree.
 *
 * Obtains the AI-optimized ARIA snapshot (which carries element refs), flattens it to the
 * interactive/landmark nodes, then resolves each node back to its real element via
 * Playwright's `aria-ref=` selector to stamp `data-laya-ref="eN"` (re-numbered monotonically
 * so resolveRef('eN') resolves the same elements as the DOM walk would) and read the faithful
 * tag / type / value / options / editable / checked / disabled off the live element. The
 * result is the SAME {@link Snapshot} contract as {@link capture} with the default backend.
 */
export async function captureAria(
  page: Page,
  options: CaptureOptions = {},
): Promise<Snapshot> {
  const limit = options.visibleTextLimit ?? DEFAULT_VISIBLE_TEXT_LIMIT;

  // The AI-optimized snapshot includes `[ref=eN]` references we can resolve via `aria-ref=`.
  let tree: Array<AriaNode | string> = [];
  try {
    const json = (await page
      .locator("body")
      .ariaSnapshotJSON({ mode: "ai" })) as unknown;
    tree = Array.isArray(json) ? (json as Array<AriaNode | string>) : [json as AriaNode];
  } catch {
    // If the accessibility snapshot is unavailable for any reason, fall back to the DOM walk
    // so the aria backend never breaks a capture; the contract shape is identical.
    return capture(page, { ...options, backend: "domwalk" });
  }

  // Flatten the tree in document order, keeping only the interactive/landmark control nodes
  // that carry a Playwright ref (so they can be resolved back to a live element).
  const flat: AriaNode[] = [];
  const walk = (nodes: Array<AriaNode | string>): void => {
    for (const node of nodes) {
      if (typeof node === "string") continue;
      if (node.role && node.ref && ARIA_CONTROL_ROLES.has(node.role)) {
        flat.push(node);
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(tree);

  const controls: Control[] = [];
  let counter = 0;
  for (const node of flat) {
    counter += 1;
    const layaRef = "e" + counter;
    const pwRef = node.ref!;
    const locator = page.locator(`aria-ref=${pwRef}`);
    // Stamp our own ref and read the faithful element details in one evaluate, so
    // resolveRef('eN') resolves the element the aria node describes. Best-effort: a stale /
    // detached aria ref simply yields a null detail and a name/role-only control.
    let detail: AriaElementDetail | null = null;
    try {
      detail = await locator.first().evaluate((el, ref): AriaElementDetail => {
        (el as HTMLElement).setAttribute("data-laya-ref", ref);
        const tag = el.tagName.toLowerCase();
        const out: AriaElementDetail = { tag, editable: false };
        if (tag === "input") {
          const input = el as HTMLInputElement;
          out.type = (input.getAttribute("type") ?? "text").toLowerCase();
          if (out.type === "checkbox" || out.type === "radio") {
            out.checked = input.checked;
          } else if (input.value) {
            out.value = input.value;
          }
          out.editable = !["checkbox", "radio", "submit", "button", "reset", "image", "hidden", "file", "range"].includes(
            out.type,
          );
          if (input.disabled) out.disabled = true;
        } else if (tag === "textarea") {
          const ta = el as HTMLTextAreaElement;
          if (ta.value) out.value = ta.value;
          out.editable = true;
          if (ta.disabled) out.disabled = true;
        } else if (tag === "select") {
          const sel = el as HTMLSelectElement;
          out.options = Array.from(sel.options).map((o) => o.label || o.value);
          const selected = sel.options[sel.selectedIndex];
          if (selected) out.value = selected.label || selected.value;
          if (sel.disabled) out.disabled = true;
        } else if (el.hasAttribute("contenteditable")) {
          const ce = el.getAttribute("contenteditable");
          out.editable = ce === "" || ce === "true";
          const txt = (el.textContent ?? "").trim();
          if (txt) out.value = txt;
        } else if (tag === "button") {
          const btn = el as HTMLButtonElement;
          out.type = (btn.getAttribute("type") ?? "submit").toLowerCase();
          if (btn.disabled) out.disabled = true;
        }
        return out;
      }, layaRef);
    } catch {
      detail = null;
    }

    const role = node.role ?? "";
    const name = (node.name ?? node.text ?? "").toString().trim();
    // Fold the ARIA state flags in as a best-effort fallback when the element read did not
    // supply them (keeps the contract shape valid even for non-DOM-mappable nodes).
    const ariaChecked =
      typeof node.checked === "boolean" ? node.checked : undefined;
    const control: Control = {
      ref: asRef(layaRef) as Ref,
      index: counter,
      role,
      name,
      tag: detail?.tag ?? role,
      editable: detail?.editable ?? (role === "textbox" || role === "searchbox"),
    };
    if (detail?.type !== undefined) control.type = detail.type;
    if (detail?.value !== undefined) control.value = detail.value;
    if (detail?.options !== undefined) control.options = detail.options;
    else if (role === "combobox" || role === "listbox") {
      // Comboboxes/listboxes expose their choices as child option nodes in the aria tree.
      const opts = (node.children ?? [])
        .filter((c): c is AriaNode => typeof c !== "string" && c.role === "option")
        .map((c) => (c.name ?? c.text ?? "").toString().trim())
        .filter(Boolean);
      if (opts.length > 0) control.options = opts;
    }
    const checked = detail?.checked ?? ariaChecked;
    if (checked !== undefined) control.checked = checked;
    if (detail?.disabled ?? node.disabled) control.disabled = true;
    controls.push(control);
  }

  // Page-level metadata: title/url from the page, visible text from the body innerText,
  // clamped the same way the DOM walk clamps it.
  const [url, title, bodyTextRaw] = await Promise.all([
    Promise.resolve(page.url()),
    page.title().catch(() => ""),
    page
      .evaluate(() => (document.body?.innerText ?? ""))
      .catch(() => ""),
  ]);
  const bodyText = bodyTextRaw
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const visibleText =
    bodyText.length > limit ? bodyText.slice(0, limit) + "\n... [truncated]" : bodyText;

  const raw: RawSnapshot = {
    url,
    title,
    visibleText,
    controls: controls.map((c) => ({
      ref: c.ref,
      index: c.index,
      role: c.role,
      name: c.name,
      tag: c.tag,
      editable: c.editable,
      ...(c.type !== undefined ? { type: c.type } : {}),
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(c.options !== undefined ? { options: c.options } : {}),
      ...(c.checked !== undefined ? { checked: c.checked } : {}),
      ...(c.disabled !== undefined ? { disabled: c.disabled } : {}),
    })),
  };

  return {
    url,
    title,
    visibleText,
    controls,
    text: formatSnapshot(raw, controls),
  };
}

/**
 * Render a snapshot as a compact, human-readable block:
 *
 *   URL: https://example.com/login
 *   Title: Sign in
 *
 *   - textbox "Email" [ref=e1]
 *   - textbox "Password" [ref=e2] (password)
 *   - button "Sign in" [ref=e3]
 */
function formatSnapshot(raw: RawSnapshot, controls: Control[]): string {
  const lines: string[] = [];
  lines.push(`URL: ${raw.url}`);
  lines.push(`Title: ${raw.title}`);
  lines.push("");

  if (controls.length === 0) {
    lines.push("- (no interactive or landmark elements found)");
  } else {
    for (const c of controls) {
      lines.push(controlLine(c));
    }
  }
  return lines.join("\n");
}

/** Format a single control as one snapshot line. */
function controlLine(c: Control): string {
  const parts = [`- ${c.role} ${JSON.stringify(c.name)} [ref=${c.ref}]`];

  const attrs: string[] = [];
  if (c.type && c.type !== c.role) attrs.push(c.type);
  if (c.disabled) attrs.push("disabled");
  if (c.checked !== undefined) attrs.push(c.checked ? "checked" : "unchecked");
  if (c.value) attrs.push(`value=${JSON.stringify(c.value)}`);
  if (c.options && c.options.length > 0) {
    attrs.push(`options=[${c.options.map((o) => JSON.stringify(o)).join(", ")}]`);
  }
  if (attrs.length > 0) parts.push(`(${attrs.join(", ")})`);

  return parts.join(" ");
}

/**
 * The in-page DOM walk. Runs INSIDE the browser (serialised by Playwright), so it must be
 * fully self-contained and close over nothing from the Node scope. Returns a plain object.
 *
 * Selection: anchors, buttons, inputs, textareas, selects, `[role]`, `[contenteditable]`,
 * headings (h1-h6), and labels. Each selected, visible element is stamped with a stable
 * `data-laya-ref="eN"` (monotonic in DOM order) and described as a raw control record.
 */
function domWalk(args: { visibleTextLimit: number; viewportPriority: boolean }): unknown {
  const { visibleTextLimit, viewportPriority } = args;
  const SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role]",
    "[contenteditable]",
    "[contenteditable='true']",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "label",
  ].join(",");

  function isVisible(el: Element): boolean {
    const he = el as HTMLElement;
    // Cheap style reads first, so a display:none / hidden / transparent element short-circuits
    // BEFORE any layout read. Only then read the bounding rect, exactly once, to decide the
    // zero-size case. This avoids the previous double forced reflow while selecting the same
    // elements as before (identical behaviour, fewer layout flushes).
    const style = window.getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
    const rect = he.getBoundingClientRect();
    // Allow zero-size elements that are inputs (some are visually collapsed but usable),
    // but skip truly detached/hidden ones.
    if (rect.width === 0 && rect.height === 0) {
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "select" && tag !== "textarea") return false;
    }
    return true;
  }

  function accessibleName(el: Element): string {
    const he = el as HTMLElement;
    const tag = el.tagName.toLowerCase();

    const ariaLabel = he.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = he.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    // Associated <label> for form fields.
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = he.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl && lbl.textContent && lbl.textContent.trim()) {
          return lbl.textContent.trim();
        }
      }
      const wrapping = he.closest("label");
      if (wrapping && wrapping.textContent && wrapping.textContent.trim()) {
        return wrapping.textContent.trim();
      }
      const placeholder = he.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
      const nameAttr = he.getAttribute("name");
      if (nameAttr && nameAttr.trim()) return nameAttr.trim();
    }

    if (tag === "input") {
      const type = (he.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") {
        const v = (he as HTMLInputElement).value;
        if (v && v.trim()) return v.trim();
      }
    }

    const title = he.getAttribute("title");
    if (title && title.trim()) return title.trim();

    const text = (he.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.length > 120 ? text.slice(0, 117) + "..." : text;

    const altImg = he.querySelector("img[alt]");
    if (altImg) {
      const alt = altImg.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();
    }

    return "";
  }

  function roleFor(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit && explicit.trim()) return explicit.trim();

    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a":
        return "link";
      case "button":
        return "button";
      case "select":
        return "combobox";
      case "textarea":
        return "textbox";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "label":
        return "label";
      case "input": {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        switch (type) {
          case "checkbox":
            return "checkbox";
          case "radio":
            return "radio";
          case "submit":
          case "button":
          case "reset":
          case "image":
            return "button";
          case "search":
            return "searchbox";
          case "range":
            return "slider";
          case "hidden":
            return "hidden";
          default:
            return "textbox";
        }
      }
      default:
        if (el.hasAttribute("contenteditable")) return "textbox";
        return tag;
    }
  }

  function isEditable(el: Element, role: string): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (el.hasAttribute("contenteditable")) {
      const ce = el.getAttribute("contenteditable");
      return ce === "" || ce === "true";
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      return !["checkbox", "radio", "submit", "button", "reset", "image", "hidden", "file", "range"].includes(
        type,
      );
    }
    return role === "textbox" || role === "searchbox";
  }

  // (C3) Shortest gap in CSS pixels between an element's box and the viewport rectangle.
  // Returns 0 when the element intersects the viewport (fully or partially in view). Used to
  // rank in/near-viewport controls ahead of far-offscreen ones when viewportPriority is on.
  function viewportDistance(el: Element): number {
    const rect = (el as HTMLElement).getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    // Horizontal / vertical gaps: 0 when the element overlaps the viewport on that axis.
    const dx =
      rect.right < 0 ? -rect.right : rect.left > vw ? rect.left - vw : 0;
    const dy =
      rect.bottom < 0 ? -rect.bottom : rect.top > vh ? rect.top - vh : 0;
    return Math.round(Math.hypot(dx, dy));
  }

  const results: RawControl[] = [];
  const seen = new Set<Element>();
  const elements = Array.from(document.querySelectorAll(SELECTOR));
  let counter = 0;

  for (const el of elements) {
    if (seen.has(el)) continue;
    seen.add(el);

    const tag = el.tagName.toLowerCase();
    const role = roleFor(el);
    if (role === "hidden") continue;
    if (!isVisible(el)) continue;

    // Skip <label> elements that are redundant with the field they name (via `for=`
    // or by wrapping it): the field itself is captured and already carries that name.
    if (role === "label") {
      const forId = el.getAttribute("for");
      if (forId && document.getElementById(forId)) continue;
      if (el.querySelector("input,textarea,select")) continue;
    }

    const name = accessibleName(el);
    // Skip label/heading elements that add no useful name.
    if ((role === "label" || role === "heading") && !name) continue;

    counter += 1;
    const ref = "e" + counter;
    el.setAttribute("data-laya-ref", ref);

    const editable = isEditable(el, role);
    const control: RawControl = {
      ref,
      index: counter,
      role,
      name,
      tag,
      editable,
    };
    // (C3) Record viewport proximity so the returned list can be sorted nearest-first. The
    // `eN` ref was already stamped in DOM order above, so sorting the list does not affect
    // resolveRef: eN still maps to the element it was stamped on.
    if (viewportPriority) control.viewportDistance = viewportDistance(el);

    if (tag === "input") {
      const input = el as HTMLInputElement;
      control.type = (input.getAttribute("type") ?? "text").toLowerCase();
      if (control.type === "checkbox" || control.type === "radio") {
        control.checked = input.checked;
      } else if (input.value) {
        control.value = input.value;
      }
      if (input.disabled) control.disabled = true;
    } else if (tag === "textarea") {
      const ta = el as HTMLTextAreaElement;
      if (ta.value) control.value = ta.value;
      if (ta.disabled) control.disabled = true;
    } else if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opts = Array.from(sel.options).map((o) => o.label || o.value);
      control.options = opts;
      const selected = sel.options[sel.selectedIndex];
      if (selected) control.value = selected.label || selected.value;
      if (sel.disabled) control.disabled = true;
    } else if (el.hasAttribute("contenteditable")) {
      const txt = (el.textContent ?? "").trim();
      if (txt) control.value = txt;
    } else if (tag === "button" || role === "button") {
      const btn = el as HTMLButtonElement;
      // Capture the button's type so submit controls are recognizable even when their
      // accessible name is terse (e.g. DuckDuckGo's `<button type="submit">b</button>`).
      // A <button> with no explicit type defaults to "submit" per the HTML spec.
      if (tag === "button") {
        const rawType = btn.getAttribute("type");
        control.type = (rawType ?? "submit").toLowerCase();
      }
      if (btn.disabled) control.disabled = true;
    }

    results.push(control);
  }

  const bodyText = (document.body?.innerText ?? "").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const visibleText =
    bodyText.length > visibleTextLimit
      ? bodyText.slice(0, visibleTextLimit) + "\n... [truncated]"
      : bodyText;

  // (C3) When viewport priority is on, stable-sort the RETURNED list by viewport proximity
  // (nearest first), preserving DOM order within each proximity band so the ordering is
  // deterministic. The `data-laya-ref="eN"` stamps stay in DOM order (unchanged), so
  // resolveRef('eN') remains correct; only the order controls are OFFERED in changes, which
  // lets the downstream ~20 cap keep the most relevant (nearest-viewport) controls.
  const ordered = viewportPriority
    ? results
        .map((c, i) => ({ c, i }))
        .sort((a, b) => {
          const da = a.c.viewportDistance ?? 0;
          const db = b.c.viewportDistance ?? 0;
          if (da !== db) return da - db;
          return a.i - b.i;
        })
        .map((e) => e.c)
    : results;

  return {
    url: window.location.href,
    title: document.title,
    visibleText,
    controls: ordered,
  } satisfies RawSnapshot;
}
