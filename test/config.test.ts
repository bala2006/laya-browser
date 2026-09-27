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
    expect(overlay.accent).toBe("#a855f7");
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
      "#a855f7",
    );
    expect(loadConfig({}, { LAYA_BROWSER_OVERLAY_ACCENT: "#xyz" }).overlay.accent).toBe(
      "#a855f7",
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
