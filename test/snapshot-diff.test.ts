/**
 * (C2) Pure snapshot-diff tests.
 *
 * diffSnapshots is a pure function keyed by a stable control identity (role + name), so these
 * tests build synthetic Snapshots and assert added / removed / changed / empty behaviour with
 * no browser and no IO.
 */
import { describe, it, expect } from "vitest";
import { diffSnapshots, hasChanges } from "../src/snapshot-diff.js";
import type { Snapshot } from "../src/snapshot.js";
import { asRef, type Control } from "../src/types.js";

/** Build a minimal control with sensible defaults. */
function control(partial: Partial<Control> & { role: string; name: string }): Control {
  return {
    ref: asRef(partial.ref ?? "e1"),
    index: partial.index ?? 1,
    role: partial.role,
    name: partial.name,
    tag: partial.tag ?? "input",
    editable: partial.editable ?? false,
    ...(partial.type !== undefined ? { type: partial.type } : {}),
    ...(partial.value !== undefined ? { value: partial.value } : {}),
    ...(partial.options !== undefined ? { options: partial.options } : {}),
    ...(partial.checked !== undefined ? { checked: partial.checked } : {}),
    ...(partial.disabled !== undefined ? { disabled: partial.disabled } : {}),
  };
}

/** Wrap a control list into a Snapshot with placeholder page metadata. */
function snapshot(controls: Control[]): Snapshot {
  return {
    url: "http://x/",
    title: "T",
    visibleText: "",
    controls,
    text: "",
  };
}

describe("diffSnapshots (pure)", () => {
  it("reports every control as added when there is no previous snapshot", () => {
    const next = snapshot([
      control({ ref: "e1", role: "textbox", name: "Email" }),
      control({ ref: "e2", role: "button", name: "Sign in" }),
    ]);
    const diff = diffSnapshots(undefined, next);
    expect(diff.added.map((c) => c.name)).toEqual(["Email", "Sign in"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(hasChanges(diff)).toBe(true);
  });

  it("returns an empty diff for identical snapshots", () => {
    const controls = [
      control({ ref: "e1", role: "textbox", name: "Email", value: "a@b.c" }),
      control({ ref: "e2", role: "button", name: "Sign in" }),
    ];
    // Fresh refs on the "next" snapshot (refs are per-snapshot) but same identities/state.
    const prev = snapshot(controls.map((c) => ({ ...c })));
    const next = snapshot([
      control({ ref: "e7", role: "textbox", name: "Email", value: "a@b.c" }),
      control({ ref: "e8", role: "button", name: "Sign in" }),
    ]);
    const diff = diffSnapshots(prev, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(hasChanges(diff)).toBe(false);
  });

  it("detects an added control against a prior snapshot", () => {
    const prev = snapshot([control({ ref: "e1", role: "textbox", name: "Email" })]);
    const next = snapshot([
      control({ ref: "e1", role: "textbox", name: "Email" }),
      control({ ref: "e2", role: "button", name: "Sign in" }),
    ]);
    const diff = diffSnapshots(prev, next);
    expect(diff.added.map((c) => c.name)).toEqual(["Sign in"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("detects a removed control against a prior snapshot", () => {
    const prev = snapshot([
      control({ ref: "e1", role: "textbox", name: "Email" }),
      control({ ref: "e2", role: "button", name: "Sign in" }),
    ]);
    const next = snapshot([control({ ref: "e1", role: "textbox", name: "Email" })]);
    const diff = diffSnapshots(prev, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed.map((c) => c.name)).toEqual(["Sign in"]);
    expect(diff.changed).toEqual([]);
  });

  it("detects a changed control (value change) keyed by role+name", () => {
    const prev = snapshot([
      control({ ref: "e1", role: "textbox", name: "Email", value: "" }),
    ]);
    const next = snapshot([
      control({ ref: "e9", role: "textbox", name: "Email", value: "user@example.com" }),
    ]);
    const diff = diffSnapshots(prev, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0]!.before.value).toBe("");
    expect(diff.changed[0]!.after.value).toBe("user@example.com");
  });

  it("detects a changed control (checked state change)", () => {
    const prev = snapshot([
      control({ ref: "e1", role: "checkbox", name: "Remember me", checked: false }),
    ]);
    const next = snapshot([
      control({ ref: "e1", role: "checkbox", name: "Remember me", checked: true }),
    ]);
    const diff = diffSnapshots(prev, next);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0]!.after.checked).toBe(true);
  });

  it("handles added, removed, and changed together in one diff", () => {
    const prev = snapshot([
      control({ ref: "e1", role: "textbox", name: "Email", value: "" }),
      control({ ref: "e2", role: "button", name: "Old" }),
    ]);
    const next = snapshot([
      control({ ref: "e1", role: "textbox", name: "Email", value: "x" }),
      control({ ref: "e2", role: "button", name: "New" }),
    ]);
    const diff = diffSnapshots(prev, next);
    expect(diff.added.map((c) => c.name)).toEqual(["New"]);
    expect(diff.removed.map((c) => c.name)).toEqual(["Old"]);
    expect(diff.changed.map((c) => c.after.name)).toEqual(["Email"]);
  });
});
