import { describe, it, expect } from "vitest";
import {
  asRef,
  type Control,
  type Decision,
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
});
