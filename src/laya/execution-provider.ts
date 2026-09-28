/**
 * Execution-provider (EP) auto-selection with probe-verified fallback.
 *
 * This module is the ONE decision path that turns a platform (or an explicit override)
 * into the onnxruntime `executionProviders` list that {@link ./engine.LayaEngine.load}
 * hands to `Laya.load`. It is deliberately (almost) PURE and free of any onnxruntime or
 * Playwright imports: {@link candidateExecutionProviders} is a pure function of
 * platform/arch/override, and {@link resolveEngine} only orchestrates an INJECTED load
 * callback. That keeps ONNX confined to src/laya/engine.ts (Boundary Discipline).
 *
 * Why probe by loading: `Laya.load` throws when a listed EP cannot initialize the model
 * (for example "DirectML unsupported by this model"), because
 * `ort.InferenceSession.create` throws for a broken listed provider. So attempting a real
 * load with a candidate's providers IS the probe: success keeps that candidate, a throw
 * falls through to the next one. The model is therefore loaded exactly ONCE (the winning
 * candidate's load), never probed-then-reloaded.
 *
 * onnxruntime-node@1.30.0 prebuilt EP support (used for platform gating):
 *   - CPU: every platform (always the final candidate so resolution can never fail).
 *   - DirectML: Windows x64 / arm64.
 *   - CUDA (v12): Linux x64.
 *   - WebGPU: experimental; not offered from auto-selection here (only via override).
 *
 * The actual GPU speedup is UNVERIFIED in this sandbox (no NVIDIA GPU) and is to be measured
 * on the user's RTX 4050; see docs/PLAN.md / FEAT-006. Nothing here fabricates a number.
 */

/** The human label used for the startup log line. */
export type EpName = "cuda" | "directml" | "webgpu" | "cpu" | "custom";

/**
 * One execution-provider candidate.
 *
 * `name` is the human label for the log line; `providers` is the onnxruntime
 * `executionProviders` list passed to `Laya.load`. Each GPU candidate includes a trailing
 * `cpu` entry so onnxruntime itself can also fall back per-node, but candidate-level
 * fall-through (a whole failed load) is handled by {@link resolveEngine}.
 */
export interface EpCandidate {
  /** Human label for the engaged provider, used in the single startup log line. */
  readonly name: EpName;
  /** The onnxruntime executionProviders list to pass to `Laya.load`. */
  readonly providers: readonly string[];
}

/** The always-available final candidate. */
const CPU_CANDIDATE: EpCandidate = { name: "cpu", providers: ["cpu"] };

/**
 * Build the ordered execution-provider candidate list (PURE).
 *
 * When `override` is provided (from LAYA_EXECUTION_PROVIDERS or an explicit config), return
 * EXACTLY ONE candidate wrapping it verbatim: auto-selection is skipped and the user's
 * choice is honored as-is. The label is inferred from the first provider for logging, but
 * the provider list itself is passed through unchanged.
 *
 * Otherwise return the platform-appropriate preference order, GPU-first, and ALWAYS ending
 * with a plain CPU candidate so resolution can never fail. GPU candidates are gated by the
 * onnxruntime-node@1.30.0 prebuilt support matrix; a candidate the platform cannot host is
 * never offered.
 */
export function candidateExecutionProviders(
  platform: NodeJS.Platform,
  arch: string,
  override?: readonly string[],
): EpCandidate[] {
  if (override !== undefined && override.length > 0) {
    return [{ name: labelForProvider(override[0]), providers: [...override] }];
  }

  const candidates: EpCandidate[] = [];

  if (platform === "linux" && arch === "x64") {
    // CUDA v12 prebuilt is available for linux x64. Include a CPU fallback entry so
    // onnxruntime can fall back per-node if a specific op is unsupported.
    candidates.push({ name: "cuda", providers: ["cuda", "cpu"] });
  } else if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    // DirectML prebuilt is available for Windows x64 / arm64.
    candidates.push({ name: "directml", providers: ["dml", "cpu"] });
  }

  // Always end with a plain CPU candidate: it is supported everywhere, so resolution can
  // never run out of candidates.
  candidates.push(CPU_CANDIDATE);
  return candidates;
}

/** Map an onnxruntime provider string to its human label for the log line. */
function labelForProvider(provider: string): EpName {
  switch (provider.toLowerCase()) {
    case "cuda":
      return "cuda";
    case "dml":
    case "directml":
      return "directml";
    case "webgpu":
      return "webgpu";
    case "cpu":
      return "cpu";
    default:
      return "custom";
  }
}

/** The successful outcome of {@link resolveEngine}: the loaded handle + the chosen candidate. */
export interface ResolvedEngine<T> {
  /** The engine/handle returned by the winning `load` call. */
  readonly engine: T;
  /** The candidate whose load succeeded (its `name` flows to the startup log line). */
  readonly chosen: EpCandidate;
}

/**
 * Try each candidate in order and keep the FIRST that loads without throwing.
 *
 * `load` is the injected boundary that actually creates the session (in production, a thin
 * wrapper over {@link ./engine.LayaEngine.load}); calling it with a candidate's providers IS
 * the probe. On a throw we catch it and continue to the next candidate. Because the winning
 * candidate's `load` returns the real handle, the model is loaded exactly ONCE.
 *
 * If EVERY candidate throws, the last error is rethrown so the caller
 * ({@link ./index.createEngine}) degrades to UnavailableEngine rather than crashing. A CPU
 * candidate is normally last, so in practice this only happens when even CPU cannot load
 * (missing weights / no onnxruntime binary), which is exactly when degradation is correct.
 */
export async function resolveEngine<T>(
  candidates: readonly EpCandidate[],
  load: (providers: readonly string[]) => Promise<T>,
  log: (line: string) => void = () => {},
): Promise<ResolvedEngine<T>> {
  let lastError: unknown = new Error(
    "resolveEngine called with no execution-provider candidates",
  );

  for (const candidate of candidates) {
    try {
      const engine = await load(candidate.providers);
      log(
        `[laya-browser-mcp] Autopilot engine loaded (execution provider: ${candidate.name}).`,
      );
      return { engine, chosen: candidate };
    } catch (error) {
      lastError = error;
      // Fall through to the next candidate (for example a listed-but-broken GPU EP).
    }
  }

  throw lastError;
}
