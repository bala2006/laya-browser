/**
 * (F3) Pure unit tests for the WIDENED goal grammar and the policy batching/composition.
 *
 * These lock the on-device value resolution (no model, no network) for the shapes the fast
 * path relies on, and the deterministic composition that collapses a multi-field goal into a
 * single FILL_FORM while keeping a single-field goal on the TYPE_TEXT path. They MUST fail if
 * the grammar or the composition regresses. No em dashes anywhere in this file.
 */
import { buildState } from "../src/state-builder.js";
import {
  fieldValueFromGoal,
  goalAssignments,
  isSubmitControl,
} from "../src/laya/goal.js";
import { policySeed } from "../src/autopilot/policy.js";
import type { Control, PageState } from "../src/types.js";
import { asRef } from "../src/types.js";
import type { Snapshot } from "../src/snapshot.js";

/** Build a minimal Control with sensible defaults for the fields the heuristics read. */
function control(over: Partial<Control> & { ref: string; name: string }): Control {
  return {
    index: 1,
    role: "textbox",
    tag: "input",
    type: "text",
    editable: true,
    ...over,
    ref: asRef(over.ref),
  };
}

/** Build a PageState around a set of controls for the policy tests. */
function stateFor(goal: string, controls: Control[], recentActions: string[] = []): PageState {
  const snapshot: Snapshot = {
    url: "http://localhost/form",
    title: "Form",
    visibleText: "",
    controls,
    text: "",
  };
  return buildState(goal, snapshot, recentActions);
}

describe("widened goal grammar: local value resolution with zero network", () => {
  it("resolves an UNQUOTED email whose dots and @ used to truncate the value", () => {
    const assignments = goalAssignments("email is a@b.com");
    expect(assignments.get("email")).toBe("a@b.com");

    const field = control({ ref: "e1", name: "Email", type: "email" });
    expect(fieldValueFromGoal(field, "email is a@b.com")).toBe("a@b.com");
  });

  it("resolves an UNQUOTED date in ISO and MM/DD/YYYY form", () => {
    expect(goalAssignments("date is 2024-01-15").get("date")).toBe("2024-01-15");
    expect(goalAssignments("date is 01/15/2024").get("date")).toBe("01/15/2024");

    const field = control({ ref: "e1", name: "Date", type: "date" });
    expect(fieldValueFromGoal(field, "date is 2024-01-15")).toBe("2024-01-15");
    expect(fieldValueFromGoal(field, "date is 01/15/2024")).toBe("01/15/2024");
  });

  it("resolves a QUOTED multi-word value (city) exactly", () => {
    expect(goalAssignments('city is "New York"').get("city")).toBe("New York");

    const field = control({ ref: "e1", name: "City" });
    expect(fieldValueFromGoal(field, 'city is "New York"')).toBe("New York");
  });

  it("resolves an UNQUOTED multi-word value that stops at a clause boundary", () => {
    // A bare multi-word value survives whole; a trailing clause is dropped.
    expect(goalAssignments("city is New York").get("city")).toBe("New York");
    expect(goalAssignments("name is Ada Lovelace").get("name")).toBe("Ada Lovelace");
    expect(goalAssignments("name is Ada Lovelace.").get("name")).toBe("Ada Lovelace");
    expect(goalAssignments("city is New York, then submit").get("city")).toBe("New York");
  });

  it("resolves a two-field name + email goal into BOTH values", () => {
    const assignments = goalAssignments(
      "name is Ada Lovelace and email is ada@example.com",
    );
    expect(assignments.get("name")).toBe("Ada Lovelace");
    expect(assignments.get("email")).toBe("ada@example.com");

    const name = control({ ref: "e1", name: "Name" });
    const email = control({ ref: "e2", name: "Email", type: "email" });
    const controls = [name, email];
    expect(
      fieldValueFromGoal(name, "name is Ada Lovelace and email is ada@example.com", controls),
    ).toBe("Ada Lovelace");
    expect(
      fieldValueFromGoal(email, "name is Ada Lovelace and email is ada@example.com", controls),
    ).toBe("ada@example.com");
  });

  it("keeps the multi-field no-name-match safety (does not dump into an arbitrary field)", () => {
    // Two fields, neither named to match a search-intent goal: no value is dumped anywhere.
    const a = control({ ref: "e1", name: "code" });
    const b = control({ ref: "e2", name: "zip" });
    const controls = [a, b];
    expect(fieldValueFromGoal(a, 'search for "laptop"', controls)).toBeUndefined();
    expect(fieldValueFromGoal(b, 'search for "laptop"', controls)).toBeUndefined();
  });

  it("does not regress existing quoted / separator shapes", () => {
    expect(goalAssignments('search for "laptops"').get("search")).toBe("laptops");
    expect(goalAssignments("password = secret").get("password")).toBe("secret");
    expect(goalAssignments('email "user@example.com"').get("email")).toBe(
      "user@example.com",
    );
  });
});

describe("policy composition: batching a multi-field goal vs a single-field goal", () => {
  it("batches a 3+ field goal into ONE FILL_FORM step", () => {
    const first = control({ ref: "e1", name: "First name" });
    const last = control({ ref: "e2", name: "Last name" });
    const email = control({ ref: "e3", name: "Email", type: "email" });
    const submit = control({
      ref: "e4",
      name: "Save",
      role: "button",
      tag: "button",
      type: "submit",
      editable: false,
    });
    const state = stateFor(
      'first name is Ada and last name is Lovelace and email is ada@example.com and expect "Saved"',
      [first, last, email, submit],
    );
    const seed = policySeed(state);
    expect(seed).toBeDefined();
    expect(seed!.decision.operation).toBe("FILL_FORM");
    if (seed!.decision.operation === "FILL_FORM") {
      // All three unfilled goal fields are filled in the single batch (submit is not a field).
      expect(seed!.decision.fields).toHaveLength(3);
      const targets = seed!.decision.fields.map((f) => f.target).sort();
      expect(targets).toEqual(["e1", "e2", "e3"]);
      const byTarget = new Map(seed!.decision.fields.map((f) => [f.target, f.value]));
      expect(byTarget.get("e1")).toBe("Ada");
      expect(byTarget.get("e2")).toBe("Lovelace");
      expect(byTarget.get("e3")).toBe("ada@example.com");
    }
    // The batch is one FILL_FORM Decision, not three TYPE_TEXT steps.
    expect(seed!.decision.operationConfidence).toBe(0.97);
  });

  it("keeps a SINGLE-field goal on the TYPE_TEXT path (no batch overhead)", () => {
    const email = control({ ref: "e1", name: "Email", type: "email" });
    const state = stateFor("email is a@b.com", [email]);
    const seed = policySeed(state);
    expect(seed).toBeDefined();
    expect(seed!.decision.operation).toBe("TYPE_TEXT");
    if (seed!.decision.operation === "TYPE_TEXT") {
      expect(seed!.decision.target).toBe("e1");
      expect(seed!.decision.value).toBe("a@b.com");
    }
  });

  it("composes toward the single submit once every batched field is filled", () => {
    // With both fields already holding their goal values, the minimal next Decision is the
    // submit CLICK (one valid Decision), not a re-fill.
    const first = control({ ref: "e1", name: "First name", value: "Ada" });
    const last = control({ ref: "e2", name: "Last name", value: "Lovelace" });
    const submit = control({
      ref: "e3",
      name: "Save",
      role: "button",
      tag: "button",
      type: "submit",
      editable: false,
    });
    expect(isSubmitControl(submit)).toBe(true);
    const state = stateFor(
      'first name is Ada and last name is Lovelace and expect "Saved"',
      [first, last, submit],
    );
    const seed = policySeed(state);
    expect(seed).toBeDefined();
    expect(seed!.decision.operation).toBe("CLICK");
    if (seed!.decision.operation === "CLICK") {
      expect(seed!.decision.target).toBe("e3");
    }
  });
});
