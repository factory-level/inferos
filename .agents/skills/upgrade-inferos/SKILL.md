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
   - `files[]`: `regenerate` and `update` refresh files you have not edited (InferOS templates, and the blueprint and skill-pack starters copied from upstream); `add` creates new ones; `merge` is an edited file whose edits and the target's changes merged cleanly three-way; `conflict` is one whose merge conflicts and will not be touched; `needs-review` marks edited files that are not merged (the `.inferos/` helpers, binary files, a missing original, or no `.inferos/files.json`); `upstream-changed` marks the fixture and deleted or unmergeable starters. Customer files that were not copied from upstream (configuration, views, workers, gatekeepers) are never touched.
   - `review`: code range, configuration, capability, connection and OAuth, Durable Object migration and action-kind changes between the two revisions. Read every new action kind and migration.
   - `state`: the rollback limit. Newer Durable Object migrations cannot be undone; going back means reverting and `pnpm inferos recover state --apply`.
3. Apply on a review branch: `pnpm inferos upgrade <sha> --apply --branch inferos-upgrade-<sha7>`. It creates the branch, moves the submodule and gitlink, writes the clean merges, rewrites `upstream.revision`, `.inferos/bootstrap.json` and `.inferos/files.json`, scans the staged diff for secrets and excluded paths, and commits with the review summary as the message (also in `.inferos/state/upgrade/<sha>/UPGRADE.md`). Add `--open-pr <owner/repo>` only when the task asks for a PR: it pushes to `origin` and runs `gh pr create`. Without `--branch`, `--apply` only stages. Nothing is merged or deployed.
4. For each `conflict`, `needs-review` or `upstream-changed` file, open `.inferos/state/upgrade/<sha>/<path>`: a diff3 merge with conflict markers for a conflict, the target's text otherwise. Resolve into the wrapper's file by hand, keeping the customer's intent, and commit on the same branch. Never commit the state directory.
5. `git diff --cached`, `pnpm run setup` (the new pin's dependencies), then follow `verify-inferos`. Commit only when verify passes, or report its failures.

Rollback before commit: `git reset --hard && git submodule update --init inferos`. After commit: revert the commit, run `git submodule update`, and reset local state if the newer pin already started.

A wrapper whose `.inferos/runtime.ts` has no `upgrade` command predates this flow: from an InferOS checkout at the target SHA run `node scripts/consumer/upgrade.ts <wrapper> <sha> --plan`, then `--apply`. Without `.inferos/files.json` every copied file that differs from the target is `needs-review`.
