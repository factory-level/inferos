---
name: local-coding
description: Set up, operate and recover the local InferOps coding runner (inferops runner codex in patch mode) for an InferOS wrapper - Codex ChatGPT sign-in, the service key, runner.json from codingWorkbench.repos, pnpm local runner start/status/stop, pnpm local coding doctor, blocked login or quota, lost lease, restart, unknown runs, and applying or discarding a patch. Use for any local coding-runner task in an InferOS wrapper or checkout.
---

# Local coding runner

The runner is InferOps' own `inferops runner codex --result patch`. InferOS only configures, starts, checks and stops it. It claims runs that a person approved through the InferOps gatekeeper, works in a `git worktree` of an allowlisted local repository, runs the configured test commands itself, and reports a patch with test evidence. It never commits, pushes, opens a PR, merges or deploys. A worktree is not a security sandbox: only allowlist repositories and test commands you trust.

Runbook with every field: `docs/wiki/local-coding-runner.md` (in the pinned `inferos/` checkout of a wrapper). Report what you verified and what you did not; a mocked check is never a live proof.

## Setup (once per machine and wrapper)

1. **Codex with a ChatGPT sign-in.** Install the Codex CLI the InferOps CLI pins, run `codex login` and choose **Sign in with ChatGPT**. `codex login status` must say `Logged in using ChatGPT`. An API-key sign-in is refused, and there is no fallback to one. The sign-in is the person's: ask them to do it, never do it with their credentials.
2. **The pinned InferOps CLI.** Use the `inferops` binary at the version the deployment pins. Nothing downloads it. Set `INFEROPS_CLI=/absolute/path/to/inferops` in the wrapper's `.dev.vars`.
3. **A service key.** An InferOps admin mints a service-account key holding `run:execute` for the workspace. Put it in `.dev.vars` as `INFEROPS_API_KEY`, with `INFEROPS_ENDPOINT` (the API base URL; `INFEROPS_BASE_URL` is used when unset) and `INFEROPS_WORKSPACE_ID`. `.dev.vars` is git-ignored. Never print the key, paste it into chat or commit it.
4. **The allowlist.** In `inferos.config.json` (schema version 2): `capabilities.CODING_WORKBENCH_ENABLED: true` (needs `INFEROPS_ENABLED`) and one `codingWorkbench.repos[]` entry per repository: `repoId` (the InferOps repository UUID), absolute `path` of a local clone, `testCommands` (one line each, run without a shell, so no `&&`, pipes or `$VARS`) and optional `baseRef`. The lifecycle writes `runner.json` from it into `.inferos/state/runner/`; do not hand-edit that file.
5. **Check.** `pnpm local coding doctor` must report ready. It checks the flag, that every path is a git repository and every base ref resolves, the settings by presence, that no provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, ...) would reach the runner, the CLI version, and the runner's own `--check` (Codex version, sign-in mode, pause state). Fix each `FAIL` line; do not work around one.

## Operate

- `pnpm local runner start` refuses unless the flag is on, the settings are complete and the runner's `--check` is ready. It starts the runner detached with only `PATH`, `HOME`, `CODEX_HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `USER` and the four runner settings in its environment, logging to `.inferos/state/runner/runner.log`. `--once` executes at most one run.
- `pnpm local runner status` shows the pid, the readiness check, the pause file and the newest run directories (patch present, test pass/fail counts).
- `pnpm local runner stop` sends SIGTERM and waits. A run in flight keeps its checkout and partial patch; InferOps will report it `unknown` or the restarted runner resumes it.
- Add `--json` to any of them for one JSON object. Exit code 0 means ok, 1 not ok, 2 a usage error.
- Dispatch itself happens in the Workshop, through the InferOps gatekeeper and an approval (the `coding-dispatch` skill). The runner claims only runs whose repository is in `runner.json`; others stay queued.

## Recovery

- **AUTH_BLOCKED / QUOTA_BLOCKED.** The run finished `failed` and the runner paused, writing `.inferops-runner.paused` in its workdir (status shows the path). It claims nothing until that file is removed and refuses to start while it exists. Fix the sign-in with `codex login` (ChatGPT) or wait for the plan's quota to reset, run `pnpm local coding doctor`, then delete the pause file and `pnpm local runner start`. Never switch to an API key or another account to get past it.
- **Lost lease.** A heartbeat answered `LEASE_LOST` (the run was cancelled or reaped). The runner stops that turn without reporting a result and keeps the partial patch on disk. The run's status in InferOps is authoritative; dispatch again if the work is still wanted.
- **Restart / resume.** After a crash or `stop`, `start` again. The runner resumes a running run of its own from the `.inferops-run.json` sidecar in the run directory, or reports it `unknown` when no thread was recorded.
- **Unknown runs.** `unknown` means nobody can say what happened. Open the run directory under `.inferos/state/runner/runs/<run-id>/` (status lists it), read `result.patch` and `.inferops-artifacts/`, and let a person decide. InferOps parks the issue's lease for them.
- **Runner exits at once or never claims.** Read the log tail in `runner status`. Check the repository is allowlisted in both the wrapper and InferOps (enrolled and enabled), and that `INFEROPS_WORKSPACE_ID` is the run's workspace.

## Apply or discard a patch

A patch is a proposal for a person. Apply it only when asked:

```bash
git -C <repo path> apply --check <run dir>/result.patch   # does it still apply?
git -C <repo path> apply <run dir>/result.patch           # apply to the working tree, uncommitted
```

Review the diff and the test artifacts (`.inferops-artifacts/test-<n>.{stdout,stderr,json}`) first; the evidence is the recorded exit codes, not the agent's summary. To discard, remove the run's checkout with `git -C <repo path> worktree remove <run dir>` (add `--force` only when told the changes can go). Never commit, push or merge on the runner's behalf unless the person asks.
