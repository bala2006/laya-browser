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
 *   LAYA_BROWSER_HEADLESS=true         run headless (default: headed; a headed launch on a
 *                                      machine with no display server auto-falls-back to headless)
 *   LAYA_BROWSER_CHANNEL=chrome        Chromium channel
 *   LAYA_BROWSER_VIEWPORT=1440x900     viewport WIDTHxHEIGHT
 *   LAYA_BROWSER_OVERLAY=auto|on|off   agentLens visual overlay (default: auto = on when headed)
 *   LAYA_BROWSER_OVERLAY_ACCENT=#3b82f6   overlay brand accent (hex; default #3b82f6)
 *   LAYA_BROWSER_OVERLAY_TYPING=false  opt-in per-character typing effect
 *   LAYA_BROWSER_OVERLAY_COUNTDOWN=false  opt-in WAIT countdown display
 *   LAYA_BROWSER_OVERLAY_DEBUG=false   outline "what the agent sees" elements
 *   LAYA_BROWSER_OVERLAY_LOG=true      collapsible activity-log panel
 *   LAYA_BROWSER_OVERLAY_TRAIL=6       (T3.4) synthetic-cursor breadcrumb trail length (clamped 0..24; 0 = off)
 *   LAYA_AUTOPILOT_WAIT_MS=300         Autopilot WAIT-operation duration in ms (clamped 0..5000)
 *   LAYA_MODEL_DIR=/path/to/bundle     local ONNX bundle (skips download)
 *   LAYA_REPO / LAYA_SUBFOLDER / LAYA_REVISION   Hugging Face source coordinates
 *   LAYA_CACHE=/path                   download cache root
 *   LAYA_EXECUTION_PROVIDERS=cpu,cuda  onnxruntime execution providers (comma-separated)
 *   LAYA_ENGINE=stub|auto              force the stub engine or auto-detect (default: auto)
 *   LAYA_CONFIDENCE_THRESHOLD=0.85     escalate below this operation/target confidence
 *   LAYA_MAX_STEPS=15                  Autopilot step budget
 *   LAYA_ALLOWED_DOMAINS=a.com,b.org   domain allow-list (empty = allow all)
 *   LAYA_DESTRUCTIVE_GUARD=false       disable the destructive-form auto-submit guard
 *   LAYA_CAPS=network,storage          enabled tool capability groups (empty = core-only)
 *   LAYA_BROWSER=chromium|firefox|webkit   browser engine (default: chromium)
 *   LAYA_ALLOW_UNSAFE_CODE=true        enable browser_run_code_unsafe (default: false)
 *   LAYA_SELF_HEAL_RETRIES=1           Autopilot self-healing retry attempts (clamped 0..3)
 *   LAYA_SETTLE_PROBE=true             probe for DOM/navigation settle after an action (default: true)
 *   LAYA_LOOP_DETECTION=true           detect repeated no-progress steps and stop (default: true)
 *   LAYA_LOOP_WINDOW=3                 how many recent steps the loop detector compares (clamped 2..6)
 *   LAYA_REDACT_SECRETS=true           redact secret values/patterns in logs + step details (default: true)
 *   LAYA_ASSIST_DESTRUCTIVE_GUARD=false   apply the destructive guard to Assist click/type (default: false)
 *   LAYA_SNAPSHOT_BACKEND=domwalk|aria    snapshot capture backend (default: domwalk)
 *   LAYA_VIEWPORT_PRIORITY=true        order/cap controls by viewport visibility first (default: true)
 *   LAYA_RECORD_ARTIFACTS=false        record per-step replay artifacts for laya_export_run (default: false)
 *   LAYA_STATE_TEXT_LIMIT=1200         (T1.3) max chars of visible text carried into Autopilot state/escalation prompt (clamped 200..8000)
 *   LAYA_LOOP_SCREENSHOTS=false        (T1.4) capture a per-step screenshot in the Autopilot loop (default: false; artifacts recording is separate)
 *   LAYA_STORAGE_STATE=/path/state.json (T2.1) auto-load storage state on launch (if it exists) and auto-save on close()
 *   LAYA_AUTO_DISMISS=false            (T2.2) auto-dismiss cookie/consent/blocking-modal overlays during Autopilot (default: false)
 *   LAYA_FRAME_DEPTH=0                 (T2.3) how many levels of same-origin iframe / open shadow root the DOM walk descends (clamped 0..5; 0 = top document only)
 *   LAYA_DOWNLOAD_DIR=/path            (T2.4) default directory browser_download_file saves into when no explicit path is given
 *   LAYA_CLIENT_REQUEST_TIMEOUT_MS=20000  (R1) budget for a client-bound MCP request (sampling escalation /
 *                                      elicitation confirm) before degrading (clamped 1000..30000)
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

/**
 * Which backend {@link src/snapshot.ts capture()} uses to enumerate page controls:
 * `domwalk` is the existing in-page DOM walk; `aria` uses the accessibility tree.
 */
export type SnapshotBackend = "domwalk" | "aria";

/** All valid snapshot backends, used to validate LAYA_SNAPSHOT_BACKEND. */
export const SNAPSHOT_BACKENDS: readonly SnapshotBackend[] = ["domwalk", "aria"] as const;

/** How the visual overlay is switched: `auto` follows headed/headless, `on`/`off` force it. */
export type OverlayMode = "auto" | "on" | "off";

/** All valid overlay modes, used to validate LAYA_BROWSER_OVERLAY. */
export const OVERLAY_MODES: readonly OverlayMode[] = ["auto", "on", "off"] as const;

/** The default overlay brand accent (agentLens blue, Tailwind blue-500). */
export const DEFAULT_OVERLAY_ACCENT = "#3b82f6";

/** (T3.4) Default synthetic-cursor trail length (breadcrumb dots), and its inclusive bounds. */
export const DEFAULT_OVERLAY_TRAIL = 6;
export const OVERLAY_TRAIL_MIN = 0;
export const OVERLAY_TRAIL_MAX = 24;

/**
 * The resolved visual-overlay configuration (agentLens HUD). The overlay is an on-page,
 * pointer-events:none set of nodes injected via `context.addInitScript`, so it never
 * intercepts clicks or alters page behaviour. `enabled` is the resolved on/off decision;
 * `mode` records how it was chosen (so a downstream `auto` can re-derive from the effective
 * headless mode after a headed launch falls back to headless).
 */
export interface OverlayConfig {
  /** Whether the overlay is on, resolved from {@link mode} and the headless setting. */
  enabled: boolean;
  /** How the overlay switch was requested: `auto` (on when headed) / `on` / `off`. */
  mode: OverlayMode;
  /** Brand accent as a validated `#rgb`/`#rrggbb` hex string. */
  accent: string;
  /** Whether the per-character typing effect is shown (opt-in). */
  typingEffect: boolean;
  /** Whether a WAIT countdown is displayed (opt-in). */
  waitCountdown: boolean;
  /** Whether "what the agent sees" element outlines are drawn (opt-in debug). */
  debugSeeElements: boolean;
  /** Whether the collapsible activity-log panel is shown. */
  activityLog: boolean;
  /**
   * (T3.4) How many fading breadcrumb dots the synthetic cursor leaves between successive
   * positions, so multi-field actions read as continuous motion. `0` disables the trail.
   * Clamped to `[0, 24]`. Defaults to {@link DEFAULT_OVERLAY_TRAIL}.
   */
  cursorTrail: number;
}

/** The fully-parsed, typed configuration handed inward to the rest of the server. */
export interface LayaBrowserConfig {
  /** Launch the browser headless or headed (default: headed). */
  headless: boolean;
  /** Optional Chromium channel (e.g. `"chrome"`). */
  channel?: string;
  /** Page viewport. */
  viewport: Viewport;

  /** The resolved visual-overlay (agentLens HUD) configuration. */
  overlay: OverlayConfig;
  /** Milliseconds the Autopilot WAIT operation pauses for. Clamped to `[0, 5000]`. */
  autopilotWaitMs: number;

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
  /**
   * Whether the `browser_run_code_unsafe` tool is permitted to execute raw Playwright
   * snippets. Off by default: when false the tool is still listed but refuses with a clear
   * message, since running arbitrary code against the page is a deliberate, risky opt-in.
   */
  allowUnsafeCode: boolean;

  /**
   * (A1) How many times the Autopilot re-attempts a failed action against a freshly
   * re-captured page (self-healing against stale refs / transient failures) before giving
   * up on that step. Clamped to `[0, 3]`; `0` disables self-healing retries.
   */
  selfHealRetries: number;
  /**
   * (A2) Whether the Autopilot probes for the page to settle (DOM quiescence / navigation
   * completion) after an action before capturing the next snapshot. Default on.
   */
  settleProbe: boolean;
  /**
   * (A3) Whether loop detection is active: the Autopilot compares recent steps and stops
   * with a `stuck` outcome when it detects no progress. Default on.
   */
  loopDetection: boolean;
  /**
   * (A3) How many of the most recent steps the loop detector compares when deciding the
   * run is stuck. Clamped to `[2, 6]`.
   */
  loopWindow: number;
  /**
   * (B1) Whether secret values and common secret patterns are masked in logs and Autopilot
   * step details. Default on. Masks only the DISPLAYED/LOGGED representation, never the
   * value actually typed into the page.
   */
  redactSecrets: boolean;
  /**
   * (B3) Whether the destructive-action guard also applies to Assist-mode `click`/`type`
   * tools (opt-in), not just the Autopilot auto-submit path. Default off.
   */
  assistDestructiveGuard: boolean;
  /**
   * (C1) Which backend {@link src/snapshot.ts capture()} uses to enumerate controls:
   * `domwalk` (default) or `aria` (accessibility tree).
   */
  snapshotBackend: SnapshotBackend;
  /**
   * (C3) Whether controls are ordered and capped by viewport visibility first (in-view
   * controls prioritised) when building the page state. Default on.
   */
  viewportPriority: boolean;
  /**
   * (D1) Whether the Autopilot records per-step observability artifacts (screenshot +
   * snapshot + decision + confidence + timing) so the `laya_export_run` tool can write a
   * replay. Default OFF so normal runs are not slowed by the extra screenshot capture; this
   * is an explicit operator opt-in via `LAYA_RECORD_ARTIFACTS`. The shared holder can be
   * present without this being on; recording is gated on THIS flag, not on holder presence.
   */
  recordArtifacts: boolean;
  /**
   * (T1.3) Maximum characters of the page's visible text carried into the Autopilot page
   * state (and thus into the escalation prompt). Bounding this explicitly keeps the token
   * cost of a big page predictable; the model is pointed at the `extract` tool for large
   * reads instead of receiving the whole page. Clamped to `[200, 8000]`. Defaults to
   * {@link DEFAULT_STATE_TEXT_LIMIT} (1200), preserving the previous state-builder default.
   */
  stateTextLimit: number;
  /**
   * (T1.4) Whether the Autopilot loop captures a per-step PNG screenshot. Default OFF: the
   * loop is a text-first, no-per-step-screenshot pipeline (vision is opt-in) so it stays
   * fast and cheap. This is INDEPENDENT of {@link recordArtifacts}: turning on artifact
   * recording implies capturing step screenshots for the replay, but this flag lets an
   * operator force step screenshots on (or document the default off) on its own.
   */
  loopScreenshots: boolean;
  /**
   * (T2.1) Path to a Playwright storage-state JSON file for automatic session persistence.
   * When set AND the file exists, it is loaded on launch (cookies + per-origin localStorage
   * restored) so an authenticated session resumes; the same path is auto-saved on
   * {@link close}. Unset (undefined) is a complete no-op — existing behaviour is unchanged.
   */
  storageStatePath?: string;
  /**
   * (T2.2) Whether the Autopilot loop runs a bounded, conservative heuristic to auto-dismiss
   * cookie/consent banners and blocking modal overlays before deciding each step. Default
   * OFF. Never clicks destructive controls; only accept/close/dismiss affordances on
   * detected consent/modal containers.
   */
  autoDismiss: boolean;
  /**
   * (T2.3) How many levels of SAME-ORIGIN iframe and OPEN shadow root the in-page DOM walk
   * descends into to discover controls. `0` (default) walks only the top document, exactly
   * as before. Clamped to `[0, 5]`. Cross-origin iframes are skipped cleanly (never crash).
   */
  frameDepth: number;
  /**
   * (T2.4) Default directory the `browser_download_file` tool saves a captured download into
   * when the caller gives no explicit path. Unset means the caller must supply a path.
   */
  downloadDir?: string;
  /**
   * (R1) How long to wait on a CLIENT-BOUND MCP request before degrading. Two requests the
   * server sends to its own client are unbounded by the protocol: the `sampling/createMessage`
   * escalation and the `elicitation/create` confirmation. A slow client LLM (or a human who
   * never answers) would otherwise block the whole `laya_run_goal` call past the client's
   * request timeout, which the SDK tops out at 60s and reports as `-32001` RequestTimeout.
   * Bounding each request well inside that keeps a stalled client a graceful BLOCKED instead
   * of a lost run. Clamped to `[1000, 30000]`. Defaults to
   * {@link DEFAULT_CLIENT_REQUEST_TIMEOUT_MS}.
   */
  clientRequestTimeoutMs: number;
}

/** Overrides supplied programmatically (constructor options / tool arguments). */
export interface ConfigOverrides {
  headless?: boolean;
  channel?: string;
  viewport?: Viewport;
  overlay?: Partial<OverlayConfig>;
  autopilotWaitMs?: number;
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
  allowUnsafeCode?: boolean;
  selfHealRetries?: number;
  settleProbe?: boolean;
  loopDetection?: boolean;
  loopWindow?: number;
  redactSecrets?: boolean;
  assistDestructiveGuard?: boolean;
  snapshotBackend?: SnapshotBackend;
  viewportPriority?: boolean;
  recordArtifacts?: boolean;
  stateTextLimit?: number;
  loopScreenshots?: boolean;
  storageStatePath?: string;
  autoDismiss?: boolean;
  frameDepth?: number;
  downloadDir?: string;
  clientRequestTimeoutMs?: number;
}

/**
 * Built-in defaults, used when neither an override nor an env var is present.
 *
 * (T2) The escalation gate is 0.85: a Laya step executes locally at operation AND target
 * confidence >= 0.85, and escalates to the client LLM only when EITHER head falls below it
 * (the OR semantics live in the loop). Rule-seeded steps carry 0.97 and never escalate.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
export const DEFAULT_MAX_STEPS = 15;
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };
/** Default Autopilot WAIT duration (ms), lower than the loop's legacy 500. */
export const DEFAULT_AUTOPILOT_WAIT_MS = 300;
/** Bounds for the Autopilot WAIT duration. */
export const AUTOPILOT_WAIT_MS_MIN = 0;
export const AUTOPILOT_WAIT_MS_MAX = 5000;

/** (A1) Default self-healing retry attempts, and its inclusive bounds. */
export const DEFAULT_SELF_HEAL_RETRIES = 1;
export const SELF_HEAL_RETRIES_MIN = 0;
export const SELF_HEAL_RETRIES_MAX = 3;

/** (A3) Default loop-detection comparison window, and its inclusive bounds. */
export const DEFAULT_LOOP_WINDOW = 3;
export const LOOP_WINDOW_MIN = 2;
export const LOOP_WINDOW_MAX = 6;

/** (C1) Default snapshot capture backend. */
export const DEFAULT_SNAPSHOT_BACKEND: SnapshotBackend = "domwalk";

/** (T1.3) Default visible-text budget carried into Autopilot state, and its inclusive bounds. */
export const DEFAULT_STATE_TEXT_LIMIT = 1200;
export const STATE_TEXT_LIMIT_MIN = 200;
export const STATE_TEXT_LIMIT_MAX = 8000;

/** (T2.3) Default same-origin iframe / open-shadow-root descent depth, and its inclusive bounds. */
export const DEFAULT_FRAME_DEPTH = 0;
export const FRAME_DEPTH_MIN = 0;
export const FRAME_DEPTH_MAX = 5;

/**
 * (R1) Default budget for a client-bound MCP request (sampling escalation / elicitation
 * confirmation), and its inclusive bounds. Comfortably inside the SDK's 60s client request
 * timeout, so a stalled client degrades instead of timing the whole tool call out.
 */
export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 20000;
export const CLIENT_REQUEST_TIMEOUT_MS_MIN = 1000;
export const CLIENT_REQUEST_TIMEOUT_MS_MAX = 30000;

/** Parse a boolean env var: only the literal string `"false"` disables a default-true flag. */
function envBoolDefaultTrue(value: string | undefined): boolean {
  return value !== "false";
}

/** Parse a boolean env var: only the literal string `"true"` enables a default-false flag. */
function envBoolDefaultFalse(value: string | undefined): boolean {
  return value === "true";
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

/** Parse an overlay mode (`auto`/`on`/`off`); anything else falls back to `auto`. */
function parseOverlayMode(value: string | undefined): OverlayMode {
  const v = value?.trim().toLowerCase();
  return (OVERLAY_MODES as readonly string[]).includes(v ?? "")
    ? (v as OverlayMode)
    : "auto";
}

/** Validate a `#rgb`/`#rrggbb` hex color; return the default accent when malformed. */
function parseHexColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : fallback;
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
  // Headed by default: only the literal string "true" runs headless. A headed launch on a
  // machine with no display server auto-falls-back to headless in BrowserSession.launch().
  const headless =
    overrides.headless ?? envBoolDefaultFalse(env.LAYA_BROWSER_HEADLESS);

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

  const allowUnsafeCode =
    overrides.allowUnsafeCode ?? envBoolDefaultFalse(env.LAYA_ALLOW_UNSAFE_CODE);

  const selfHealRetries = clamp(
    Math.trunc(
      overrides.selfHealRetries ??
        parseNumber(env.LAYA_SELF_HEAL_RETRIES, {
          min: SELF_HEAL_RETRIES_MIN,
          max: SELF_HEAL_RETRIES_MAX,
        }) ??
        DEFAULT_SELF_HEAL_RETRIES,
    ),
    SELF_HEAL_RETRIES_MIN,
    SELF_HEAL_RETRIES_MAX,
  );

  const settleProbe =
    overrides.settleProbe ?? envBoolDefaultTrue(env.LAYA_SETTLE_PROBE);

  const loopDetection =
    overrides.loopDetection ?? envBoolDefaultTrue(env.LAYA_LOOP_DETECTION);

  const loopWindow = clamp(
    Math.trunc(
      overrides.loopWindow ??
        parseNumber(env.LAYA_LOOP_WINDOW, {
          min: LOOP_WINDOW_MIN,
          max: LOOP_WINDOW_MAX,
        }) ??
        DEFAULT_LOOP_WINDOW,
    ),
    LOOP_WINDOW_MIN,
    LOOP_WINDOW_MAX,
  );

  const redactSecrets =
    overrides.redactSecrets ?? envBoolDefaultTrue(env.LAYA_REDACT_SECRETS);

  const assistDestructiveGuard =
    overrides.assistDestructiveGuard ??
    envBoolDefaultFalse(env.LAYA_ASSIST_DESTRUCTIVE_GUARD);

  const snapshotBackendEnv = env.LAYA_SNAPSHOT_BACKEND?.trim().toLowerCase();
  const snapshotBackend: SnapshotBackend =
    overrides.snapshotBackend ??
    ((SNAPSHOT_BACKENDS as readonly string[]).includes(snapshotBackendEnv ?? "")
      ? (snapshotBackendEnv as SnapshotBackend)
      : DEFAULT_SNAPSHOT_BACKEND);

  const viewportPriority =
    overrides.viewportPriority ?? envBoolDefaultTrue(env.LAYA_VIEWPORT_PRIORITY);

  // (D1) Per-step replay artifact recording is an explicit opt-in (default OFF): only the
  // literal string "true" turns it on. The shared holder being present does NOT enable it.
  const recordArtifacts =
    overrides.recordArtifacts ?? envBoolDefaultFalse(env.LAYA_RECORD_ARTIFACTS);

  // (T1.3) Explicit, bounded visible-text budget for the Autopilot state / escalation prompt.
  const stateTextLimit = clamp(
    Math.trunc(
      overrides.stateTextLimit ??
        parseNumber(env.LAYA_STATE_TEXT_LIMIT, {
          min: STATE_TEXT_LIMIT_MIN,
          max: STATE_TEXT_LIMIT_MAX,
        }) ??
        DEFAULT_STATE_TEXT_LIMIT,
    ),
    STATE_TEXT_LIMIT_MIN,
    STATE_TEXT_LIMIT_MAX,
  );

  // (T1.4) Per-step loop screenshots are off by default (text-first, screenshots opt-in).
  const loopScreenshots =
    overrides.loopScreenshots ?? envBoolDefaultFalse(env.LAYA_LOOP_SCREENSHOTS);

  // (T2.1) Auto storage-state path. Trimmed; empty string is treated as unset.
  const storageStatePathRaw = overrides.storageStatePath ?? env.LAYA_STORAGE_STATE;
  const storageStatePath =
    storageStatePathRaw && storageStatePathRaw.trim() !== ""
      ? storageStatePathRaw.trim()
      : undefined;

  // (T2.2) Auto-dismiss cookie/consent/modal overlays. Off by default (conservative).
  const autoDismiss = overrides.autoDismiss ?? envBoolDefaultFalse(env.LAYA_AUTO_DISMISS);

  // (T2.3) Same-origin iframe / open shadow-root descent depth (0 = top document only).
  const frameDepth = clamp(
    Math.trunc(
      overrides.frameDepth ??
        parseNumber(env.LAYA_FRAME_DEPTH, {
          min: FRAME_DEPTH_MIN,
          max: FRAME_DEPTH_MAX,
        }) ??
        DEFAULT_FRAME_DEPTH,
    ),
    FRAME_DEPTH_MIN,
    FRAME_DEPTH_MAX,
  );

  // (T2.4) Default directory for browser_download_file. Trimmed; empty string = unset.
  const downloadDirRaw = overrides.downloadDir ?? env.LAYA_DOWNLOAD_DIR;
  const downloadDir =
    downloadDirRaw && downloadDirRaw.trim() !== "" ? downloadDirRaw.trim() : undefined;

  // (R1) Bound every client-bound MCP request (sampling escalation / elicitation confirm) so
  // a stalled client cannot hang a tool call past the SDK's 60s request timeout (-32001).
  const clientRequestTimeoutMs = clamp(
    Math.trunc(
      overrides.clientRequestTimeoutMs ??
        parseNumber(env.LAYA_CLIENT_REQUEST_TIMEOUT_MS, {
          min: CLIENT_REQUEST_TIMEOUT_MS_MIN,
          max: CLIENT_REQUEST_TIMEOUT_MS_MAX,
        }) ??
        DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
    ),
    CLIENT_REQUEST_TIMEOUT_MS_MIN,
    CLIENT_REQUEST_TIMEOUT_MS_MAX,
  );

  // Overlay: parse each knob once. `auto` resolves to enabled = !headless (on when headed);
  // `on`/`off` force it regardless. Overrides win per-field over the env-derived values.
  const overlayMode = overrides.overlay?.mode ?? parseOverlayMode(env.LAYA_BROWSER_OVERLAY);
  const overlayEnabled =
    overrides.overlay?.enabled ??
    (overlayMode === "on" ? true : overlayMode === "off" ? false : !headless);
  const overlay: OverlayConfig = {
    enabled: overlayEnabled,
    mode: overlayMode,
    accent:
      overrides.overlay?.accent ??
      parseHexColor(env.LAYA_BROWSER_OVERLAY_ACCENT, DEFAULT_OVERLAY_ACCENT),
    typingEffect:
      overrides.overlay?.typingEffect ??
      envBoolDefaultFalse(env.LAYA_BROWSER_OVERLAY_TYPING),
    waitCountdown:
      overrides.overlay?.waitCountdown ??
      envBoolDefaultFalse(env.LAYA_BROWSER_OVERLAY_COUNTDOWN),
    debugSeeElements:
      overrides.overlay?.debugSeeElements ??
      envBoolDefaultFalse(env.LAYA_BROWSER_OVERLAY_DEBUG),
    activityLog:
      overrides.overlay?.activityLog ??
      envBoolDefaultTrue(env.LAYA_BROWSER_OVERLAY_LOG),
    cursorTrail: clamp(
      Math.trunc(
        overrides.overlay?.cursorTrail ??
          parseNumber(env.LAYA_BROWSER_OVERLAY_TRAIL, {
            min: OVERLAY_TRAIL_MIN,
            max: OVERLAY_TRAIL_MAX,
          }) ??
          DEFAULT_OVERLAY_TRAIL,
      ),
      OVERLAY_TRAIL_MIN,
      OVERLAY_TRAIL_MAX,
    ),
  };

  const autopilotWaitMs = clamp(
    Math.trunc(
      overrides.autopilotWaitMs ??
        parseNumber(env.LAYA_AUTOPILOT_WAIT_MS, {
          min: AUTOPILOT_WAIT_MS_MIN,
          max: AUTOPILOT_WAIT_MS_MAX,
        }) ??
        DEFAULT_AUTOPILOT_WAIT_MS,
    ),
    AUTOPILOT_WAIT_MS_MIN,
    AUTOPILOT_WAIT_MS_MAX,
  );

  const config: LayaBrowserConfig = {
    headless,
    viewport,
    overlay,
    autopilotWaitMs,
    engine,
    confidenceThreshold,
    maxSteps,
    allowedDomains,
    destructiveFormGuard,
    capabilities,
    browserEngine,
    allowUnsafeCode,
    selfHealRetries,
    settleProbe,
    loopDetection,
    loopWindow,
    redactSecrets,
    assistDestructiveGuard,
    snapshotBackend,
    viewportPriority,
    recordArtifacts,
    stateTextLimit,
    loopScreenshots,
    autoDismiss,
    frameDepth,
    clientRequestTimeoutMs,
  };
  if (storageStatePath !== undefined) config.storageStatePath = storageStatePath;
  if (downloadDir !== undefined) config.downloadDir = downloadDir;
  if (channel !== undefined) config.channel = channel;
  if (modelDir !== undefined) config.modelDir = modelDir;
  if (repo !== undefined) config.repo = repo;
  if (subfolder !== undefined) config.subfolder = subfolder;
  if (revision !== undefined) config.revision = revision;
  if (cacheDir !== undefined) config.cacheDir = cacheDir;
  if (executionProviders !== undefined) config.executionProviders = executionProviders;
  return config;
}
