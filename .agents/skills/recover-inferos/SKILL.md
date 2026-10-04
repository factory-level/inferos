---
name: recover-inferos
description: Diagnose and repair an InferOS wrapper repository's local port conflicts, configuration and pin drift, invalid board fixture or stale local state with bounded, dry-run-first commands. Use when verify, doctor or pnpm local fails on ports, config, fixtures or state.
---

# Recover an InferOS wrapper

Every target is a dry run unless `--apply` is given. The JSON lists `findings`, `actions` (`auto` ones the command can do, `manual` ones a person must decide) and `ok` (nothing left to do). Run the dry run, read it, then apply only what the task authorizes.

- `pnpm inferos recover ports`: when `local.port` is busy. If this wrapper's own dev server holds it, `--apply` stops that server. If another process holds it, `--apply` sets `local.port` to the next free port. It never stops a process the wrapper did not start.
- `pnpm inferos recover config`: pin drift and missing InferOS files. If the gitlink and `upstream.revision` agree but the submodule checkout differs, `--apply` runs `git submodule update --init inferos` (refused while the submodule has local changes). If they disagree, the command will not pick one: restore from Git or upgrade. It rewrites `.inferos/bootstrap.json`, re-merges the managed `package.json` scripts (keeping yours) and restores missing helper, skill, README or `.gitignore` files. An edited file is reported, never overwritten. An invalid `inferos.config.json` is reported for a manual fix.
- `pnpm inferos recover fixtures`: an invalid board fixture. `--apply` renames the current file to `<fixture>.invalid-<time>` (it is never deleted) and restores the pinned starter, but only when the starter matches `inferops.targetRef`.
- `pnpm inferos recover state`: stale or migrated local state. Read `rollback` first: local state is reset only, never migrated back. `--apply` deletes `inferos/.wrangler/state` through `pnpm local reset --yes`, so every local account, workspace, board and approval is lost. Stop the stack first, and apply only with explicit task authorization.

Follow every apply with the `verify-inferos` skill. Recovery never touches cloud resources, `.dev.vars` or customer-owned files beyond the field or rename it describes.
