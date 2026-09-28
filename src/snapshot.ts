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
import type { Control, FastControl, FastSnapshot, NodeGuard, Ref } from "./types.js";
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
  /**
   * (T2.3) How many levels of SAME-ORIGIN iframe and OPEN shadow root the in-page DOM walk
   * descends into to discover controls. `0` (default) walks only the TOP document, exactly as
   * before, so existing callers are unaffected. Cross-origin iframes (whose `contentDocument`
   * is inaccessible) are skipped cleanly. Controls found inside a same-origin iframe still get
   * a `data-laya-ref="eN"` stamp inside that frame's document; {@link BrowserSession.resolveRef}
   * searches child frames so the stamped ref remains actionable.
   */
  frameDepth?: number;
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
    frameDepth: options.frameDepth ?? 0,
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
function domWalk(args: {
  visibleTextLimit: number;
  viewportPriority: boolean;
  frameDepth: number;
}): unknown {
  const { visibleTextLimit, viewportPriority, frameDepth } = args;
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

  // Resolve the window that owns an element, so getComputedStyle uses the correct document
  // view even for elements inside a same-origin iframe (T2.3). Falls back to the top window.
  function viewOf(el: Element): Window {
    return (el.ownerDocument && el.ownerDocument.defaultView) || window;
  }

  // (T4.3) Visibility check that REUSES a bounding rect the caller already read, so the DOM
  // walk performs exactly ONE getBoundingClientRect per element even when it also needs the
  // rect for viewport-proximity ordering. Cheap style reads still short-circuit first, so a
  // display:none / hidden / transparent element never triggers a layout read at all. The
  // selected visible/interactive set is identical to before (behaviour-preserving).
  function isVisibleWithRect(el: Element, rect: DOMRect | null): boolean {
    const he = el as HTMLElement;
    const style = viewOf(he).getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
    const r = rect ?? he.getBoundingClientRect();
    // Allow zero-size elements that are inputs (some are visually collapsed but usable),
    // but skip truly detached/hidden ones.
    if (r.width === 0 && r.height === 0) {
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

    // Use the element's OWN document for label lookups so refs inside a same-origin iframe
    // (T2.3) resolve their <label for=...> / aria-labelledby targets in the right document.
    const doc = he.ownerDocument || document;

    const labelledBy = he.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    // Associated <label> for form fields.
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = he.getAttribute("id");
      if (id) {
        const lbl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
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
  function viewportDistanceFromRect(el: Element, rect: DOMRect): number {
    const win = viewOf(el);
    const doc = el.ownerDocument || document;
    const vw = win.innerWidth || doc.documentElement.clientWidth || 0;
    const vh = win.innerHeight || doc.documentElement.clientHeight || 0;
    // Horizontal / vertical gaps: 0 when the element overlaps the viewport on that axis.
    const dx =
      rect.right < 0 ? -rect.right : rect.left > vw ? rect.left - vw : 0;
    const dy =
      rect.bottom < 0 ? -rect.bottom : rect.top > vh ? rect.top - vh : 0;
    return Math.round(Math.hypot(dx, dy));
  }

  // (T2.3) Collect matching elements from a root (Document or ShadowRoot), then descend into
  // OPEN shadow roots and SAME-ORIGIN iframes up to `depth` levels. Cross-origin iframes
  // (whose contentDocument throws / is null) are skipped cleanly so the walk never crashes.
  // Elements are collected in document order; the caller stamps refs in that order so
  // resolveRef stays deterministic. `frameDepth === 0` collects only the top document, exactly
  // as before.
  function collectElements(
    root: Document | ShadowRoot,
    depth: number,
    out: Element[],
  ): void {
    let matched: Element[] = [];
    try {
      matched = Array.from(root.querySelectorAll(SELECTOR));
    } catch {
      matched = [];
    }
    for (const el of matched) out.push(el);

    if (depth <= 0) return;

    // Descend into OPEN shadow roots of every element under this root. querySelectorAll("*")
    // is bounded by the DOM size; guard against closed shadow roots (shadowRoot === null).
    let allNodes: Element[] = [];
    try {
      allNodes = Array.from(root.querySelectorAll("*"));
    } catch {
      allNodes = [];
    }
    for (const node of allNodes) {
      const sr = (node as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) {
        collectElements(sr, depth - 1, out);
      }
      // Descend into SAME-ORIGIN iframes. Accessing contentDocument throws for cross-origin
      // frames; catch and skip so the walk degrades cleanly rather than crashing.
      if (node.tagName === "IFRAME") {
        try {
          const doc = (node as HTMLIFrameElement).contentDocument;
          if (doc) collectElements(doc, depth - 1, out);
        } catch {
          // Cross-origin frame: inaccessible by design; skip it.
        }
      }
    }
  }

  const results: RawControl[] = [];
  const seen = new Set<Element>();
  const elements: Element[] = [];
  collectElements(document, frameDepth, elements);
  let counter = 0;

  for (const el of elements) {
    if (seen.has(el)) continue;
    seen.add(el);

    const tag = el.tagName.toLowerCase();
    const role = roleFor(el);
    // (T4.3) role is computed ONCE here (a hidden input short-circuits before any layout
    // read). Read the bounding rect at most once per element and share it between the
    // visibility test and the optional viewport-proximity measure, avoiding a second reflow.
    if (role === "hidden") continue;
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (!isVisibleWithRect(el, rect)) continue;

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
    if (viewportPriority) control.viewportDistance = viewportDistanceFromRect(el, rect);

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

// ---------------------------------------------------------------------------
// (F1) The fast snapshot: one atomic page.evaluate that carries persistent node
// identity + per-node semantic guards + a page-level marker + a pageKey. This adopts the
// MECHANICS of the jev fast path (window.__jevFast identity WeakMap, guard array, page_key,
// marker) in TypeScript/Playwright. It is the per-step capture the (always-on) fast browser
// loop uses; the plain capture()/domWalk() path still backs final verification and Assist mode.
// ---------------------------------------------------------------------------

/** Raw guard record returned from the in-page fast walk (validated before trusting). */
interface RawNodeGuard {
  role: string;
  name: string;
  value: string | null;
  checked: boolean | null;
  selectedIndex: number | null;
  disabled: boolean;
  ariaExpanded: string | null;
  ariaChecked: string | null;
  ariaSelected: string | null;
  href: string | null;
  scopeText: string;
}

/** Raw per-control record returned from the in-page fast walk (before branding refs). */
interface RawFastControl {
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
  nodeId: number;
  guard: RawNodeGuard;
  rect: { x: number; y: number; w: number; h: number };
}

/** Raw result returned from the in-page fast walk. */
interface RawFastSnapshot {
  url: string;
  title: string;
  visibleText: string;
  controls: RawFastControl[];
  text: string;
  pageKey: string;
  marker: string;
}

/**
 * (F1) Capture an ATOMIC fast snapshot in ONE page.evaluate.
 *
 * Unlike {@link capture} (which the legacy loop uses), this single evaluate initializes or
 * reuses a window-scoped identity cache (`window.__layaFast`), prunes disconnected nodes,
 * assigns each visible interactive element a PERSISTENT integer `nodeId` (stable across
 * captures for the same live node), ALSO stamps `data-laya-ref="eN"` in DOM order (so
 * `resolveRef` still works and the legacy path is unaffected), and computes for each control
 * a {@link NodeGuard} plus its viewport rect. It also builds a page-level `marker` (whole-page
 * freshness token) and a `pageKey` (form-field identity token), mirroring the jev mechanics.
 *
 * The returned object comes from an UNTRUSTED page.evaluate, so it is validated at this Node
 * boundary by {@link assertFastSnapshot} before being returned; a malformed structure throws
 * a clear error rather than being trusted blindly.
 */
export async function captureFast(
  page: Page,
  options: CaptureOptions = {},
): Promise<FastSnapshot> {
  const limit = options.visibleTextLimit ?? DEFAULT_VISIBLE_TEXT_LIMIT;
  const raw = (await page.evaluate(fastWalk, { visibleTextLimit: limit })) as unknown;

  // Validate the untrusted eval output BEFORE trusting any field.
  assertRawFastSnapshot(raw);
  const rawSnap = raw as RawFastSnapshot;

  const controls: FastControl[] = rawSnap.controls.map((c) => ({
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
    nodeId: c.nodeId,
    guard: { ...c.guard },
    rect: { ...c.rect },
  }));

  return {
    url: rawSnap.url,
    title: rawSnap.title,
    visibleText: rawSnap.visibleText,
    controls,
    text: rawSnap.text,
    pageKey: rawSnap.pageKey,
    marker: rawSnap.marker,
  };
}

/**
 * (F1) Validate that an untrusted value is a plain finite integer. Used at the Node boundary
 * so a malformed nodeId from the page never becomes a non-integer or a NaN.
 */
function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** (F1) Validate a raw guard structure returned from the untrusted page.evaluate. */
function isRawNodeGuard(value: unknown): value is RawNodeGuard {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  const stringOrNull = (v: unknown): boolean => v === null || typeof v === "string";
  const boolOrNull = (v: unknown): boolean => v === null || typeof v === "boolean";
  const intOrNull = (v: unknown): boolean => v === null || isFiniteInteger(v);
  return (
    typeof g.role === "string" &&
    typeof g.name === "string" &&
    stringOrNull(g.value) &&
    boolOrNull(g.checked) &&
    intOrNull(g.selectedIndex) &&
    typeof g.disabled === "boolean" &&
    stringOrNull(g.ariaExpanded) &&
    stringOrNull(g.ariaChecked) &&
    stringOrNull(g.ariaSelected) &&
    stringOrNull(g.href) &&
    typeof g.scopeText === "string"
  );
}

/** (F1) Validate a numeric rect `{x,y,w,h}` returned from the untrusted page.evaluate. */
function isRawRect(value: unknown): value is { x: number; y: number; w: number; h: number } {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.x === "number" &&
    Number.isFinite(r.x) &&
    typeof r.y === "number" &&
    Number.isFinite(r.y) &&
    typeof r.w === "number" &&
    Number.isFinite(r.w) &&
    typeof r.h === "number" &&
    Number.isFinite(r.h)
  );
}

/**
 * (F1) A structural predicate for the raw fast snapshot, used by {@link assertRawFastSnapshot}
 * and exported style so a test can exercise the validator against a malformed structure.
 * Checks every field the fast path relies on: string url/title/visibleText/text/pageKey/marker
 * and an array of controls each carrying a finite integer nodeId, a well-formed guard, and a
 * numeric rect. Any malformed field makes this return false.
 */
export function isRawFastSnapshot(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (
    typeof s.url !== "string" ||
    typeof s.title !== "string" ||
    typeof s.visibleText !== "string" ||
    typeof s.text !== "string" ||
    typeof s.pageKey !== "string" ||
    typeof s.marker !== "string" ||
    !Array.isArray(s.controls)
  ) {
    return false;
  }
  for (const c of s.controls) {
    if (typeof c !== "object" || c === null) return false;
    const ctrl = c as Record<string, unknown>;
    if (
      typeof ctrl.ref !== "string" ||
      !isFiniteInteger(ctrl.index) ||
      typeof ctrl.role !== "string" ||
      typeof ctrl.name !== "string" ||
      typeof ctrl.tag !== "string" ||
      typeof ctrl.editable !== "boolean" ||
      !isFiniteInteger(ctrl.nodeId) ||
      !isRawNodeGuard(ctrl.guard) ||
      !isRawRect(ctrl.rect)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * (F1) Assert the untrusted fast-snapshot eval output is well-formed, throwing a clear error
 * otherwise. The fast path must NEVER trust an unvalidated structure from the page.
 */
function assertRawFastSnapshot(value: unknown): asserts value is RawFastSnapshot {
  if (!isRawFastSnapshot(value)) {
    throw new Error(
      "captureFast: malformed snapshot returned from the page (untrusted page.evaluate output failed validation).",
    );
  }
}

/**
 * (F1) The in-page fast walk. Runs INSIDE the browser (serialised by Playwright), so it must
 * be fully self-contained and close over nothing from the Node scope. Returns a plain object.
 *
 * It mirrors the jev snapshot.js mechanics:
 *   - a window-scoped identity cache `window.__layaFast = { ids: WeakMap, nodes: Map, next }`
 *     that assigns a persistent integer nodeId to each element and prunes disconnected nodes;
 *   - per-node semantic guards (role, name, value, checked, selectedIndex, disabled, the
 *     aria state attributes, href, and scopeText) captured at observation time;
 *   - a page-level `marker` (whole-page freshness) and a `pageKey` (form-field identity).
 * It also stamps `data-laya-ref="eN"` in DOM order so the legacy resolveRef path is unaffected.
 */
function fastWalk(args: { visibleTextLimit: number }): unknown {
  const { visibleTextLimit } = args;

  // The persistent in-page identity cache. Reused across captures so a node keeps its id.
  interface LayaFastCache {
    ids: WeakMap<Element, number>;
    nodes: Map<number, Element>;
    next: number;
  }
  const w = window as unknown as { __layaFast?: LayaFastCache };
  const cache: LayaFastCache =
    w.__layaFast ?? (w.__layaFast = { ids: new WeakMap<Element, number>(), nodes: new Map(), next: 1 });

  // Assign (or reuse) the persistent integer identity for an element, recording it in nodes.
  const identity = (el: Element): number => {
    let id = cache.ids.get(el);
    if (id === undefined) {
      id = cache.next++;
      cache.ids.set(el, id);
    }
    cache.nodes.set(id, el);
    return id;
  };

  // Prune identity entries whose node has left the document (mirror jev snapshot.js).
  for (const [id, el] of cache.nodes) {
    if (!el.isConnected) cache.nodes.delete(id);
  }

  const SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role]",
    "[contenteditable]",
    "[contenteditable='true']",
  ].join(",");

  function viewOf(el: Element): Window {
    return (el.ownerDocument && el.ownerDocument.defaultView) || window;
  }

  function isVisibleWithRect(el: Element, rect: DOMRect): boolean {
    const he = el as HTMLElement;
    const style = viewOf(he).getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
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

    const doc = he.ownerDocument || document;

    const labelledBy = he.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = he.getAttribute("id");
      if (id) {
        const lbl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
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

  // Compute the per-node semantic guard for one element (mirror jev's guard array as a struct).
  function guardFor(el: Element, role: string, name: string): RawGuard {
    const he = el as HTMLElement;
    const tag = el.tagName.toLowerCase();
    let value: string | null = null;
    let checked: boolean | null = null;
    let selectedIndex: number | null = null;
    if (tag === "input") {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        checked = input.checked;
      } else {
        value = input.value;
      }
    } else if (tag === "textarea") {
      value = (el as HTMLTextAreaElement).value;
    } else if (tag === "select") {
      selectedIndex = (el as HTMLSelectElement).selectedIndex;
      const sel = el as HTMLSelectElement;
      const selected = sel.options[sel.selectedIndex];
      value = selected ? selected.label || selected.value : null;
    } else if (el.hasAttribute("contenteditable")) {
      value = (el.textContent ?? "").trim();
    }
    const scope =
      el.closest("form,dialog,[role='dialog'],article,li,tr,[role='row']") || el.parentElement;
    const scopeText = ((scope as HTMLElement | null)?.innerText ?? "").slice(0, 6000);
    return {
      role,
      name,
      value,
      checked,
      selectedIndex,
      disabled: (el as HTMLButtonElement).disabled === true || el.matches(":disabled"),
      ariaExpanded: el.getAttribute("aria-expanded"),
      ariaChecked: el.getAttribute("aria-checked"),
      ariaSelected: el.getAttribute("aria-selected"),
      href: el.getAttribute("href"),
      scopeText,
    };
  }

  interface RawGuard {
    role: string;
    name: string;
    value: string | null;
    checked: boolean | null;
    selectedIndex: number | null;
    disabled: boolean;
    ariaExpanded: string | null;
    ariaChecked: string | null;
    ariaSelected: string | null;
    href: string | null;
    scopeText: string;
  }

  interface FastRaw {
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
    nodeId: number;
    guard: RawGuard;
    rect: { x: number; y: number; w: number; h: number };
  }

  const results: FastRaw[] = [];
  const seen = new Set<Element>();
  let elements: Element[] = [];
  try {
    elements = Array.from(document.querySelectorAll(SELECTOR));
  } catch {
    elements = [];
  }
  let counter = 0;

  for (const el of elements) {
    if (seen.has(el)) continue;
    seen.add(el);

    const role = roleFor(el);
    if (role === "hidden") continue;
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (!isVisibleWithRect(el, rect)) continue;

    const name = accessibleName(el);
    const tag = el.tagName.toLowerCase();

    counter += 1;
    const ref = "e" + counter;
    el.setAttribute("data-laya-ref", ref);
    const nodeId = identity(el);

    const editable = isEditable(el, role);
    const control: FastRaw = {
      ref,
      index: counter,
      role,
      name,
      tag,
      editable,
      nodeId,
      guard: guardFor(el, role, name),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };

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
      control.options = Array.from(sel.options).map((o) => o.label || o.value);
      const selected = sel.options[sel.selectedIndex];
      if (selected) control.value = selected.label || selected.value;
      if (sel.disabled) control.disabled = true;
    } else if (el.hasAttribute("contenteditable")) {
      const txt = (el.textContent ?? "").trim();
      if (txt) control.value = txt;
    } else if (tag === "button" || role === "button") {
      const btn = el as HTMLButtonElement;
      if (tag === "button") {
        const rawType = btn.getAttribute("type");
        control.type = (rawType ?? "submit").toLowerCase();
      }
      if (btn.disabled) control.disabled = true;
    }

    results.push(control);
  }

  const bodyText = (document.body?.innerText ?? "")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const visibleText =
    bodyText.length > visibleTextLimit
      ? bodyText.slice(0, visibleTextLimit) + "\n... [truncated]"
      : bodyText;

  // The compact human-readable text (same line format as the legacy snapshot).
  const lines: string[] = [];
  lines.push("URL: " + window.location.href);
  lines.push("Title: " + document.title);
  lines.push("");
  if (results.length === 0) {
    lines.push("- (no interactive or landmark elements found)");
  } else {
    for (const c of results) {
      const parts = ["- " + c.role + " " + JSON.stringify(c.name) + " [ref=" + c.ref + "]"];
      const attrs: string[] = [];
      if (c.type && c.type !== c.role) attrs.push(c.type);
      if (c.disabled) attrs.push("disabled");
      if (c.checked !== undefined) attrs.push(c.checked ? "checked" : "unchecked");
      if (c.value) attrs.push("value=" + JSON.stringify(c.value));
      if (c.options && c.options.length > 0) {
        attrs.push("options=[" + c.options.map((o) => JSON.stringify(o)).join(", ") + "]");
      }
      if (attrs.length > 0) parts.push("(" + attrs.join(", ") + ")");
      lines.push(parts.join(" "));
    }
  }
  const text = lines.join("\n");

  // pageKey: identity of the observed document/navigation plus every form field's state.
  // A change here means a form input was mutated or the page navigated/scrolled.
  let formState: unknown[] = [];
  try {
    formState = Array.from(document.querySelectorAll("input,textarea,select")).map((e) => {
      const el = e as HTMLInputElement & HTMLSelectElement;
      return [
        cache.ids.get(e) ?? -1,
        el.value ?? null,
        el.checked ?? null,
        el.selectedIndex ?? null,
        el.disabled ?? null,
        el.readOnly ?? null,
      ];
    });
  } catch {
    formState = [];
  }
  const pageKey = JSON.stringify([
    window.location.href,
    window.scrollX,
    window.scrollY,
    window.innerWidth,
    window.innerHeight,
    formState,
  ]);

  // marker: a whole-page freshness token = href + scroll + viewport + title + text + the
  // per-node semantic tuples. Compared cheaply when a per-node guard is not applicable.
  const semantics = results.map((c) => [
    c.nodeId,
    c.role,
    c.name,
    c.guard.value,
    c.guard.checked,
    c.guard.selectedIndex,
    c.guard.disabled,
    c.guard.ariaExpanded,
    c.guard.ariaChecked,
    c.guard.ariaSelected,
    c.guard.href,
  ]);
  const marker = JSON.stringify([
    window.location.href,
    window.scrollX,
    window.scrollY,
    window.innerWidth,
    window.innerHeight,
    document.title,
    visibleText,
    semantics,
  ]);

  return {
    url: window.location.href,
    title: document.title,
    visibleText,
    controls: results,
    text,
    pageKey,
    marker,
  } satisfies RawFastSnapshot;
}
