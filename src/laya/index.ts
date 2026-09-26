/**
 * Engine factory + the graceful "unavailable" engine.
 *
 * {@link createEngine} chooses a {@link LayaDecisionEngine} from the RESOLVED config so
 * Autopilot can detect absence and degrade. Settings come from the typed config parsed in
 * src/config.ts (the single source of truth); this factory does NOT read process.env for
 * them. The `env` field is a test-only injection point (see {@link CreateEngineConfig}).
 *
 *   - `engine: "stub"`             -> {@link StubEngine} (explicit, tests/dev)
 *   - a `modelDir` is present      -> load the real {@link LayaEngine}
 *   - `download: true`             -> load {@link LayaEngine} (may fetch weights)
 *   - otherwise                    -> {@link UnavailableEngine} (available=false)
 *
 * ONNX is only touched on the real-engine path, and even then only inside `LayaEngine.load`;
 * if loading throws (missing/corrupt bundle, no onnxruntime binary) we fall back to the
 * unavailable engine so the caller degrades to Assist mode rather than crashing.
 */
import type { Decision, LayaDecisionEngine, PageState } from "../types.js";
import { LayaEngine, type LayaEngineOptions } from "./engine.js";
import { StubEngine } from "./stub.js";

/** Which engine to build. `auto` decides from config/env. */
export type EngineKind = "auto" | "stub" | "laya";

/** Configuration for {@link createEngine}. */
export interface CreateEngineConfig extends LayaEngineOptions {
  /** Force a specific engine. Defaults to `auto`. */
  engine?: EngineKind;
  /** Allow the real engine to DOWNLOAD weights when no local modelDir is present. */
  download?: boolean;
  /**
   * Optional TEST-ONLY environment injection for `LAYA_ENGINE` / `LAYA_MODEL_DIR` /
   * `LAYA_CACHE`. Defaults to an EMPTY map: in production these settings are parsed ONCE in
   * src/config.ts and passed inward explicitly (`engine`, `modelDir`, `cacheDir`), so
   * createEngine never reads `process.env` itself. Tests may still inject a fake env map to
   * exercise the same resolution without touching the real environment.
   */
  env?: Record<string, string | undefined>;
}

/**
 * A null engine used when no weights are available. `available` is `false`, and `decide`
 * throws if ever called (the loop checks `available` first and degrades gracefully, so it
 * should not be called). Exists so callers always get a well-typed engine object.
 */
export class UnavailableEngine implements LayaDecisionEngine {
  readonly available = false;

  async decide(_state: PageState): Promise<Decision> {
    throw new Error(
      "Laya engine is unavailable (no model weights loaded); use Assist-mode tools instead.",
    );
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

/**
 * Build the configured decision engine.
 *
 * Never throws for a missing/failed real engine: on failure it resolves to an
 * {@link UnavailableEngine} so Autopilot degrades to Assist mode.
 */
export async function createEngine(
  config: CreateEngineConfig = {},
): Promise<LayaDecisionEngine> {
  // `env` is a TEST-ONLY injection point and defaults to EMPTY, NOT process.env: settings
  // env vars are parsed once in src/config.ts and handed inward via config.engine /
  // config.modelDir / config.cacheDir, so this factory never reads process.env itself.
  const env = config.env ?? {};
  const kind: EngineKind =
    config.engine ?? (env.LAYA_ENGINE === "stub" ? "stub" : "auto");

  if (kind === "stub" || env.LAYA_ENGINE === "stub") {
    return new StubEngine();
  }

  const modelDir = config.modelDir ?? env.LAYA_MODEL_DIR;
  const cacheDir = config.cacheDir ?? env.LAYA_CACHE;

  const canLoadReal = kind === "laya" || modelDir !== undefined || config.download === true;
  if (!canLoadReal) {
    return new UnavailableEngine();
  }

  try {
    return await LayaEngine.load({
      ...config,
      ...(modelDir !== undefined ? { modelDir } : {}),
      ...(cacheDir !== undefined ? { cacheDir } : {}),
    });
  } catch {
    // Missing bundle, no onnxruntime binary, etc. Degrade rather than crash.
    return new UnavailableEngine();
  }
}

export { LayaEngine } from "./engine.js";
export { StubEngine } from "./stub.js";
