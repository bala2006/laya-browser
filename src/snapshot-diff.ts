/**
 * (C2) Pure snapshot diffing.
 *
 * {@link diffSnapshots} compares two page snapshots and reports which controls appeared,
 * disappeared, or changed between them. It is PURE (no Playwright, no IO), so it type-checks
 * and unit-tests in isolation, and it is used by the Autopilot loop to surface "N new
 * controls appeared" and by the escalation path to send only the delta to the client LLM.
 *
 * Controls are keyed by a STABLE IDENTITY of `role + accessible name`, because the per-
 * snapshot `eN` refs are re-numbered on every capture and so cannot be compared across two
 * snapshots. A control that keeps its role and name but changes an observable property
 * (value / checked / disabled / options) is reported under `changed`; one whose identity has
 * no counterpart in the other snapshot is reported under `added` / `removed`.
 */
import type { Control, SnapshotDiff } from "./types.js";
import type { Snapshot } from "./snapshot.js";

/**
 * The stable cross-snapshot identity of a control: its role plus accessible name. The `eN`
 * ref is deliberately excluded because it is only meaningful within one snapshot.
 */
function identity(control: Control): string {
  return `${control.role}\u0000${String(control.name)}`;
}

/** Whether two option lists are equal (same entries, same order). */
function optionsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Whether a control's OBSERVABLE state changed between two snapshots that share an identity.
 *
 * Compares the properties that a step can meaningfully alter: current value, checked state,
 * disabled state, and the option set. The `ref`/`index` are ignored (they are per-snapshot),
 * and role/name are equal by construction (they form the identity).
 */
function stateChanged(before: Control, after: Control): boolean {
  return (
    before.value !== after.value ||
    before.checked !== after.checked ||
    before.disabled !== after.disabled ||
    before.editable !== after.editable ||
    before.type !== after.type ||
    !optionsEqual(before.options, after.options)
  );
}

/**
 * Compute the {@link SnapshotDiff} from `prev` to `next`.
 *
 * When `prev` is `undefined` (the first step of a run), every control in `next` is reported
 * as `added` and nothing is removed or changed. Identical snapshots yield an empty diff
 * (empty `added`/`removed`/`changed`). Duplicate identities within a snapshot are matched
 * positionally by their order of appearance so a page with two same-named buttons diffs
 * sensibly rather than collapsing them.
 */
export function diffSnapshots(
  prev: Snapshot | undefined,
  next: Snapshot,
): SnapshotDiff {
  const added: Control[] = [];
  const removed: Control[] = [];
  const changed: { before: Control; after: Control }[] = [];

  if (!prev) {
    return { added: [...next.controls], removed: [], changed: [] };
  }

  // Bucket the previous controls by identity, preserving order, so repeated identities are
  // consumed positionally rather than all mapping to a single slot.
  const prevByIdentity = new Map<string, Control[]>();
  for (const c of prev.controls) {
    const key = identity(c);
    const bucket = prevByIdentity.get(key);
    if (bucket) bucket.push(c);
    else prevByIdentity.set(key, [c]);
  }

  for (const after of next.controls) {
    const key = identity(after);
    const bucket = prevByIdentity.get(key);
    if (bucket && bucket.length > 0) {
      // Match (and consume) the earliest still-unmatched previous control of this identity.
      const before = bucket.shift()!;
      if (stateChanged(before, after)) changed.push({ before, after });
    } else {
      added.push(after);
    }
  }

  // Any previous controls left unmatched disappeared from the newer snapshot.
  for (const bucket of prevByIdentity.values()) {
    for (const before of bucket) removed.push(before);
  }

  return { added, removed, changed };
}

/**
 * Whether a diff carries any meaningful change (something added, removed, or changed).
 *
 * The escalation path uses this to decide between a delta-only prompt and the full-snapshot
 * prompt: an empty diff (or the first step, which has no `prev`) keeps the full prompt.
 */
export function hasChanges(diff: SnapshotDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}
