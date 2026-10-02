---
name: issue-transition
description: Propose moving an InferOps issue to another workflow state through the gatekeeper's approval flow. Use when asked to move, start, finish, close or reopen an issue on a connected InferOps board.
---

# Issue transition

InferOps is the source of truth. Every move is a proposal that a person approves. You never apply it yourself.

1. Call `readBoard()` on the InferOps project binding. Find the issue by its identifier and the target state by name, within the issue's own `workflow`. If the target state is ambiguous or belongs to a different workflow, ask instead of guessing.
2. Call `openIssue(issueId)`, then `read()`, to get the current `revision`. Treat the revision as opaque: never increment it or compute it.
3. Call `transition(targetStateId, revision)`. The move is queued for approval, and until a decision is made, reads show the issue in its target state.
4. Tell the user the move is **proposed and waiting for approval**, not done.

Errors:
- `STALE_REVISION`: someone changed the issue. Read it again and confirm the move still makes sense before retrying once.
- `WORKFLOW_MISMATCH` or `INVALID_STATE`: the target is not valid for this issue. Explain why; do not retry.

Move one issue per request unless the user explicitly lists several.

$ARGUMENT
