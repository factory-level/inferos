---
title: Local coding workflows and agent dispatch
covers:
  - custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts
  - custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx
  - custom-gatekeepers/gatekeeper-inferops/__tests__/dispatch.test.ts
  - scripts/consumer/config.ts
  - scripts/dev-server-config.ts
  - scripts/local/coding.ts
  - scripts/local/runner.ts
  - scripts/local/testdata
  - scripts/consumer/skill-packs/build/coding-dispatch
  - .agents/skills/local-coding
  - packages/integration-tests/__tests__/coding-runner-mocked.test.ts
updated: 2026-10-03
---

# Local coding workflows and agent dispatch

## Overview

The InferOS half of the [design](../design/local-coding-workflows.md) is the governed dispatch path ([#70](https://github.com/factory-level/inferos/issues/70)) and the deployment switch for it (the flag part of [#69](https://github.com/factory-level/inferos/issues/69)). A human or an agent with a coding-dispatch binding proposes handing a software issue of one InferOps project to the local coding runner; on approval the InferOps gatekeeper sends the dispatch with the person's own token, and InferOps queues a run that its runner pulls. The same binding lists the project's runs and their results and proposes cancels.

The runner itself is InferOps' (`inferops runner codex`), extended in InferOps by [factory-level/inferops#2327](https://github.com/factory-level/inferops/issues/2327). Its patch-result mode, local worktree, environment allowlist and captured test evidence are not part of this repository. InferOS runs it locally ([#72](https://github.com/factory-level/inferos/issues/72)): `pnpm local runner start|status|stop` writes its `runner.json` from the wrapper's allowlist and starts it with an allowlisted environment, `pnpm local coding doctor` says whether it may start, and two skills tell agents how to dispatch (`coding-dispatch`) and how to set up and recover the runner (`local-coding`). There is no control surface in the OS yet; the runbook is [Run the local coding runner](../wiki/local-coding-runner.md).

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts` | `CODING_WORKBENCH_ENABLED` (`codingWorkbenchEnabled`, `assertCodingWorkbenchEnabled`, `whileCodingWorkbenchEnabled`, the per-call client guard built on `enablement.ts`'s `guarded`) and the repository allowlist (`codingRepoAllowlist`, `assertRepoAllowlisted`) from `CODING_WORKBENCH_REPOS`. `capabilitySources.CODING_WORKBENCH_ENABLED` names this file. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | The `project/dispatch` branch of `getGatekeeperClassFor`, `InferOpsDispatchGatekeeper` (the dispatch binding's facet: apply, reject, revert, observers) and `DispatchSessionImpl` (`listRepos`, `listRuns`, `getRun`, `dispatch`, `cancel`). See [InferOps gatekeeper](inferops-gatekeeper.md). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx` | The dispatch picker: the project picker's fields, building `inferops://<organization>.<workspace>/project/dispatch/<KEY>`. |
| `scripts/consumer/config.ts` | `codingWorkbench.repos` validation (version 2 only), `codingRepoIds`, and `CAPABILITY_REQUIREMENTS.CODING_WORKBENCH_ENABLED` (needs `INFEROPS_ENABLED`). |
| `scripts/dev-server-config.ts` | `resolveCodingWorkbenchEnabled`, which `run-dev-server.ts` passes to the gatekeeper with the allowlisted ids, and which the runner commands reuse. |
| `scripts/local/runner.ts` | The runner's local configuration: `resolveCodingContext` (wrapper config, switch, settings, state paths), `buildRunnerFile`/`splitTestCommand` (`runner.json` from `codingWorkbench.repos`, test commands as argv with shell syntax refused), `runnerChildEnv` (the launched environment's allowlist), `providerVariables`, `secretValues`/`redact`, `parseReadiness` (the CLI's `--check` envelope), `readPause`, `recentRuns`. |
| `scripts/local/coding.ts` | `runCoding`: `runner start`, `status`, `stop` and `coding doctor`, behind the injectable `CodingDeps` (`runCli`, `launch`, `git`, signals). `scripts/local/lifecycle.ts` routes `pnpm local runner …`/`coding …` to it. |
| `scripts/consumer/skill-packs/build/coding-dispatch/SKILL.md` | Workshop agent skill: pick an issue and an allowed repository, propose the dispatch, follow the run's states, report the patch and `testSummary`, never success from model text. |
| `.agents/skills/local-coding/SKILL.md` | Coding-agent SOP: Codex ChatGPT sign-in, service key, allowlist, operate, recovery, apply or discard a patch. Bootstrap copies it into wrappers. |
| `scripts/local/testdata/` | **Mock** `inferops` and `codex` binaries and a wrapper fixture for the tests. Not shipped, not a runner. |

## Data and Control Flow

1. **Configuration.** A version 2 wrapper switches `CODING_WORKBENCH_ENABLED` on (with `INFEROPS_ENABLED`, which the parser requires) and lists its repositories under `codingWorkbench.repos`: each an InferOps repository UUID, the absolute path of its local checkout, one to twenty one-line test commands and an optional git ref. `run-dev-server.ts --consumer-root` resolves `CODING_WORKBENCH_ENABLED` with `resolveCodingWorkbenchEnabled` and sets `CODING_WORKBENCH_REPOS` to the comma-separated ids. Paths and test commands never reach a Worker; they are for the runner's local configuration.
2. **Binding.** With the switch on, the account offers `inferops://*/project/dispatch/*` beside the board kind and starts its picker. `getGatekeeperClassFor` refuses a dispatch URL with `DISABLED` while either switch is off, then applies the board's rules (the person's own workspace by slug, the project existing there, one refusal message for anything missing) and mints an `InferOpsDispatchGatekeeper` with the same props a board binding gets.
3. **Session.** Every call goes through `whileCodingWorkbenchEnabled`, so an existing binding or session, including one a stale client opens, is refused with `DISABLED: Coding dispatch is turned off for this deployment.` while off and works again once on. `listRepos`, `listRuns` and `getRun` are observations; `getRun` and `cancel` answer a run of another project exactly as an unknown run.
4. **Proposal.** `dispatch(issueKey, {repoId, baseRef?}, expectedRevision)` checks, with no request, the switch, the revision, key, repository id and ref syntax (`INVALID_REQUEST`) and the allowlist (`FORBIDDEN`). It then reads the board to resolve the key in the bound project (`NOT_FOUND`), and checks a software workflow (`WORKFLOW_MISMATCH`), an open state (`CONFLICT`), the revision (`STALE_REVISION`), a dispatch of the issue already pending (`RUN_ACTIVE`), the repository being listed and enabled (`INVALID_REQUEST`) and an active run (`RUN_ACTIVE`). It stages a `dispatch` action with its fingerprint and submits it as `inferops.code-dispatch`, not revertible and never auto-approvable. Until decided, `listRuns` shows a provisional queued run marked `pending: "dispatch"`.
5. **Apply.** The facet rechecks the switch, the allowlist and the fingerprint without a request, then calls `POST /project/issues/<id>/dispatch` (after the issue's scope check) under `<instance>:<action>`. InferOps checks `issue:delegate`; a refusal surfaces as "needs dispatch permission (issue:delegate)", `RUN_ACTIVE` as an active run, a stale revision as the issue having changed, and the action stays pending. The applied record keeps the run id.
6. **Cancel.** `cancel(runId)` proposes `inferops.run-cancel` for a queued or running run (a second request for the same run is a no-op). Apply sends `POST /project/runs/<id>/cancel`; a `CONFLICT` for a run that has since stopped counts as applied.

7. **Runner.** See [Runner lifecycle](#runner-lifecycle). The runner claims the queued run with its own service key, works in a worktree of the allowlisted local checkout, and finishes it with a patch and test evidence, which `getRun` then reports.

The demo data (`mock-inferops.ts`) has two repositories (`demo-app` enabled, `legacy-app` disabled), a run ledger with InferOps' dispatch guards and per-key replay, and `setRunStatus` in place of a runner.

## Runner lifecycle

`pnpm local runner …` and `pnpm local coding doctor` (`scripts/local/lifecycle.ts` → `coding.ts`) read the wrapper named by `--consumer-root` (a wrapper's own `pnpm local` adds it; in-repo it defaults to the checkout). Settings come from the shell, then the wrapper's `.dev.vars`, then `.env` (`localEnv`). State lives in the wrapper's git-ignored `.inferos/state/runner/` (`.wrangler/local/runner/` when the wrapper is the checkout itself): `runner.json`, `runner.pid.json`, `runner.log` and the workdir `runs/` (or `INFEROPS_RUNNER_WORKDIR`).

1. **Refusals before anything runs.** No `inferos.config.json`; `CODING_WORKBENCH_ENABLED` off as `resolveCodingWorkbenchEnabled` resolves it (a version 2 wrapper's capability; otherwise the shell); an empty `codingWorkbench.repos`; a test command that needs a shell; `INFEROPS_CLI` unset, relative or not executable (it is never searched for on `PATH` or downloaded); `INFEROPS_ENDPOINT` (else `INFEROPS_BASE_URL`), `INFEROPS_WORKSPACE_ID` or `INFEROPS_API_KEY` missing or malformed. A refused `start` writes nothing and launches nothing.
2. **`runner.json`.** `{repos: {<repoId>: {path, baseRef?, testCommands: string[][]}}}`, written on `start` (and by `doctor`, or by `status` when absent). Each one-line wrapper command becomes an argv: whitespace splits words, single or double quotes group them, and shell syntax outside quotes (pipes, `&`, `;`, redirects, parentheses, `$`, backticks, backslashes, globs and braces) is refused because the runner executes commands without a shell. `testTimeoutSeconds` is left at the runner's default.
3. **Readiness.** `start` runs `<INFEROPS_CLI> runner codex --result patch --config runner.json --workdir <dir> --json --check` with the launch environment and refuses unless it reports `ready` (Codex present, signed in with ChatGPT, at least one repository, not paused).
4. **Launch.** The same argv without `--check` (with `--once` when asked), detached in its own process group, stdout and stderr appended to `runner.log`, pid recorded. The environment is built from an allowlist: `PATH`, `HOME`, `CODEX_HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `USER`, plus `INFEROPS_ENDPOINT`, `INFEROPS_WORKSPACE_ID`, `INFEROPS_API_KEY` and `CODEX_PATH`, and never a name `isProviderVariable` matches (`OPENAI_*`, `ANTHROPIC_*`, `CODEX_*` other than `CODEX_HOME`/`CODEX_PATH`, `AZURE_OPENAI_*`, `GEMINI_*`, any other `*_API_KEY`, and similar). The gatekeeper's person token `INFEROPS_API_TOKEN` and git tokens are not on the list. A process that is gone after one second is reported as exited at once (or paused, when the pause file appeared).
5. **Status.** The recorded pid and whether it is alive, the `--check` report, the pause file (`<workdir>/.inferops-runner.paused`: reason, run, time), the newest five run directories (`result.patch` size, pass/fail counts from `.inferops-artifacts/test-<n>.json` exit codes, whether the `.inferops-run.json` sidecar is present) and the log tail.
6. **Stop.** SIGTERM to the recorded pid, then up to 30 s for it to exit; the runner relays the signal to its Codex child and keeps the checkout and partial patch. The pause file is left for a person.
7. **Doctor.** One finding each for the config, the switch, the allowlist count, every repository (`git rev-parse --show-toplevel`, the base ref resolving, the commands splitting), the settings, the child environment (fails if a provider variable would pass; names those withheld), the CLI version (`--version --json`), the runner's `--check`, the Codex sign-in mode (`api-key` is refused) and the pause file. Exit 0 only when all pass.

Every report and headline passes through `redact`, which replaces the value of every credential-looking variable (names with `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `SESSION`, and provider variables) with `[redacted]`. Reports show `INFEROPS_API_KEY` as `set` or `missing`, and the endpoint by host.

## Configuration

| Setting | Where | Meaning |
| --- | --- | --- |
| `capabilities.CODING_WORKBENCH_ENABLED` | `inferos.config.json` version 2 | Switches coding dispatch on. Requires `INFEROPS_ENABLED`. Default off. |
| `codingWorkbench.repos[]` | `inferos.config.json` version 2 | `{repoId, path, testCommands, baseRef?}` per allowlisted repository. Optional; omitted or empty allows nothing. |
| `CODING_WORKBENCH_ENABLED` | Gatekeeper var | `"true"` is on, anything else (or unset) off; never on while `INFEROPS_ENABLED` is off. The dev server always sets it: from a version 2 wrapper's capability, else from the shell (default off). |
| `INFEROPS_CLI` | Wrapper `.dev.vars` or shell | Absolute path of the pinned `inferops` binary the runner commands launch. |
| `INFEROPS_ENDPOINT`, `INFEROPS_WORKSPACE_ID`, `INFEROPS_API_KEY` | Wrapper `.dev.vars` or shell | The runner's API base URL (falls back to `INFEROPS_BASE_URL`), workspace and `run:execute` service key. Passed to the runner only. |
| `CODEX_HOME`, `CODEX_PATH` | Wrapper `.dev.vars` or shell | Optional Codex sign-in directory and executable, passed through. |
| `INFEROPS_RUNNER_WORKDIR` | Wrapper `.dev.vars` or shell | Optional run checkout directory (default `.inferos/state/runner/runs`). |
| `CODING_WORKBENCH_REPOS` | Gatekeeper var | Allowlisted repository ids, comma-separated. From a version 2 wrapper's `codingWorkbench.repos`, else from the shell. Entries that are not UUIDs are ignored. |

## Divergences from Design

- The runner's patch-result mode, local worktree, environment allowlist, test evidence, pause on login or quota failure and retention are InferOps work in [factory-level/inferops#2327](https://github.com/factory-level/inferops/issues/2327) (factory-level/inferops#2330 and #2332, not merged when this was written). The lifecycle here targets that contract; it has only run against the mock CLI.
- There is no control surface in the OS: dispatch and run status are reached through the gatekeeper session (agents, the `coding-dispatch` skill), and runner state through `pnpm local runner status`.
- `getRun` reports the patch and `testSummary` but not the runner's per-command `tests` list or its `reasonCode`; a blocked run is recognisable by its `error` text starting with `AUTH_BLOCKED` or `QUOTA_BLOCKED`.
- The pause file is cleared by hand; there is no `runner resume` command.
- The design names binding the dispatch to source and workflow revisions. A dispatch binds the issue revision, repository, base ref, project and caller; there is no source commit or workflow revision in InferOps' dispatch request.
- The design's states include waiting for input and quota or login blocked; runs report only InferOps' six states.
- The release manifest sets neither var, so a cloud install has coding dispatch off and no allowlist.

## Open Questions

- Whether a wrapper should be able to turn coding on with an empty allowlist. Today the dev server accepts it (every dispatch is refused `FORBIDDEN`), while `pnpm local coding doctor` fails on it and `runner start` refuses it.
- `listRuns` reads the workspace's newest 200 runs and keeps the project's, so an older run of a busy workspace is not listed.
- No live run against InferOps has been recorded; the evidence is the mock, a fake `fetch`, the fake InferOps of the isolation suite and the mocked runner suite. The owner's live proof (#72) needs a real Codex ChatGPT sign-in and a running InferOps with the runner from factory-level/inferops#2327.

## Evidence

`scripts/local/runner.test.ts` (node --test, mock `inferops` and `codex` from `scripts/local/testdata/`) covers test-command splitting and shell syntax refused, the launch environment's allowlist with provider keys, a person token and a git token in the parent, redaction, usage errors, `runner start` refused with the switch off (nothing written or launched), without a wrapper, without `INFEROPS_CLI` and on an API-key sign-in, `coding doctor` passing and failing (non-git path, API-key sign-in, pause file) without printing the service key, a real detached start whose process saw no provider key, a second start refused, status and stop, the pause file and run directories in status, and the wrapper's `--consumer-root` forwarding.

`packages/integration-tests/__tests__/coding-runner-mocked.test.ts` is the **mocked** end to end: the real Workshop and gatekeeper, the fake InferOps (with its runner lane served on loopback), and the mock `inferops`/`codex` binaries. A person dispatches through a dispatch binding and approves; `pnpm local coding doctor` passes; `pnpm local runner start` launches the mock runner, which claims the run with the service key (start, heartbeat with a thread id, finish), writes a patch and runs the wrapper's test command; `getRun` shows `succeeded`, the `testSummary` and the patch, whose sha256 matches and which applies with `git apply --check` while the operator's repository has no new commit; neither the runner nor the Codex child saw a provider key; `runner status` lists the run with one passing test; `runner stop` stops it. A second case makes the mock Codex report a usage limit: the run fails `QUOTA_BLOCKED`, status shows the pause, and `start` is refused. None of this exercises the InferOps runner, a real Codex sign-in or a live InferOps.


`custom-gatekeepers/gatekeeper-inferops/__tests__/dispatch.test.ts` (workerd, over the demo data) covers the grammar, the kind offered only while on, dispatch and board URLs minting different gatekeepers, a board binding with no dispatch method, another project or host refused like a missing project, repositories with their allowlist status, a dispatch queued for approval with a provisional run and applied once, a repository off the allowlist (or no allowlist) refused before anything is read, wrong project, content issue, closed issue, stale revision, disabled repository and malformed arguments refused without a proposal, a second dispatch refused while one is pending and while the run is active, duplicate approval applying once, a replayed key and a reused key with another payload, a tampered stored dispatch refused by its fingerprint, a revision changed before apply, a repository taken off the allowlist before apply, rejection, run reads with a patch and test summary, a run of another project refused like an unknown one, cancels of queued and running runs, and the switch: unset is off, a new binding refused while it or InferOps is off, every call of an existing and a stale session refused and served again once on, and a queued dispatch never applied while off and applied once on. `__tests__/http-inferops.test.ts` covers the repository, run, dispatch and cancel requests and their error mapping (`FORBIDDEN`, `RUN_ACTIVE`, `STALE_REVISION`, `LEASE_QUARANTINED`, `WORKFLOW_MISMATCH`, `VALIDATION`). `packages/integration-tests/__tests__/inferops-isolation.test.ts` covers, against the fake InferOps through the real Workshop: a dispatch applied once with the person's own token and delegate permission, then cancelled; a person without `issue:delegate` refused at apply with nothing queued; a board binding unable to dispatch and an unlisted repository refused with no request; a stale dispatch; and the switch turned off refusing a stale session, a queued dispatch and a new binding without a request while the board stays available. `scripts/consumer/config.test.ts`, `scripts/dev-server-config.test.ts` and `scripts/consumer/bootstrap.test.ts` cover the configuration, its resolution and the capability reported supported.
