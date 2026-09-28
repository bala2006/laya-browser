/**
 * {@link LayaEngine} — the real on-device decision engine wrapping `@receptron/laya`.
 *
 * Follows the AUTHORITATIVE design lesson (laya-ultrafast): Laya answers NARROW questions
 * reliably, not the open "what next?". So {@link LayaEngine.decide} asks TWO narrow typed
 * `choice` questions in a SINGLE `systemOne` pass:
 *
 *   - key `operation`: criteria = the seven operations {CLICK, TYPE_TEXT, SELECT,
 *     SCROLL_DOWN, WAIT, DONE, BLOCKED}
 *   - key `target`: criteria = the numbered controls (each option labelled by
 *     index + ref + role + name)
 *
 * The chosen operation + its max probability become the operation and its confidence; the
 * chosen target option maps back to its control `ref` with the target confidence. The
 * numbered control list is capped upstream by {@link ../state-builder.buildState} so the
 * option set never exceeds Laya's `head_max_len` (systemOne throws otherwise).
 *
 * ONNX/Playwright are guarded at the edges: this module touches `@receptron/laya` only,
 * and only inside {@link LayaEngine.load}/{@link decide}. When weights are absent the
 * factory ({@link ./index.createEngine}) returns an unavailable engine instead.
 */
import { Laya } from "@receptron/laya";
import type {
  Decision,
  LayaDecisionEngine,
  Operation,
  PageState,
  Ref,
  TargetedOperation,
  TargetlessOperation,
} from "../types.js";
import { controlLabel, renderState } from "../state-builder.js";

/** Options for {@link LayaEngine.load}, forwarded to `Laya.load`. */
export interface LayaEngineOptions {
  /** Directory holding the exported ONNX bundle; when set, nothing is downloaded. */
  modelDir?: string;
  /** Hugging Face repo id (default handled by @receptron/laya). */
  repo?: string;
  /** Subfolder inside the repo (e.g. the web-agent checkpoint). */
  subfolder?: string;
  /** Git revision in the repo. */
  revision?: string;
  /** Local cache root for downloads. */
  cacheDir?: string;
  /** onnxruntime execution providers (default: ["cpu"]). */
  executionProviders?: string[];
}

/**
 * The operations offered to the model as the `operation` choice set, in order.
 *
 * Deliberately COMPACT: it is the narrow single-control set the model can pick from turn by
 * turn (CLICK/TYPE_TEXT/SELECT/HOVER/SCROLL_DOWN/WAIT/NAVIGATE_BACK/DONE/BLOCKED). The
 * batch/payload operations added in Part 2 are NOT offered here — FILL_FORM is emitted by the
 * deterministic layer (it needs a resolved field/value list), and PRESS_KEY/SCREENSHOT/VERIFY/
 * NAVIGATE need a payload/marker/url the narrow choice question cannot supply. Keeping this set
 * small keeps the `operation` question within Laya's `head_max_len` budget, and keeping it
 * UNCHANGED keeps the options the checkpoint was trained on.
 */
const OPERATIONS: Operation[] = [
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "HOVER",
  "SCROLL_DOWN",
  "WAIT",
  "NAVIGATE_BACK",
  "DONE",
  "BLOCKED",
];

const TARGETED: ReadonlySet<Operation> = new Set<Operation>([
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "HOVER",
]);

/**
 * Short human descriptions for each operation, used as the `choice` criteria values.
 *
 * Covers the whole {@link Operation} union so the map stays exhaustive even though only the
 * compact {@link OPERATIONS} subset is offered to the model.
 */
const OPERATION_CRITERIA: Record<Operation, string> = {
  CLICK: "Click a button, link, or checkbox to act on it.",
  TYPE_TEXT: "Type text into an input or textarea field.",
  SELECT: "Choose an option in a dropdown/combobox.",
  HOVER: "Hover the pointer over a control to reveal hidden content.",
  SCROLL_DOWN: "Scroll the page down to reveal more content.",
  WAIT: "Wait for the page to update before acting.",
  NAVIGATE_BACK: "Go back to the previous page in history.",
  // (R4) Documented for exhaustiveness only: like FILL_FORM/PRESS_KEY/SCREENSHOT/VERIFY, this
  // is NOT in the offered {@link OPERATIONS} subset. The model's choice set keeps exactly the
  // options its checkpoint was trained on; NAVIGATE is planned by the client LLM instead.
  NAVIGATE: "Open an explicit URL to reach another page.",
  PRESS_KEY: "Press a keyboard key such as Enter or Escape.",
  FILL_FORM: "Fill several form fields in one batch step.",
  SCREENSHOT: "Capture a screenshot of the page.",
  VERIFY: "Verify an expected marker is present on the page.",
  DONE: "The goal appears complete; stop.",
  BLOCKED: "The goal cannot be progressed from this page.",
};

/** Pick the entry with the greatest probability from a probability map. */
function argmax(probabilities: Record<string, number>): {
  key: string;
  prob: number;
} {
  let bestKey = "";
  let bestProb = -Infinity;
  for (const [key, prob] of Object.entries(probabilities)) {
    if (prob > bestProb) {
      bestProb = prob;
      bestKey = key;
    }
  }
  return { key: bestKey, prob: bestProb === -Infinity ? 0 : bestProb };
}

/** Clamp a probability into [0, 1]. */
function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
}

/**
 * Real on-device engine. Construct via the async {@link LayaEngine.load}; direct use of
 * the constructor is reserved for the loaded {@link Laya} handle it wraps.
 */
export class LayaEngine implements LayaDecisionEngine {
  readonly available = true;

  /**
   * The human label of the onnxruntime execution provider that actually initialized this
   * engine (e.g. "cuda" | "directml" | "cpu"). Set by the resolver in src/laya/index.ts
   * after a candidate loads; undefined when the engine was loaded directly without EP
   * resolution. Used only for the single startup log line in src/index.ts.
   */
  executionProvider?: string;

  private constructor(private readonly laya: Laya) {}

  /** Load the ONNX bundle (from `modelDir` or download) and wrap it in an engine. */
  static async load(options: LayaEngineOptions = {}): Promise<LayaEngine> {
    const laya = await Laya.load({
      ...(options.modelDir !== undefined ? { modelDir: options.modelDir } : {}),
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      ...(options.subfolder !== undefined ? { subfolder: options.subfolder } : {}),
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
      ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
      ...(options.executionProviders !== undefined
        ? { executionProviders: options.executionProviders as never }
        : {}),
    });
    return new LayaEngine(laya);
  }

  async decide(state: PageState): Promise<Decision> {
    // Serialize the state deterministically as the model input.
    const rendered = renderState(state);

    // Question 1: the operation, chosen from the seven fixed operations.
    const operationCriteria: Record<string, string> = {};
    for (const op of OPERATIONS) operationCriteria[op] = OPERATION_CRITERIA[op];

    // Question 2: the target control. Keys are stable option labels; we keep a map back
    // to the control ref so we can resolve the model's chosen key to a ref.
    const targetCriteria: Record<string, string> = {};
    const keyToRef = new Map<string, Ref>();
    for (const c of state.controls) {
      const key = controlLabel(c);
      targetCriteria[key] = `${c.role} named ${c.name || "(unnamed)"}`;
      keyToRef.set(key, c.ref);
    }

    const questions = {
      operation: {
        type: "choice" as const,
        instructions: `Given the goal and page state, choose the single best next operation.`,
        criteria: operationCriteria,
      },
      target: {
        type: "choice" as const,
        instructions: `Choose the control the operation should act on. If the operation acts on the whole page, pick the closest control anyway.`,
        criteria:
          state.controls.length > 0
            ? targetCriteria
            : { none: "No control applies." },
      },
    };

    const r = await this.laya.systemOne(rendered, questions);

    const opAnswer = r.answers.operation;
    const operation = (
      OPERATIONS.includes(opAnswer.choice as Operation)
        ? opAnswer.choice
        : "BLOCKED"
    ) as Operation;
    const operationConfidence = clampProb(argmax(opAnswer.probabilities).prob);

    if (TARGETED.has(operation)) {
      const targetAnswer = r.answers.target;
      const targetConfidence = clampProb(argmax(targetAnswer.probabilities).prob);
      const ref = keyToRef.get(targetAnswer.choice);
      if (ref === undefined) {
        // The model picked a target we cannot resolve; degrade to BLOCKED rather than
        // executing against a phantom ref.
        return {
          operation: "BLOCKED",
          operationConfidence,
          targetConfidence: 0,
          source: "laya",
        };
      }
      const decision: Decision = {
        operation: operation as TargetedOperation,
        operationConfidence,
        target: ref,
        targetConfidence,
        source: "laya",
      };
      // Carry the current value for the chosen control so the loop can type/select it if
      // the caller does not override; TYPE_TEXT/SELECT values are otherwise filled by the
      // deterministic layer.
      return decision;
    }

    return {
      operation: operation as TargetlessOperation,
      operationConfidence,
      targetConfidence: 1,
      source: "laya",
    };
  }

  async close(): Promise<void> {
    await this.laya.close();
  }
}
