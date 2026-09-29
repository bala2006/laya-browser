/**
 * {@link LayaEngine} — the real on-device decision engine wrapping `@receptron/laya`.
 *
 * The web-agent checkpoint was trained on jev_ultrafast's request shape, so the engine speaks
 * exactly that (see {@link ./jev-format}): a JSON page state, an `operation` question over only
 * the operations the page supports, and one target head per operation over only the elements
 * that operation can act on. The model therefore can never pair SELECT with a button.
 *
 * TWO PASSES, not one. Every question is its own forward row that re-encodes the whole state,
 * so on CPU cost scales with the number of rows. The heads are independent (a target head
 * cannot read the operation answer), so asking the operation first and then ONLY the chosen
 * operation's head yields the identical decision while never paying for unused heads.
 * Measured on the local fixtures (web-agent bundle, 8-core CPU): median decide 6.6 s -> 4.2 s,
 * decisions unchanged. A head with a single candidate is never asked.
 *
 * ONNX is touched only inside {@link LayaEngine.load}/{@link decide}. When weights are absent
 * the factory ({@link ./index.createEngine}) returns an unavailable engine instead.
 */
import { Laya } from "@receptron/laya";
import type { Decision, LayaDecisionEngine, PageState } from "../types.js";
import {
  actionableOperation,
  buildJevRequest,
  parseJevAnswers,
  type ChoiceAnswerLike,
  type JevRequest,
} from "./jev-format.js";

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

const HEADS = { CLICK: "click_target", TYPE_TEXT: "type_text_target", SELECT: "select_target" } as const;

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
    const engine = new LayaEngine(laya);
    // The first run pays graph/allocator initialization; pay it at load, not on step 1.
    await laya.systemOne("warm up", {
      q: { type: "choice", instructions: "warm up", criteria: ["a", "b"] },
    });
    return engine;
  }

  /** The last operation answer, keyed by its serialized request, so a re-ask costs no row. */
  private lastOp: { state: string; answer: ChoiceAnswerLike } | undefined;

  async decide(state: PageState): Promise<Decision> {
    const req = buildJevRequest(state);
    const first = await this.laya.systemOne(req.state, { operation: req.questions.operation! });
    const opAnswer = first.answers.operation;
    if (opAnswer) this.lastOp = { state: req.state, answer: opAnswer };
    return this.withTarget(req, opAnswer);
  }

  async decideActionable(state: PageState): Promise<Decision | undefined> {
    const req = buildJevRequest(state);
    let opAnswer = this.lastOp?.state === req.state ? this.lastOp.answer : undefined;
    if (!opAnswer) {
      opAnswer = (await this.laya.systemOne(req.state, { operation: req.questions.operation! }))
        .answers.operation;
    }
    const actionable = opAnswer ? actionableOperation(opAnswer) : undefined;
    if (!actionable) return undefined;
    const decision = await this.withTarget(req, actionable);
    return decision.operation === "BLOCKED" ? undefined : decision;
  }

  /** Ask ONLY the chosen operation's target head (when it has 2+ candidates) and map back. */
  private async withTarget(
    req: JevRequest,
    opAnswer: ChoiceAnswerLike | undefined,
  ): Promise<Decision> {
    const answers: Record<string, ChoiceAnswerLike | undefined> = { operation: opAnswer };
    const op = opAnswer?.choice;
    const head = op !== undefined && op in HEADS ? HEADS[op as keyof typeof HEADS] : undefined;
    const question = head !== undefined ? req.questions[head] : undefined;
    if (head !== undefined && question !== undefined) {
      const second = await this.laya.systemOne(req.state, { [head]: question });
      Object.assign(answers, second.answers);
    }
    return parseJevAnswers(req, answers);
  }

  async close(): Promise<void> {
    await this.laya.close();
  }
}
