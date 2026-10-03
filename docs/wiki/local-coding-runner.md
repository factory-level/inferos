---
title: Run the local coding runner
updated: 2026-10-03
---

# Run the local coding runner

How to set up, run, check and recover the InferOps coding runner (`inferops runner codex --result patch`) for an InferOS wrapper with `pnpm local runner` and `pnpm local coding doctor`. The runner is InferOps' ([factory-level/inferops#2327](https://github.com/factory-level/inferops/issues/2327)); InferOS configures, starts and inspects it. Dispatch goes through the InferOps gatekeeper and a person's approval ([architecture](../architecture/local-coding-workflows.md)). The coding-agent version of this page is `.agents/skills/local-coding/SKILL.md`, which bootstrap copies into every wrapper.

No live run has been recorded yet ([#72](https://github.com/factory-level/inferos/issues/72)). The end-to-end evidence so far is the mocked suite described under [Evidence](#evidence).

## Steps

1. **Sign Codex in with ChatGPT.** Install the Codex CLI version the InferOps CLI pins, run `codex login`, choose ChatGPT, and confirm `codex login status` prints `Logged in using ChatGPT`. The runner refuses an API-key sign-in and never falls back to one.
2. **Install the pinned InferOps CLI** and note its absolute path. Nothing downloads it for you.
3. **Mint a service key** holding `run:execute` for the workspace (an InferOps admin does this).
4. **Write the settings** into the wrapper's git-ignored `.dev.vars`:

    | Variable | Meaning |
    | --- | --- |
    | `INFEROPS_CLI` | Absolute path of the pinned `inferops` binary |
    | `INFEROPS_ENDPOINT` | InferOps API base URL; `INFEROPS_BASE_URL` is used when it is unset |
    | `INFEROPS_WORKSPACE_ID` | The workspace UUID the runner claims runs in |
    | `INFEROPS_API_KEY` | The `run:execute` service key. Only presence is ever reported |
    | `CODEX_HOME`, `CODEX_PATH` | Optional: a moved Codex sign-in directory, a `codex` not on `PATH` |
    | `INFEROPS_RUNNER_WORKDIR` | Optional: where run checkouts go (default `.inferos/state/runner/runs`) |

5. **Allowlist the repositories** in `inferos.config.json` (schema version 2): set `capabilities.CODING_WORKBENCH_ENABLED` (with `INFEROPS_ENABLED`) and add `codingWorkbench.repos[]` entries `{repoId, path, testCommands, baseRef?}`. Each test command is one line run without a shell: quotes group words, and `&&`, pipes, redirects, `$VARS` and globs are refused. The repository must also be enrolled and enabled in InferOps.
6. **Check:** `pnpm local coding doctor` (add `--json` for one JSON object). Exit 0 means ready.
7. **Start:** `pnpm local runner start` (`--once` executes at most one run, then exits). Then dispatch from the Workshop and approve.
8. **Watch:** `pnpm local runner status`. **Stop:** `pnpm local runner stop`.

In an InferOS checkout rather than a wrapper, pass `--consumer-root <wrapper>`; a wrapper's own `pnpm local` adds it.

## What the commands do

| Command | Does | Fails (exit 1) when |
| --- | --- | --- |
| `runner start` | Writes `runner.json` from `codingWorkbench.repos`, runs the runner's `--check`, then starts it detached with the allowlisted environment, its output appended to `.inferos/state/runner/runner.log`, and records its pid. | The flag is off, a setting is missing, the allowlist is empty, a test command needs a shell, the check is not ready (sign-in not ChatGPT, paused), it already runs, or it exits at once. |
| `runner status` | Reports the pid and whether it is alive, the runner's `--check`, the pause file, the newest five run directories (patch present, test pass/fail counts from the artifacts, sidecar) and the log tail. | The runner is not running, not ready or paused. |
| `runner stop` | SIGTERM, then waits up to 30 s. | It survives the wait. |
| `coding doctor` | Checks the config, the flag, each repository (a git checkout, base ref resolves, commands runnable without a shell), the settings by presence, the child environment (no provider key passes; names those withheld), the CLI version (`inferops --version`), the runner's `--check` and Codex sign-in mode, and the pause file. Prints one `ok`/`FAIL` line each. | Any check fails. |

The launched runner's environment is exactly `PATH`, `HOME`, `CODEX_HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `USER` plus `INFEROPS_ENDPOINT`, `INFEROPS_WORKSPACE_ID`, `INFEROPS_API_KEY` and `CODEX_PATH`. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, the gatekeeper's `INFEROPS_API_TOKEN`, git tokens and everything else stay behind. Every report is passed through a redaction of credential-looking values, so a key echoed by the CLI does not reach the output.

## Recovery

| Situation | What you see | Do |
| --- | --- | --- |
| Sign-in expired or plan quota used up | The run `failed` with `AUTH_BLOCKED` or `QUOTA_BLOCKED`; `runner status` shows `paused` and the pause file path; `start` is refused | `codex login` (ChatGPT) or wait for the quota, `pnpm local coding doctor`, delete the pause file, `pnpm local runner start` |
| Lost lease | The runner log names `LEASE_LOST`; nothing is finished by this runner | The run's InferOps status is authoritative. The partial patch stays in the run directory; dispatch again if wanted |
| Runner stopped or crashed mid-run | `runner status` shows it not running | `pnpm local runner start`: the runner resumes its own running run from the `.inferops-run.json` sidecar, or reports it `unknown` |
| Run `unknown` | `getRun` shows `unknown` | A person inspects `result.patch` and `.inferops-artifacts/` in the run directory; InferOps parks the issue's lease for them |
| Run never claimed | It stays `queued` | Check the repository is in `codingWorkbench.repos` and enabled in InferOps, and that `INFEROPS_WORKSPACE_ID` matches |

Apply a reviewed patch with `git -C <repo> apply --check <run dir>/result.patch`, then without `--check`. Discard it with `git -C <repo> worktree remove <run dir>`. The runner never commits, pushes or merges.

## Evidence

- `scripts/local/runner.test.ts` (node --test): start refused with the flag off, without a wrapper, without `INFEROPS_CLI` and on an API-key sign-in; the launched process's environment holds no provider key, person token or git token; reports never contain the service key; doctor passing and failing; status of the pause file and run directories; start, status and stop of a real process.
- `packages/integration-tests/__tests__/coding-runner-mocked.test.ts` (**mocked**): dispatch through the real gatekeeper, approval, `pnpm local runner start`, a stub runner claiming the run from the fake InferOps with the service key, a patch and an executed test command's artifacts, the result through `getRun`, and a quota-blocked run pausing the runner. The InferOps runner, Codex and InferOps itself are stand-ins there.
