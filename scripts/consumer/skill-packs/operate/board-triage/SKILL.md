---
name: board-triage
description: Summarize an InferOps project board and recommend what to work on next. Use when asked for board status, blockers, overdue or unassigned work, or a standup-style summary of a connected InferOps project.
---

# Board triage

Read the board through the connected InferOps project binding (usually `INFEROPS_BOARD`), calling `readBoard()` once. If no InferOps board is connected, say so and stop. Do not invent issues.

Report, in this order:

1. **Blocked**: issues with a `blockedReason`, quoted briefly.
2. **Overdue**: issues in open groups (`backlog`, `unstarted`, `started`) whose `targetDate` is before today.
3. **Urgent or high priority, not started**: grouped by state.
4. **Unassigned in progress**: `started` issues with no `assigneeId`.
5. **Counts**: issues per state group.

Refer to issues by `identifier` (for example `DEMO-12`), never by UUID. Keep the summary short and lead with what needs a decision. Recommending a move is fine, but making one is a separate step: use the `issue-transition` skill.

$ARGUMENT
