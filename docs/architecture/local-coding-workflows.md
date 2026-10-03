---
title: Local coding workflows and agent dispatch
covers:
  - custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts
  - custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx
  - custom-gatekeepers/gatekeeper-inferops/__tests__/dispatch.test.ts
  - scripts/consumer/config.ts
  - scripts/dev-server-config.ts
  - packages/workshop-frontend/src/features/canvas/codingDispatch.ts
  - packages/workshop-frontend/src/features/canvas/useCodingDispatch.ts
  - packages/workshop-frontend/src/features/canvas/codingRuns.ts
  - packages/workshop-frontend/src/features/canvas/KanbanCodingForm.tsx
  - packages/workshop-frontend/src/features/canvas/CodingRunStatus.tsx
updated: 2026-10-03
---

# Local coding workflows and agent dispatch

## Overview

The InferOS half of the [design](../design/local-coding-workflows.md) is the governed dispatch path ([#70](https://github.com/factory-level/inferos/issues/70)) and the deployment switch for it (the flag part of [#69](https://github.com/factory-level/inferos/issues/69)). A human or an agent with a coding-dispatch binding proposes handing a software issue of one InferOps project to the local coding runner; on approval the InferOps gatekeeper sends the dispatch with the person's own token, and InferOps queues a run that its runner pulls. The same binding lists the project's runs and their results and proposes cancels.

The runner itself is InferOps' (`inferops runner codex`), extended in InferOps by [factory-level/inferops#2327](https://github.com/factory-level/inferops/issues/2327). Its patch-result mode, local worktree, environment allowlist and captured test evidence are not part of this repository. InferOS has no runner, adapter or lifecycle command yet ([#72](https://github.com/factory-level/inferos/issues/72)). Its control surface is the Kanban's coding task dialog on the workspace's own canvas (step 7 below; [InferOps canvas](inferops-canvas.md#coding-control-surface)).

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts` | `CODING_WORKBENCH_ENABLED` (`codingWorkbenchEnabled`, `assertCodingWorkbenchEnabled`, `whileCodingWorkbenchEnabled`, the per-call client guard built on `enablement.ts`'s `guarded`) and the repository allowlist (`codingRepoAllowlist`, `assertRepoAllowlisted`) from `CODING_WORKBENCH_REPOS`. `capabilitySources.CODING_WORKBENCH_ENABLED` names this file. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | The `project/dispatch` branch of `getGatekeeperClassFor`, `InferOpsDispatchGatekeeper` (the dispatch binding's facet: apply, reject, revert, observers) and `DispatchSessionImpl` (`listRepos`, `listRuns`, `getRun`, `dispatch`, `cancel`). See [InferOps gatekeeper](inferops-gatekeeper.md). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx` | The dispatch picker: the project picker's fields, building `inferops://<organization>.<workspace>/project/dispatch/<KEY>`. |
| `scripts/consumer/config.ts` | `codingWorkbench.repos` validation (version 2 only), `codingRepoIds`, and `CAPABILITY_REQUIREMENTS.CODING_WORKBENCH_ENABLED` (needs `INFEROPS_ENABLED`). |
| `scripts/dev-server-config.ts` | `resolveCodingWorkbenchEnabled`, which `run-dev-server.ts` passes to the gatekeeper with the allowlisted ids. |
| `custom-gatekeepers/gatekeeper-inferops/src/http-inferops.ts` | Run results: `parsePatch` and `parseTests` keep a well-formed `patch` and `tests` (the runner's test commands with counts and artifact paths), and a known `reasonCode` (`AUTH_BLOCKED`, `QUOTA_BLOCKED`, `TESTS_FAILED`); anything malformed or unknown is left out whole. |
| `packages/workshop-frontend/src/features/canvas/codingDispatch.ts`, `useCodingDispatch.ts` | The control surface's reads: the dispatch reference resolved through the workspace's own connection, repositories and runs, bounded following of runs in flight, and the dispatch and cancel proposals. |
| `packages/workshop-frontend/src/features/canvas/codingRuns.ts`, `CodingRunStatus.tsx`, `KanbanCodingForm.tsx` | Run phases (blocked and tests failed from the reason code), the card's run badge, the run's result, and the coding task dialog with its repository picker. |

## Data and Control Flow

1. **Configuration.** A version 2 wrapper switches `CODING_WORKBENCH_ENABLED` on (with `INFEROPS_ENABLED`, which the parser requires) and lists its repositories under `codingWorkbench.repos`: each an InferOps repository UUID, the absolute path of its local checkout, one to twenty one-line test commands and an optional git ref. `run-dev-server.ts --consumer-root` resolves `CODING_WORKBENCH_ENABLED` with `resolveCodingWorkbenchEnabled` and sets `CODING_WORKBENCH_REPOS` to the comma-separated ids. Paths and test commands never reach a Worker; they are for the runner's local configuration.
2. **Binding.** With the switch on, the account offers `inferops://*/project/dispatch/*` beside the board kind and starts its picker. `getGatekeeperClassFor` refuses a dispatch URL with `DISABLED` while either switch is off, then applies the board's rules (the person's own workspace by slug, the project existing there, one refusal message for anything missing) and mints an `InferOpsDispatchGatekeeper` with the same props a board binding gets.
3. **Session.** Every call goes through `whileCodingWorkbenchEnabled`, so an existing binding or session, including one a stale client opens, is refused with `DISABLED: Coding dispatch is turned off for this deployment.` while off and works again once on. `listRepos`, `listRuns` and `getRun` are observations; `getRun` and `cancel` answer a run of another project exactly as an unknown run.
4. **Proposal.** `dispatch(issueKey, {repoId, baseRef?}, expectedRevision)` checks, with no request, the switch, the revision, key, repository id and ref syntax (`INVALID_REQUEST`) and the allowlist (`FORBIDDEN`). It then reads the board to resolve the key in the bound project (`NOT_FOUND`), and checks a software workflow (`WORKFLOW_MISMATCH`), an open state (`CONFLICT`), the revision (`STALE_REVISION`), a dispatch of the issue already pending (`RUN_ACTIVE`), the repository being listed and enabled (`INVALID_REQUEST`) and an active run (`RUN_ACTIVE`). It stages a `dispatch` action with its fingerprint and submits it as `inferops.code-dispatch`, not revertible and never auto-approvable. Until decided, `listRuns` shows a provisional queued run marked `pending: "dispatch"`.
5. **Apply.** The facet rechecks the switch, the allowlist and the fingerprint without a request, then calls `POST /project/issues/<id>/dispatch` (after the issue's scope check) under `<instance>:<action>`. InferOps checks `issue:delegate`; a refusal surfaces as "needs dispatch permission (issue:delegate)", `RUN_ACTIVE` as an active run, a stale revision as the issue having changed, and the action stays pending. The applied record keeps the run id.
6. **Cancel.** `cancel(runId)` proposes `inferops.run-cancel` for a queued or running run (a second request for the same run is a no-op). Apply sends `POST /project/runs/<id>/cancel`; a `CONFLICT` for a run that has since stopped counts as applied.
7. **Control surface.** On the workspace's own canvas (never in the Operate session or a flow), a board whose workspace also holds the project's dispatch binding gives each software issue a **Coding task** button and shows its latest run on the card. The dialog offers only repositories that are allowed and enabled (explaining the others), proposes the dispatch or a cancel, and says honestly where each stands: proposing, awaiting approval, approved or rejected (from the action log), then the run's own status. Runs in flight are re-read on a bounded backoff. Without the binding the board shows no coding control at all; with coding turned off it says so. See [InferOps canvas](inferops-canvas.md#coding-control-surface).

The demo data (`mock-inferops.ts`) has two repositories (`demo-app` enabled, `legacy-app` disabled), a run ledger with InferOps' dispatch guards and per-key replay, and `setRunStatus` in place of a runner.

## Configuration

| Setting | Where | Meaning |
| --- | --- | --- |
| `capabilities.CODING_WORKBENCH_ENABLED` | `inferos.config.json` version 2 | Switches coding dispatch on. Requires `INFEROPS_ENABLED`. Default off. |
| `codingWorkbench.repos[]` | `inferos.config.json` version 2 | `{repoId, path, testCommands, baseRef?}` per allowlisted repository. Optional; omitted or empty allows nothing. |
| `CODING_WORKBENCH_ENABLED` | Gatekeeper var | `"true"` is on, anything else (or unset) off; never on while `INFEROPS_ENABLED` is off. The dev server always sets it: from a version 2 wrapper's capability, else from the shell (default off). |
| `CODING_WORKBENCH_REPOS` | Gatekeeper var | Allowlisted repository ids, comma-separated. From a version 2 wrapper's `codingWorkbench.repos`, else from the shell. Entries that are not UUIDs are ignored. |

## Divergences from Design

- Only the dispatch, status and result path and its Kanban control surface exist. The runner's patch-result mode, local worktree, environment allowlist, test evidence, pause on login or quota failure and retention are InferOps work in [factory-level/inferops#2327](https://github.com/factory-level/inferops/issues/2327); InferOS shows what the runner reports (patch, tests, artifacts, reason code) but none of it is recorded live yet. The local lifecycle and skills are the rest of [#72](https://github.com/factory-level/inferos/issues/72).
- `codingWorkbench.repos` paths, test commands and base refs are validated but nothing reads them yet; they are for the runner configuration the local lifecycle will write.
- The design names binding the dispatch to source and workflow revisions. A dispatch binds the issue revision, repository, base ref, project and caller; there is no source commit or workflow revision in InferOps' dispatch request.
- The design's states include waiting for input and quota or login blocked. Runs report InferOps' six states; a failed run's `reasonCode` (`AUTH_BLOCKED`, `QUOTA_BLOCKED`) is shown as blocked, and `TESTS_FAILED` as failed tests. There is no waiting-for-input state.
- The release manifest sets neither var, so a cloud install has coding dispatch off and no allowlist.

## Open Questions

- Whether a wrapper should be able to turn coding on with an empty allowlist (today it can, and every dispatch is refused `FORBIDDEN`), or whether `doctor` should warn.
- `listRuns` reads the workspace's newest 200 runs and keeps the project's, so an older run of a busy workspace is not listed.
- No live run against InferOps has been recorded; the evidence is the mock, a fake `fetch` and the fake InferOps of the isolation suite.

## Evidence

The control surface's tests are listed under [InferOps canvas](inferops-canvas.md#coding-control-surface) (`CanvasBoardCoding.test.tsx`, `codingDispatch.test.ts`, `codingRuns.test.ts`, `OperateCoding.test.tsx`); result parsing of `tests` and `reasonCode` is in `__tests__/http-inferops.test.ts`. All of it runs against fakes; no live run is recorded.

`custom-gatekeepers/gatekeeper-inferops/__tests__/dispatch.test.ts` (workerd, over the demo data) covers the grammar, the kind offered only while on, dispatch and board URLs minting different gatekeepers, a board binding with no dispatch method, another project or host refused like a missing project, repositories with their allowlist status, a dispatch queued for approval with a provisional run and applied once, a repository off the allowlist (or no allowlist) refused before anything is read, wrong project, content issue, closed issue, stale revision, disabled repository and malformed arguments refused without a proposal, a second dispatch refused while one is pending and while the run is active, duplicate approval applying once, a replayed key and a reused key with another payload, a tampered stored dispatch refused by its fingerprint, a revision changed before apply, a repository taken off the allowlist before apply, rejection, run reads with a patch and test summary, a run of another project refused like an unknown one, cancels of queued and running runs, and the switch: unset is off, a new binding refused while it or InferOps is off, every call of an existing and a stale session refused and served again once on, and a queued dispatch never applied while off and applied once on. `__tests__/http-inferops.test.ts` covers the repository, run, dispatch and cancel requests and their error mapping (`FORBIDDEN`, `RUN_ACTIVE`, `STALE_REVISION`, `LEASE_QUARANTINED`, `WORKFLOW_MISMATCH`, `VALIDATION`). `packages/integration-tests/__tests__/inferops-isolation.test.ts` covers, against the fake InferOps through the real Workshop: a dispatch applied once with the person's own token and delegate permission, then cancelled; a person without `issue:delegate` refused at apply with nothing queued; a board binding unable to dispatch and an unlisted repository refused with no request; a stale dispatch; and the switch turned off refusing a stale session, a queued dispatch and a new binding without a request while the board stays available. `scripts/consumer/config.test.ts`, `scripts/dev-server-config.test.ts` and `scripts/consumer/bootstrap.test.ts` cover the configuration, its resolution and the capability reported supported.
