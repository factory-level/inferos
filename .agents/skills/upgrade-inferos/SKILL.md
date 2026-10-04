---
name: upgrade-inferos
description: Move an InferOS wrapper repository to a reviewed InferOS commit - plan the submodule move, configuration support and template changes, apply on a clean tree without overwriting customer edits, then verify. Use for any request to upgrade, bump or change the InferOS pin of a wrapper.
---

# Upgrade an InferOS wrapper

Get the reviewed full 40-character target SHA from the task. Never pick a moving branch yourself.

1. Commit or set aside every local change: `--apply` refuses a dirty tree. Plan first, always:
   `pnpm inferos upgrade <sha>` (same as `--plan`; writes nothing). It fetches the commit into `inferos/` if needed and runs that revision's own planner from a temporary worktree.
2. Review the plan JSON:
   - `blockers`: must be empty before applying (dirty tree, a configuration the target cannot read, capabilities it does not ship, a wrapper that does not check now).
   - `submodule.relation`: `forward` is normal. `not-a-descendant` is a downgrade or another branch; confirm it with the requester.
   - `config.migrate`: for a version 1 file, whether `pnpm inferos config migrate` would work on the target. The upgrade never migrates; run it separately if the task asks.
   - `files[]`: `regenerate` and `update` refresh InferOS files you have not edited; `add` creates new ones; `needs-review` marks edited (or, without `.inferos/files.json`, unknown) files that will not be touched; `upstream-changed` marks customer-owned starters (blueprints, skill packs, fixture) whose upstream source moved. Customer-owned files are never rewritten.
   - `state`: the rollback limit. Newer Durable Object migrations cannot be undone; going back means reverting and `pnpm inferos recover state --apply`.
3. `pnpm inferos upgrade <sha> --apply`. It moves the submodule and gitlink, rewrites `upstream.revision`, `.inferos/bootstrap.json` and `.inferos/files.json`, and stages everything. It does not commit, deploy or contact anything but Git.
4. For each `needs-review` file, compare the wrapper's copy with the target's text under `.inferos/state/upgrade/<sha>/<path>` and merge by hand. Keep the customer's intent.
5. `git diff --cached`, `pnpm run setup` (the new pin's dependencies), then follow `verify-inferos`. Commit only when verify passes, or report its failures.

Rollback before commit: `git reset --hard && git submodule update --init inferos`. After commit: revert the commit, run `git submodule update`, and reset local state if the newer pin already started.

A wrapper whose `.inferos/runtime.ts` has no `upgrade` command predates this flow: from an InferOS checkout at the target SHA run `node scripts/consumer/upgrade.ts <wrapper> <sha> --plan`, then `--apply`. Without `.inferos/files.json` every copied file that differs from the target is `needs-review`.
