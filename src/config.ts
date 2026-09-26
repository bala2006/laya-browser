/**
 * Centralised configuration for laya-browser-mcp.
 *
 * Boundary Discipline: configuration is parsed ONCE here (from environment variables,
 * tool arguments, and constructor options), producing a plain, fully-typed
 * {@link LayaBrowserConfig} that the rest of the server consumes. No other module reads
 * `process.env` for these settings — they take the typed config inward.
 *
 * The precedence is: explicit overrides (constructor/tool args) > environment variables >
 * built-in defaults. Parsing is pure and side-effect free (it never launches a browser or
 * loads weights), so it can be unit-tested in isolation.
 *
 * Environment variables honoured:
 *   LAYA_BROWSER_HEADLESS=false        run headed (default: headless)
 *   LAYA_BROWSER_CHANNEL=chrome        Chromium channel
 *   LAYA_BROWSER_VIEWPORT=1440x900     viewport WIDTHxHEIGHT
 *   LAYA_MODEL_DIR=/path/to/bundle     local ONNX bundle (skips download)
 *   LAYA_REPO / LAYA_SUBFOLDER / LAYA_REVISION   Hugging Face source coordinates
 *   LAYA_CACHE=/path                   download cache root
 *   LAYA_EXECUTION_PROVIDERS=cpu,cuda  onnxruntime execution providers (comma-separated)
 *   LAYA_ENGINE=stub|auto              force the stub engine or auto-detect (default: auto)
 *   LAYA_CONFIDENCE_THRESHOLD=0.6      escalate below this operation/target confidence
 *   LAYA_MAX_STEPS=15                  Autopilot step budget
 *   LAYA_ALLOWED_DOMAINS=a.com,b.org   domain allow-list (empty = allow all)
 *   LAYA_DESTRUCTIVE_GUARD=false       disable the destructive-form auto-submit guard
 *   LAYA_CAPS=network,storage          enabled tool capability groups (empty = core-only)
 *   LAYA_BROWSER=chromium|firefox|webkit   browser engine (default: chromium)
 */

/** How the Autopilot engine is selected. `auto` decides from the presence of weights. */
export type EngineKind = "auto" | "stub" | "laya";

/**
 * A tool capability group. Tools tagged with a capability are only registered when that
 * capability is enabled (via {@link LayaBrowserConfig.capabilities}); untagged tools are
 * always registered (CORE), mirroring Playwright MCP's default of exposing only its core
 * toolset unless extra capabilities are opted into.
 */
export type Capability =
  | "network"
  | "storage"
  | "testing"
  | "devtools"
  | "pdf"
  | "vision"
  | "config";

/** All valid capability group names, used to validate the LAYA_CAPS list. */
export const CAPABILITIES: readonly Capability[] = [
  "network",
  "storage",
  "testing",
  "devtools",
  "pdf",
  "vision",
  "config",
] as const;

/** The browser engine Playwright drives. */
export type BrowserEngine = "chromium" | "firefox" | "webkit";

/** All valid browser engine names, used to validate LAYA_BROWSER. */
export const BROWSER_ENGINES: readonly BrowserEngine[] = [
  "chromium",
  "firefox",
  "webkit",
] as const;

/** A viewport size in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** The fully-parsed, typed configuration handed inward to the rest of the server. */
export interface LayaBrowserConfig {
  /** Launch the browser headless (default) or headed. */
  headless: boolean;
  /** Optional Chromium channel (e.g. `"chrome"`). */
  channel?: string;
  /** Page viewport. */
  viewport: Viewport;

  /** Local ONNX bundle directory; when set, nothing is downloaded. */
  modelDir?: string;
  /** Hugging Face repo id for the weights. */
  repo?: string;
  /** Subfolder inside the repo (e.g. the web-agent checkpoint). */
  subfolder?: string;
  /** Git revision in the repo. */
  revision?: string;
  /** Local cache root for downloads. */
  cacheDir?: string;
  /** onnxruntime execution providers. */
  executionProviders?: string[];

  /** Which engine to build. */
  engine: EngineKind;
  /**
   * Escalate to the client LLM (MCP sampling) when the model's operation OR target
   * confidence falls below this threshold, in `[0, 1]`.
   */
  confidenceThreshold: number;
  /** Maximum Autopilot decision steps before giving up. */
  maxSteps: number;

  /**
   * Domain allow-list. When non-empty, navigation (Assist `browser_navigate` and every
   * Autopilot navigation/submit) is restricted to these hosts and their subdomains. Empty
   * means "allow all" (no restriction configured).
   */
  allowedDomains: string[];
  /**
   * Whether the destructive-form guard is active. When true, Autopilot refuses to
   * auto-submit forms carrying destructive signals (delete/pay/purchase/etc.).
   */
  destructiveFormGuard: boolean;

  /**
   * Enabled tool capability groups. CORE tools are always registered; a tool tagged with
   * a capability is registered only when that capability is present here. Empty means
   * core-only (the default), mirroring Playwright MCP.
   */
  capabilities: Capability[];
  /** Which browser engine Playwright drives. Defaults to `chromium`. */
  browserEngine: BrowserEngine;
}

/** Overrides supplied programmatically (constructor options / tool arguments). */
export interface ConfigOverrides {
  headless?: boolean;
  channel?: string;
  viewport?: Viewport;
  modelDir?: string;
  repo?: string;
  subfolder?: string;
  revision?: string;
  cacheDir?: string;
  executionProviders?: string[];
  engine?: EngineKind;
  confidenceThreshold?: number;
  maxSteps?: number;
  allowedDomains?: string[];
  destructiveFormGuard?: boolean;
  capabilities?: Capability[];
  browserEngine?: BrowserEngine;
}

/** Built-in defaults, used when neither an override nor an env var is present. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
export const DEFAULT_MAX_STEPS = 15;
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };

/** Parse a boolean env var: only the literal string `"false"` disables a default-true flag. */
function envBoolDefaultTrue(value: string | undefined): boolean {
  return value !== "false";
}

/** Parse `"WIDTHxHEIGHT"` into a {@link Viewport}, or return undefined if malformed. */
function parseViewport(value: string | undefined): Viewport | undefined {
  if (!value) return undefined;
  const m = value.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

/** Parse a comma/space-separated list into trimmed, non-empty, lower-cased entries. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse a finite number in an optional range; return undefined if invalid. */
function parseNumber(
  value: string | undefined,
  { min, max }: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (min !== undefined && n < min) return undefined;
  if (max !== undefined && n > max) return undefined;
  return n;
}

/** Clamp a number into `[min, max]`. */
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse the effective configuration from environment + overrides.
 *
 * Precedence: `overrides` > `env` > defaults. Never throws: malformed values fall back to
 * the default rather than crashing the server at startup.
 */
export function loadConfig(
  overrides: ConfigOverrides = {},
  env: Record<string, string | undefined> = process.env,
): LayaBrowserConfig {
  const headless =
    overrides.headless ?? envBoolDefaultTrue(env.LAYA_BROWSER_HEADLESS);

  const channel = overrides.channel ?? env.LAYA_BROWSER_CHANNEL;

  const viewport =
    overrides.viewport ?? parseViewport(env.LAYA_BROWSER_VIEWPORT) ?? DEFAULT_VIEWPORT;

  const modelDir = overrides.modelDir ?? env.LAYA_MODEL_DIR;
  const repo = overrides.repo ?? env.LAYA_REPO;
  const subfolder = overrides.subfolder ?? env.LAYA_SUBFOLDER;
  const revision = overrides.revision ?? env.LAYA_REVISION;
  const cacheDir = overrides.cacheDir ?? env.LAYA_CACHE;

  const executionProviders =
    overrides.executionProviders ??
    (parseList(env.LAYA_EXECUTION_PROVIDERS).length > 0
      ? parseList(env.LAYA_EXECUTION_PROVIDERS)
      : undefined);

  const engineEnv = env.LAYA_ENGINE?.trim().toLowerCase();
  const engine: EngineKind =
    overrides.engine ??
    (engineEnv === "stub" || engineEnv === "laya" || engineEnv === "auto"
      ? (engineEnv as EngineKind)
      : "auto");

  const confidenceThreshold = clamp(
    overrides.confidenceThreshold ??
      parseNumber(env.LAYA_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }) ??
      DEFAULT_CONFIDENCE_THRESHOLD,
    0,
    1,
  );

  const maxSteps = Math.trunc(
    overrides.maxSteps ??
      parseNumber(env.LAYA_MAX_STEPS, { min: 1 }) ??
      DEFAULT_MAX_STEPS,
  );

  const allowedDomains = (
    overrides.allowedDomains ?? parseList(env.LAYA_ALLOWED_DOMAINS)
  ).map((d) => d.toLowerCase());

  const destructiveFormGuard =
    overrides.destructiveFormGuard ??
    envBoolDefaultTrue(env.LAYA_DESTRUCTIVE_GUARD);

  const capabilities =
    overrides.capabilities ??
    (parseList(env.LAYA_CAPS)
      .map((c) => c.toLowerCase())
      .filter((c): c is Capability =>
        (CAPABILITIES as readonly string[]).includes(c),
      ));

  const browserEngineEnv = env.LAYA_BROWSER?.trim().toLowerCase();
  const browserEngine: BrowserEngine =
    overrides.browserEngine ??
    ((BROWSER_ENGINES as readonly string[]).includes(browserEngineEnv ?? "")
      ? (browserEngineEnv as BrowserEngine)
      : "chromium");

  const config: LayaBrowserConfig = {
    headless,
    viewport,
    engine,
    confidenceThreshold,
    maxSteps,
    allowedDomains,
    destructiveFormGuard,
    capabilities,
    browserEngine,
  };
  if (channel !== undefined) config.channel = channel;
  if (modelDir !== undefined) config.modelDir = modelDir;
  if (repo !== undefined) config.repo = repo;
  if (subfolder !== undefined) config.subfolder = subfolder;
  if (revision !== undefined) config.revision = revision;
  if (cacheDir !== undefined) config.cacheDir = cacheDir;
  if (executionProviders !== undefined) config.executionProviders = executionProviders;
  return config;
}
