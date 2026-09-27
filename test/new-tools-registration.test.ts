/**
 * Registration/capability-gating for the new Tier 1/2 tools.
 *
 *  - browser_extract (T1.2) registers under the `vision` capability.
 *  - browser_download_file (T2.4) registers under the `storage` capability.
 */
import { describe, expect, it } from "vitest";
import { assistToolNames } from "../src/tools/index.js";

describe("new tool capability gating", () => {
  it("browser_extract is gated behind the vision capability", () => {
    expect(assistToolNames([])).not.toContain("browser_extract");
    expect(assistToolNames(["vision"])).toContain("browser_extract");
  });

  it("browser_download_file is gated behind the storage capability", () => {
    expect(assistToolNames([])).not.toContain("browser_download_file");
    expect(assistToolNames(["storage"])).toContain("browser_download_file");
  });
});
