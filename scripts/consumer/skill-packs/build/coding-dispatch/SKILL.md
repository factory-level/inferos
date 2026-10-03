---
name: coding-dispatch
description: Hand a software issue of an InferOps project to the local coding runner through the gatekeeper's approval flow, follow the run, and report its patch and test evidence. Use when asked to have an issue coded, implemented or fixed by the local coding agent, or to check on a coding run.
---

# Coding dispatch

InferOps owns the issue and the run. The local runner does the work and returns a patch; nothing is pushed, merged or deployed. You propose, follow and report. You never apply a patch yourself, and you never say work is done because a model said so.

You need an InferOps **dispatch** binding for the project (`inferops://<tenant>.<workspace>/project/dispatch/<KEY>`). A board binding cannot dispatch. If there is none, ask the user to connect one; do not look for another way in.

1. **Pick the issue.** Read the board through the project binding, or take the key the user gave. Only `software` issues in an open state can be dispatched. Note the issue's current `revision` and treat it as opaque.
2. **Pick the repository.** Call `listRepos()`. Use only a repository with `enabled: true` and `allowed: true`. If none is allowed, say so: the deployment's allowlist decides, not you. Ask when more than one fits.
3. **Propose the dispatch.** Call `dispatch(issueKey, { repoId, baseRef? }, revision)`. It is queued for a person's approval and `listRuns()` shows it as `pending: "dispatch"` until then. Tell the user it is **proposed and waiting for approval**, not running.
4. **Follow the run** with `listRuns()` or `getRun(runId)` once approved. The states mean:
   - `queued`: waiting for the local runner. If it stays queued, the runner may be stopped or paused; tell the user to check `pnpm local runner status`.
   - `running`: the runner holds the lease and is working.
   - `succeeded`: there is a patch and every configured test command passed.
   - `failed`: read `error`. `AUTH_BLOCKED` or `QUOTA_BLOCKED` means the Codex sign-in or plan is blocked and the runner has **paused**; a person must fix it (see the local-coding setup guide). `TESTS_FAILED` means a patch exists but its tests failed. Anything else is a failed attempt.
   - `cancelled`: stopped before it ran.
   - `unknown`: the runner could not tell what happened (restart, lost lease, cancel while running). Do not guess; a person must look at the run directory.
5. **Report the result** from `getRun(runId).result` only:
   - `patch`: the local path, file count, insertions and deletions. The patch has not been applied anywhere.
   - `testSummary`: the runner's account of the test commands it executed itself. Quote it; it is the evidence.
   - `summary`: the agent's own description. Label it as the agent's claim, never as verification.
   If `testSummary` is missing, say that no test evidence was reported.
6. **Stop** a run only on request: `cancel(runId)` is another approval. A running run ends `unknown` because its work may be partly done.

Errors:
- `FORBIDDEN`: the repository is not allowed here, or the person lacks InferOps' dispatch permission. Do not retry.
- `RUN_ACTIVE`: the issue already has a queued, running or pending run. Follow that one instead.
- `STALE_REVISION`: the issue changed. Read it again, confirm, retry once.
- `DISABLED`: coding dispatch is switched off for this deployment. Stop and say so.

One issue per request unless the user lists several. Never claim success while a run is `queued`, `running`, `failed`, `cancelled` or `unknown`.

$ARGUMENT
