

/**
 * A workpiece created by a turn's pending changes (see `createdGadgets` on the "changes" message
 * body). Reverting the turn deletes it, so discard affordances name it. Worktrees don't count:
 * no revert deletes a worktree (see `createdWorktrees`).
 */
export type CreatedWorkpieceName = { type: "gadget"; title: string };

// Suffix appended to discard labels when the discarded changes include gadget creations, since
// reverting also deletes the created gadgets: " (deletes gadgets “A”, “B”)".
function describeCreatedWorkpieceDeletion(created: CreatedWorkpieceName[] | undefined): string {
  if (!created || created.length === 0) return "";
  const titles = created.map((c) => `“${c.title}”`);
  return ` (deletes ${titles.length === 1 ? "gadget" : "gadgets"} ${titles.join(", ")})`;
}

/** Label for the per-turn discard-changes button. */
export function getDiscardLabel(
  isTrailing: boolean | undefined,
  createdWorkpieces?: CreatedWorkpieceName[],
): string {
  const base = isTrailing
    ? "Discard changes from this response"
    : "Discard changes from this response and later responses";
  return base + describeCreatedWorkpieceDeletion(createdWorkpieces);
}

export function getSavedEditsDiscardLabel(
  isTrailing: boolean | undefined,
  createdWorkpieces?: CreatedWorkpieceName[],
): string {
  const base = isTrailing
    ? "Discard saved edits"
    : "Discard saved edits and later changes";
  return base + describeCreatedWorkpieceDeletion(createdWorkpieces);
}
