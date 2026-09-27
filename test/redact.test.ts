import { describe, it, expect } from "vitest";
import { redactText, redactValueForField, REDACTION_MASK } from "../src/redact.js";

describe("redactText", () => {
  it("masks a known literal secret value passed via extraSecrets", () => {
    const out = redactText("logged in with hunter2seCret! ok", ["hunter2seCret!"]);
    expect(out).not.toContain("hunter2seCret!");
    expect(out).toContain(REDACTION_MASK);
    expect(out).toBe(`logged in with ${REDACTION_MASK} ok`);
  });

  it("masks a literal secret everywhere it appears", () => {
    const out = redactText("s3kr3tvalue then again s3kr3tvalue", ["s3kr3tvalue"]);
    expect(out).toBe(`${REDACTION_MASK} then again ${REDACTION_MASK}`);
  });

  it("masks common secret token patterns", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactText(`token=${jwt}`)).not.toContain(jwt);
    expect(redactText("Authorization: Bearer abcDEF123456ghijkl")).not.toContain(
      "abcDEF123456ghijkl",
    );
    expect(redactText("key sk-abcdefghijklmnopqrstuvwx")).not.toContain(
      "sk-abcdefghijklmnopqrstuvwx",
    );
    expect(redactText("aws AKIAIOSFODNN7EXAMPLE here")).not.toContain(
      "AKIAIOSFODNN7EXAMPLE",
    );
    const hex = "a".repeat(40);
    expect(redactText(`hash ${hex}`)).not.toContain(hex);
    for (const masked of [
      redactText("Authorization: Bearer abcDEF123456ghijkl"),
      redactText("key sk-abcdefghijklmnopqrstuvwx"),
    ]) {
      expect(masked).toContain(REDACTION_MASK);
    }
  });

  it("leaves benign text untouched", () => {
    const benign = "Navigate to the pricing page and click Sign up";
    expect(redactText(benign)).toBe(benign);
    expect(redactText("short hex ff00ff")).toBe("short hex ff00ff");
  });

  it("is defensive and never throws on odd input", () => {
    // @ts-expect-error intentional non-string input
    expect(() => redactText(undefined)).not.toThrow();
    // @ts-expect-error intentional non-string input
    expect(() => redactText(123)).not.toThrow();
    // @ts-expect-error intentional non-array secrets
    expect(() => redactText("hello", "notanarray")).not.toThrow();
    expect(redactText("hello", [])).toBe("hello");
  });
});

describe("redactValueForField", () => {
  it("masks password-type and secret-named fields", () => {
    expect(redactValueForField("password", "hunter2")).toBe(REDACTION_MASK);
    expect(redactValueForField("user_password", "hunter2")).toBe(REDACTION_MASK);
    expect(redactValueForField("apiKey", "abc123")).toBe(REDACTION_MASK);
    expect(redactValueForField("api_key", "abc123")).toBe(REDACTION_MASK);
    expect(redactValueForField("card-cvv", "123")).toBe(REDACTION_MASK);
    expect(redactValueForField("ssn", "000-00-0000")).toBe(REDACTION_MASK);
    expect(redactValueForField("access-token", "xyz")).toBe(REDACTION_MASK);
    expect(redactValueForField("pin", "4321")).toBe(REDACTION_MASK);
  });

  it("passes through normal text fields unchanged", () => {
    expect(redactValueForField("email", "a@b.com")).toBe("a@b.com");
    expect(redactValueForField("text", "hello world")).toBe("hello world");
    expect(redactValueForField("username", "alice")).toBe("alice");
  });

  it("is defensive and never throws on odd input", () => {
    // @ts-expect-error intentional non-string input
    expect(() => redactValueForField(undefined, "v")).not.toThrow();
    // @ts-expect-error intentional non-string input
    expect(() => redactValueForField("password", 5)).not.toThrow();
    expect(redactValueForField("", "value")).toBe("value");
  });
});
