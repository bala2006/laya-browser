import { describe, it, expect, vi } from "vitest";
import {
  candidateExecutionProviders,
  resolveEngine,
  type EpCandidate,
} from "../src/laya/execution-provider.js";

describe("candidateExecutionProviders (pure ordering + gating)", () => {
  it("always ends the list with a plain CPU candidate on every platform", () => {
    const platforms: Array<[NodeJS.Platform, string]> = [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
      ["win32", "arm64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["freebsd", "x64"],
    ];
    for (const [platform, arch] of platforms) {
      const list = candidateExecutionProviders(platform, arch);
      expect(list.length).toBeGreaterThanOrEqual(1);
      const last = list[list.length - 1];
      expect(last.name).toBe("cpu");
      expect(last.providers).toEqual(["cpu"]);
    }
  });

  it("prefers CUDA first on linux x64, with a CPU fallback entry then a CPU candidate", () => {
    const list = candidateExecutionProviders("linux", "x64");
    expect(list.map((c) => c.name)).toEqual(["cuda", "cpu"]);
    expect(list[0].providers).toEqual(["cuda", "cpu"]);
  });

  it("prefers DirectML first on win32 x64 and arm64", () => {
    for (const arch of ["x64", "arm64"]) {
      const list = candidateExecutionProviders("win32", arch);
      expect(list.map((c) => c.name)).toEqual(["directml", "cpu"]);
      expect(list[0].providers).toEqual(["dml", "cpu"]);
    }
  });

  it("does NOT offer a GPU candidate the platform cannot host", () => {
    // linux arm64 has no CUDA prebuilt; darwin has neither CUDA nor DirectML prebuilt.
    expect(candidateExecutionProviders("linux", "arm64").map((c) => c.name)).toEqual([
      "cpu",
    ]);
    expect(candidateExecutionProviders("darwin", "arm64").map((c) => c.name)).toEqual([
      "cpu",
    ]);
    // win32 on an unsupported arch (e.g. ia32) gets CPU only.
    expect(candidateExecutionProviders("win32", "ia32").map((c) => c.name)).toEqual([
      "cpu",
    ]);
  });

  it("returns EXACTLY the override candidate (auto-selection skipped) and labels it", () => {
    const list = candidateExecutionProviders("linux", "x64", ["cuda", "cpu"]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("cuda");
    expect(list[0].providers).toEqual(["cuda", "cpu"]);

    // The override is honored verbatim even on a platform whose auto path would differ.
    const dml = candidateExecutionProviders("darwin", "arm64", ["dml"]);
    expect(dml).toHaveLength(1);
    expect(dml[0].name).toBe("directml");
    expect(dml[0].providers).toEqual(["dml"]);

    // An unknown provider string is passed through verbatim with a "custom" label.
    const custom = candidateExecutionProviders("linux", "x64", ["tensorrt"]);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("custom");
    expect(custom[0].providers).toEqual(["tensorrt"]);
  });
});

describe("resolveEngine (probe-verified fall-through with a fake factory)", () => {
  const cuda: EpCandidate = { name: "cuda", providers: ["cuda", "cpu"] };
  const cpu: EpCandidate = { name: "cpu", providers: ["cpu"] };

  it("returns the FIRST candidate whose fake load resolves, loading exactly ONCE", async () => {
    const load = vi.fn(async (providers: readonly string[]) => ({ providers }));
    const { engine, chosen } = await resolveEngine([cuda, cpu], load);
    expect(chosen.name).toBe("cuda");
    expect(engine).toEqual({ providers: ["cuda", "cpu"] });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(["cuda", "cpu"]);
  });

  it("falls through when the first candidate REJECTS and returns the next working one", async () => {
    // Simulate "DirectML unsupported by this model": the first load rejects, the second wins.
    const load = vi.fn(async (providers: readonly string[]) => {
      if (providers[0] === "cuda") {
        throw new Error("cuda unsupported by this model");
      }
      return { providers };
    });
    const { engine, chosen } = await resolveEngine([cuda, cpu], load);
    expect(chosen.name).toBe("cpu");
    expect(engine).toEqual({ providers: ["cpu"] });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects when EVERY candidate fails (so createEngine can degrade)", async () => {
    const load = vi.fn(async () => {
      throw new Error("no onnxruntime binary");
    });
    await expect(resolveEngine([cuda, cpu], load)).rejects.toThrow(
      "no onnxruntime binary",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("logs a single startup line naming the ENGAGED provider (the fallback winner)", async () => {
    const lines: string[] = [];
    const load = vi.fn(async (providers: readonly string[]) => {
      if (providers[0] === "cuda") throw new Error("cuda broken");
      return { providers };
    });
    await resolveEngine([cuda, cpu], load, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "[laya-browser-mcp] Autopilot engine loaded (execution provider: cpu).",
    );
  });

  it("rejects with a clear error when given no candidates", async () => {
    const load = vi.fn();
    await expect(resolveEngine([], load)).rejects.toThrow(
      /no execution-provider candidates/,
    );
    expect(load).not.toHaveBeenCalled();
  });
});
