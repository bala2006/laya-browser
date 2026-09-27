import { describe, it, expect } from "vitest";
import {
  asRef,
  type Control,
  type Decision,
  type FastControl,
  type FastSnapshot,
  type NodeGuard,
  type Operation,
  type PageState,
} from "../src/types.js";

describe("core types", () => {
  it("constructs a PageState with a numbered control", () => {
    const control: Control = {
      ref: asRef("e5"),
      index: 1,
      role: "textbox",
      name: "Email",
      tag: "input",
      type: "email",
      value: "",
      editable: true,
    };

    const state: PageState = {
      goal: "Sign up for the newsletter",
      url: "https://example.com/signup",
      title: "Sign up",
      visibleText: "Enter your email to subscribe.",
      controls: [control],
      recentActions: ["navigate https://example.com/signup"],
    };

    expect(state.goal).toBe("Sign up for the newsletter");
    expect(state.controls).toHaveLength(1);
    expect(state.controls[0]!.ref).toBe("e5");
    expect(state.controls[0]!.index).toBe(1);
    expect(state.controls[0]!.editable).toBe(true);
    expect(state.recentActions[0]).toBe("navigate https://example.com/signup");
  });

  it("models a targeted decision that carries a target ref", () => {
    const decision: Decision = {
      operation: "TYPE_TEXT",
      operationConfidence: 0.92,
      target: asRef("e5"),
      targetConfidence: 0.88,
      value: "user@example.com",
      source: "stub",
    };

    expect(decision.operation).toBe("TYPE_TEXT");
    expect(decision.target).toBe("e5");
    expect(decision.value).toBe("user@example.com");
    expect(decision.source).toBe("stub");
  });

  it("models a targetless DONE decision", () => {
    const decision: Decision = {
      operation: "DONE",
      operationConfidence: 1,
      targetConfidence: 1,
      source: "rule",
    };

    const op: Operation = decision.operation;
    expect(op).toBe("DONE");
    expect(decision.target).toBeUndefined();
  });

  it("models a FILL_FORM batch carrying fields but no single target", () => {
    const decision: Decision = {
      operation: "FILL_FORM",
      operationConfidence: 0.99,
      targetConfidence: 0.99,
      fields: [
        { target: asRef("e1"), value: "user@example.com" },
        { target: asRef("e2"), value: "hunter2" },
      ],
      source: "rule",
    };
    expect(decision.operation).toBe("FILL_FORM");
    expect(decision.target).toBeUndefined();
    expect(decision.fields).toHaveLength(2);
    expect(decision.fields[0]!.value).toBe("user@example.com");
  });

  it("models a PRESS_KEY carrying a key payload", () => {
    const decision: Decision = {
      operation: "PRESS_KEY",
      operationConfidence: 1,
      targetConfidence: 1,
      key: "Enter",
      source: "llm",
    };
    expect(decision.operation).toBe("PRESS_KEY");
    expect(decision.key).toBe("Enter");
    expect(decision.target).toBeUndefined();
  });
});

describe("fast-path types (F1)", () => {
  it("constructs a NodeGuard with the applicable/null-when-not fields", () => {
    const guard: NodeGuard = {
      role: "textbox",
      name: "Email",
      value: "user@example.com",
      checked: null,
      selectedIndex: null,
      disabled: false,
      ariaExpanded: null,
      ariaChecked: null,
      ariaSelected: null,
      href: null,
      scopeText: "Sign up form",
    };

    // Round-trips through JSON (crosses the untrusted page.evaluate boundary).
    const round = JSON.parse(JSON.stringify(guard)) as NodeGuard;
    expect(round).toEqual(guard);
    expect(round.value).toBe("user@example.com");
    expect(round.checked).toBeNull();
    expect(round.selectedIndex).toBeNull();
  });

  it("builds a FastControl requiring nodeId, guard and rect (extends Control)", () => {
    const control: FastControl = {
      ref: asRef("e3"),
      index: 1,
      role: "button",
      name: "Submit",
      tag: "button",
      editable: false,
      nodeId: 42,
      guard: {
        role: "button",
        name: "Submit",
        value: null,
        checked: null,
        selectedIndex: null,
        disabled: false,
        ariaExpanded: null,
        ariaChecked: null,
        ariaSelected: null,
        href: null,
        scopeText: "Checkout",
      },
      rect: { x: 10, y: 20, w: 100, h: 40 },
    };

    // A FastControl is assignable to a plain Control (structural extension).
    const asControl: Control = control;
    expect(asControl.ref).toBe("e3");
    expect(control.nodeId).toBe(42);
    expect(control.rect.w).toBe(100);
    expect(control.guard.role).toBe("button");
  });

  it("assembles a FastSnapshot literal that round-trips through JSON", () => {
    const snapshot: FastSnapshot = {
      url: "https://example.com/checkout",
      title: "Checkout",
      visibleText: "Complete your purchase.",
      controls: [
        {
          ref: asRef("e1"),
          index: 1,
          role: "button",
          name: "Pay",
          tag: "button",
          editable: false,
          nodeId: 7,
          guard: {
            role: "button",
            name: "Pay",
            value: null,
            checked: null,
            selectedIndex: null,
            disabled: false,
            ariaExpanded: null,
            ariaChecked: null,
            ariaSelected: null,
            href: null,
            scopeText: "Checkout",
          },
          rect: { x: 0, y: 0, w: 80, h: 30 },
        },
      ],
      text: "Complete your purchase. Pay now.",
      pageKey: "nav-1",
      marker: "m-abc123",
    };

    const round = JSON.parse(JSON.stringify(snapshot)) as FastSnapshot;
    expect(round).toEqual(snapshot);
    expect(round.controls).toHaveLength(1);
    expect(round.controls[0]!.nodeId).toBe(7);
    expect(round.pageKey).toBe("nav-1");
    expect(round.marker).toBe("m-abc123");
  });
});
