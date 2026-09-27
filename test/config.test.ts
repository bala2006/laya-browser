import { describe, it, expect } from "vitest";
import { loadConfig, type Capability } from "../src/config.js";

describe("loadConfig capability and engine parsing", () => {
  it("defaults to core-only capabilities and chromium engine", () => {
    const config = loadConfig({}, {});
    expect(config.capabilities).toEqual([]);
    expect(config.browserEngine).toBe("chromium");
  });

  it("defaults to HEADED (headless false) and honours the literal 'true'", () => {
    expect(loadConfig({}, {}).headless).toBe(false);
    expect(loadConfig({}, { LAYA_BROWSER_HEADLESS: "false" }).headless).toBe(false);
    expect(loadConfig({}, { LAYA_BROWSER_HEADLESS: "1" }).headless).toBe(false);
    expect(loadConfig({}, { LAYA_BROWSER_HEADLESS: "true" }).headless).toBe(true);
    expect(loadConfig({ headless: true }, {}).headless).toBe(true);
  });

  it("resolves the overlay with sensible defaults (auto = on when headed)", () => {
    const overlay = loadConfig({}, {}).overlay;
    expect(overlay.mode).toBe("auto");
    expect(overlay.enabled).toBe(true); // headed default -> overlay on
    expect(overlay.accent).toBe("#3b82f6");
    expect(overlay.typingEffect).toBe(false);
    expect(overlay.waitCountdown).toBe(false);
    expect(overlay.debugSeeElements).toBe(false);
    expect(overlay.activityLog).toBe(true);
  });

  it("auto overlay turns OFF when headless, and on/off force it regardless", () => {
    expect(loadConfig({}, { LAYA_BROWSER_HEADLESS: "true" }).overlay.enabled).toBe(false);
    expect(
      loadConfig({}, { LAYA_BROWSER_HEADLESS: "true", LAYA_BROWSER_OVERLAY: "on" }).overlay
        .enabled,
    ).toBe(true);
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY: "off" }).overlay.enabled).toBe(false);
  });

  it("validates the overlay accent hex and falls back on garbage", () => {
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_ACCENT: "#0af" }).overlay.accent).toBe("#0af");
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_ACCENT: "#00aaff" }).overlay.accent).toBe(
      "#00aaff",
    );
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_ACCENT: "rebeccapurple" }).overlay.accent).toBe(
      "#3b82f6",
    );
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_ACCENT: "#xyz" }).overlay.accent).toBe(
      "#3b82f6",
    );
  });

  it("parses the opt-in overlay sub-knobs from env", () => {
    const config = loadConfig(
      {},
      {
        LAYA_BROWSER_OVERLAY_TYPING: "true",
        LAYA_BROWSER_OVERLAY_COUNTDOWN: "true",
        LAYA_BROWSER_OVERLAY_DEBUG: "true",
        LAYA_BROWSER_OVERLAY_LOG: "false",
      },
    );
    expect(config.overlay.typingEffect).toBe(true);
    expect(config.overlay.waitCountdown).toBe(true);
    expect(config.overlay.debugSeeElements).toBe(true);
    expect(config.overlay.activityLog).toBe(false);
  });

  it("(T2) defaults the escalation gate to 0.85 and lets LAYA_CONFIDENCE_THRESHOLD override", () => {
    expect(loadConfig({}, {}).confidenceThreshold).toBe(0.85);
    expect(loadConfig({}, { LAYA_CONFIDENCE_THRESHOLD: "0.6" }).confidenceThreshold).toBe(0.6);
    expect(loadConfig({}, { LAYA_CONFIDENCE_THRESHOLD: "0.9" }).confidenceThreshold).toBe(0.9);
    // Out-of-range values fall back to the default; explicit override wins over env.
    expect(loadConfig({}, { LAYA_CONFIDENCE_THRESHOLD: "1.5" }).confidenceThreshold).toBe(0.85);
    expect(loadConfig({}, { LAYA_CONFIDENCE_THRESHOLD: "garbage" }).confidenceThreshold).toBe(
      0.85,
    );
    expect(loadConfig({ confidenceThreshold: 0.5 }, {}).confidenceThreshold).toBe(0.5);
  });

  it("parses and clamps the Autopilot WAIT ms with a lower default than the legacy 500", () => {
    expect(loadConfig({}, {}).autopilotWaitMs).toBe(300);
    expect(loadConfig({}, { LAYA_AUTOPILOT_WAIT_MS: "1000" }).autopilotWaitMs).toBe(1000);
    expect(loadConfig({}, { LAYA_AUTOPILOT_WAIT_MS: "99999" }).autopilotWaitMs).toBe(300); // out of range -> default
    expect(loadConfig({}, { LAYA_AUTOPILOT_WAIT_MS: "-5" }).autopilotWaitMs).toBe(300); // out of range -> default
    expect(loadConfig({}, { LAYA_AUTOPILOT_WAIT_MS: "garbage" }).autopilotWaitMs).toBe(300);
    expect(loadConfig({ autopilotWaitMs: 42 }, {}).autopilotWaitMs).toBe(42);
  });

  it("parses LAYA_CAPS into a typed, comma/space-separated capability list", () => {
    const config = loadConfig({}, { LAYA_CAPS: "network, storage devtools" });
    expect(config.capabilities).toEqual<Capability[]>([
      "network",
      "storage",
      "devtools",
    ]);
  });

  it("drops unknown capability names from LAYA_CAPS", () => {
    const config = loadConfig({}, { LAYA_CAPS: "network,bogus,pdf" });
    expect(config.capabilities).toEqual<Capability[]>(["network", "pdf"]);
  });

  it("parses LAYA_BROWSER into browserEngine and rejects invalid engines", () => {
    expect(loadConfig({}, { LAYA_BROWSER: "firefox" }).browserEngine).toBe("firefox");
    expect(loadConfig({}, { LAYA_BROWSER: "webkit" }).browserEngine).toBe("webkit");
    expect(loadConfig({}, { LAYA_BROWSER: "netscape" }).browserEngine).toBe("chromium");
  });

  it("lets overrides win over env for capabilities and engine", () => {
    const config = loadConfig(
      { capabilities: ["vision"], browserEngine: "webkit" },
      { LAYA_CAPS: "network", LAYA_BROWSER: "firefox" },
    );
    expect(config.capabilities).toEqual<Capability[]>(["vision"]);
    expect(config.browserEngine).toBe("webkit");
  });

  it("defaults allowUnsafeCode off and enables it only for the literal 'true'", () => {
    expect(loadConfig({}, {}).allowUnsafeCode).toBe(false);
    expect(loadConfig({}, { LAYA_ALLOW_UNSAFE_CODE: "false" }).allowUnsafeCode).toBe(false);
    expect(loadConfig({}, { LAYA_ALLOW_UNSAFE_CODE: "1" }).allowUnsafeCode).toBe(false);
    expect(loadConfig({}, { LAYA_ALLOW_UNSAFE_CODE: "true" }).allowUnsafeCode).toBe(true);
    expect(loadConfig({ allowUnsafeCode: true }, {}).allowUnsafeCode).toBe(true);
  });
});

describe("loadConfig reliability/trust/perf knobs (A1/A2/A3/B1/B2/B3/C1/C3)", () => {
  it("uses the documented defaults when no env is set", () => {
    const config = loadConfig({}, {});
    expect(config.selfHealRetries).toBe(1);
    expect(config.settleProbe).toBe(true);
    expect(config.loopDetection).toBe(true);
    expect(config.loopWindow).toBe(3);
    expect(config.redactSecrets).toBe(true);
    expect(config.confirmDestructive).toBe(false);
    expect(config.assistDestructiveGuard).toBe(false);
    expect(config.snapshotBackend).toBe("domwalk");
    expect(config.viewportPriority).toBe(true);
    expect(config.recordArtifacts).toBe(false);
  });

  it("(A1) parses and clamps LAYA_SELF_HEAL_RETRIES to [0, 3]", () => {
    expect(loadConfig({}, { LAYA_SELF_HEAL_RETRIES: "0" }).selfHealRetries).toBe(0);
    expect(loadConfig({}, { LAYA_SELF_HEAL_RETRIES: "2" }).selfHealRetries).toBe(2);
    expect(loadConfig({}, { LAYA_SELF_HEAL_RETRIES: "3" }).selfHealRetries).toBe(3);
    // Out of parse-range -> default; override clamps into range.
    expect(loadConfig({}, { LAYA_SELF_HEAL_RETRIES: "99" }).selfHealRetries).toBe(1);
    expect(loadConfig({}, { LAYA_SELF_HEAL_RETRIES: "garbage" }).selfHealRetries).toBe(1);
    expect(loadConfig({ selfHealRetries: 10 }, {}).selfHealRetries).toBe(3);
    expect(loadConfig({ selfHealRetries: -5 }, {}).selfHealRetries).toBe(0);
  });

  it("(A2) parses LAYA_SETTLE_PROBE as default-true (only 'false' disables)", () => {
    expect(loadConfig({}, { LAYA_SETTLE_PROBE: "false" }).settleProbe).toBe(false);
    expect(loadConfig({}, { LAYA_SETTLE_PROBE: "true" }).settleProbe).toBe(true);
    expect(loadConfig({}, { LAYA_SETTLE_PROBE: "1" }).settleProbe).toBe(true);
    expect(loadConfig({ settleProbe: false }, {}).settleProbe).toBe(false);
  });

  it("(A3) parses LAYA_LOOP_DETECTION and clamps LAYA_LOOP_WINDOW to [2, 6]", () => {
    expect(loadConfig({}, { LAYA_LOOP_DETECTION: "false" }).loopDetection).toBe(false);
    expect(loadConfig({}, { LAYA_LOOP_WINDOW: "5" }).loopWindow).toBe(5);
    expect(loadConfig({}, { LAYA_LOOP_WINDOW: "2" }).loopWindow).toBe(2);
    expect(loadConfig({}, { LAYA_LOOP_WINDOW: "6" }).loopWindow).toBe(6);
    // Out of parse-range -> default; override clamps into range.
    expect(loadConfig({}, { LAYA_LOOP_WINDOW: "99" }).loopWindow).toBe(3);
    expect(loadConfig({}, { LAYA_LOOP_WINDOW: "garbage" }).loopWindow).toBe(3);
    expect(loadConfig({ loopWindow: 100 }, {}).loopWindow).toBe(6);
    expect(loadConfig({ loopWindow: 1 }, {}).loopWindow).toBe(2);
  });

  it("(B1) parses LAYA_REDACT_SECRETS as default-true (only 'false' disables)", () => {
    expect(loadConfig({}, { LAYA_REDACT_SECRETS: "false" }).redactSecrets).toBe(false);
    expect(loadConfig({}, { LAYA_REDACT_SECRETS: "true" }).redactSecrets).toBe(true);
    expect(loadConfig({ redactSecrets: false }, {}).redactSecrets).toBe(false);
  });

  it("(B2) parses LAYA_CONFIRM_DESTRUCTIVE as default-false (only 'true' enables)", () => {
    expect(loadConfig({}, { LAYA_CONFIRM_DESTRUCTIVE: "true" }).confirmDestructive).toBe(true);
    expect(loadConfig({}, { LAYA_CONFIRM_DESTRUCTIVE: "1" }).confirmDestructive).toBe(false);
    expect(loadConfig({ confirmDestructive: true }, {}).confirmDestructive).toBe(true);
  });

  it("(B3) parses LAYA_ASSIST_DESTRUCTIVE_GUARD as default-false (only 'true' enables)", () => {
    expect(
      loadConfig({}, { LAYA_ASSIST_DESTRUCTIVE_GUARD: "true" }).assistDestructiveGuard,
    ).toBe(true);
    expect(
      loadConfig({}, { LAYA_ASSIST_DESTRUCTIVE_GUARD: "1" }).assistDestructiveGuard,
    ).toBe(false);
    expect(loadConfig({ assistDestructiveGuard: true }, {}).assistDestructiveGuard).toBe(true);
  });

  it("(C1) parses LAYA_SNAPSHOT_BACKEND and rejects unknown backends", () => {
    expect(loadConfig({}, { LAYA_SNAPSHOT_BACKEND: "aria" }).snapshotBackend).toBe("aria");
    expect(loadConfig({}, { LAYA_SNAPSHOT_BACKEND: "domwalk" }).snapshotBackend).toBe("domwalk");
    expect(loadConfig({}, { LAYA_SNAPSHOT_BACKEND: "bogus" }).snapshotBackend).toBe("domwalk");
    expect(loadConfig({ snapshotBackend: "aria" }, {}).snapshotBackend).toBe("aria");
  });

  it("(C3) parses LAYA_VIEWPORT_PRIORITY as default-true (only 'false' disables)", () => {
    expect(loadConfig({}, { LAYA_VIEWPORT_PRIORITY: "false" }).viewportPriority).toBe(false);
    expect(loadConfig({}, { LAYA_VIEWPORT_PRIORITY: "true" }).viewportPriority).toBe(true);
    expect(loadConfig({ viewportPriority: false }, {}).viewportPriority).toBe(false);
  });

  it("(D1) parses LAYA_RECORD_ARTIFACTS as default-false (only 'true' enables)", () => {
    expect(loadConfig({}, {}).recordArtifacts).toBe(false);
    expect(loadConfig({}, { LAYA_RECORD_ARTIFACTS: "true" }).recordArtifacts).toBe(true);
    expect(loadConfig({}, { LAYA_RECORD_ARTIFACTS: "false" }).recordArtifacts).toBe(false);
    expect(loadConfig({}, { LAYA_RECORD_ARTIFACTS: "garbage" }).recordArtifacts).toBe(false);
    expect(loadConfig({ recordArtifacts: true }, {}).recordArtifacts).toBe(true);
  });
});


describe("loadConfig Tier 1-4 knobs (token/latency, robustness, UX)", () => {
  it("defaults the new knobs to safe/off values", () => {
    const c = loadConfig({}, {});
    expect(c.stateTextLimit).toBe(1200);
    expect(c.loopScreenshots).toBe(false);
    expect(c.autoDismiss).toBe(false);
    expect(c.frameDepth).toBe(0);
    expect(c.storageStatePath).toBeUndefined();
    expect(c.downloadDir).toBeUndefined();
    expect(c.overlay.cursorTrail).toBe(6);
  });

  it("parses and clamps LAYA_STATE_TEXT_LIMIT", () => {
    expect(loadConfig({}, { LAYA_STATE_TEXT_LIMIT: "3000" }).stateTextLimit).toBe(3000);
    // Out-of-range values fall back to the default (parseNumber returns undefined).
    expect(loadConfig({}, { LAYA_STATE_TEXT_LIMIT: "10" }).stateTextLimit).toBe(1200);
    expect(loadConfig({}, { LAYA_STATE_TEXT_LIMIT: "999999" }).stateTextLimit).toBe(1200);
  });

  it("parses LAYA_LOOP_SCREENSHOTS / LAYA_AUTO_DISMISS as default-false booleans", () => {
    expect(loadConfig({}, { LAYA_LOOP_SCREENSHOTS: "true" }).loopScreenshots).toBe(true);
    expect(loadConfig({}, { LAYA_LOOP_SCREENSHOTS: "1" }).loopScreenshots).toBe(false);
    expect(loadConfig({}, { LAYA_AUTO_DISMISS: "true" }).autoDismiss).toBe(true);
  });

  it("parses and clamps LAYA_FRAME_DEPTH into [0,5]", () => {
    expect(loadConfig({}, { LAYA_FRAME_DEPTH: "2" }).frameDepth).toBe(2);
    // Out-of-range falls back to the default 0.
    expect(loadConfig({}, { LAYA_FRAME_DEPTH: "9" }).frameDepth).toBe(0);
  });

  it("reads LAYA_STORAGE_STATE / LAYA_DOWNLOAD_DIR, treating empty as unset", () => {
    expect(loadConfig({}, { LAYA_STORAGE_STATE: "/tmp/s.json" }).storageStatePath).toBe(
      "/tmp/s.json",
    );
    expect(loadConfig({}, { LAYA_STORAGE_STATE: "   " }).storageStatePath).toBeUndefined();
    expect(loadConfig({}, { LAYA_DOWNLOAD_DIR: "/tmp/dl" }).downloadDir).toBe("/tmp/dl");
  });

  it("parses and clamps LAYA_BROWSER_OVERLAY_TRAIL into [0,24]", () => {
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_TRAIL: "10" }).overlay.cursorTrail).toBe(10);
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_TRAIL: "0" }).overlay.cursorTrail).toBe(0);
    // Out-of-range falls back to the default 6.
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_TRAIL: "100" }).overlay.cursorTrail).toBe(6);
  });
});
