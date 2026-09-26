import { describe, it, expect } from "vitest";
import { loadConfig, type Capability } from "../src/config.js";

describe("loadConfig capability and engine parsing", () => {
  it("defaults to core-only capabilities and chromium engine", () => {
    const config = loadConfig({}, {});
    expect(config.capabilities).toEqual([]);
    expect(config.browserEngine).toBe("chromium");
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
});
