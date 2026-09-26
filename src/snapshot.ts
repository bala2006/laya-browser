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
}

/**
 * Capture a snapshot of the current page state.
 *
 * Stamps `data-laya-ref` attributes on the page as a side effect (so subsequent
 * `resolveRef` calls can find the elements), then formats the compact text snapshot.
 */
export async function capture(
  page: Page,
  options: CaptureOptions = {},
): Promise<Snapshot> {
  const limit = options.visibleTextLimit ?? DEFAULT_VISIBLE_TEXT_LIMIT;
  const raw = (await page.evaluate(domWalk, limit)) as RawSnapshot;

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
function domWalk(visibleTextLimit: number): unknown {
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
    // offsetParent is null for display:none (except position:fixed); also check rects.
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

  return {
    url: window.location.href,
    title: document.title,
    visibleText,
    controls: results,
  } satisfies RawSnapshot;
}
