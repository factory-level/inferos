---
title: Fast local iteration and parallel worktrees
updated: 2026-10-11
---

# Fast local iteration and parallel worktrees

How to run several checkouts of InferOS side by side (for agents or people), each with its own dev server, without port clashes, missing secrets or a cold build cache, and how to keep the edit loop short. The as-built details are in the [local development architecture](../architecture/local-development.md#parallel-worktrees).

## The worktree workflow

Create worktrees with `pnpm wt`, from any checkout of the repo:

```bash
pnpm wt new my-fix                      # .worktrees/my-fix on a new branch my-fix from origin/main
pnpm wt new my-fix --from origin/main --branch fix/issue-123
cd .worktrees/my-fix
pnpm dev-server                         # on this worktree's own backend port
pnpm dev-client                         # Vite on this worktree's own frontend port
```

`wt new` runs, in order:

1. `git worktree add`;
2. port allocation and the `.env.worktree` overlay;
3. links to the main checkout's secrets;
4. `pnpm install --frozen-lockfile`, hardlinked from the shared pnpm store;
5. vp task cache seeding;
6. the builds the dev server's pre-flight needs: `@gadgets/typed-storage#build`, then the bundled blueprints, `build:configurator --dev` and `build:app:dev` together.

It prints the time each step took and the worktree's URLs.

| Command | What it does |
| --- | --- |
| `pnpm wt new <name> [--from <ref>] [--branch <b>]` | Create `<main checkout>/.worktrees/<name>`. Defaults: `--from origin/main` (fetched first), `--branch <name>`. `--no-cache-seed` skips the cache copy; `--seed-from <checkout>` copies another checkout's cache instead of the main checkout's. |
| `pnpm wt ls` | Registered worktrees of this repo with their live branch, ports, and whether they have uncommitted changes or commits no remote has. |
| `pnpm wt rm <name> [--force]` | `git worktree remove` and free the ports. Without `--force` it refuses uncommitted changes, unpushed commits, ignored local state the removal would delete, and a `.worktrees/` entry `wt` did not create. Local state means `.wrangler/state` (local D1, KV and Durable Object data), a real (non-symlink) `.env`/`.dev.vars`, or any other ignored file that is not a build output (`node_modules`, `dist`, `src/generated`, `.wrangler/tmp`/`validate`). `--force` discards all of it. |
| `pnpm wt ports` | The port table, with which ports are listening right now. |
| `pnpm wt doctor [--fix] [--build]` | Registry vs `git worktree list` drift, overlay vs registry, missing secrets links, world-readable secrets and port-block clashes. Read-only unless asked: `--fix` prunes registry entries whose worktree is gone (only the registry is edited), and `--build` runs one cached `vp run` in the current checkout only, reporting hit or miss. It never builds in other worktrees, whose `dist/` belongs to whoever works there. Exit 1 on an error. |

Worktrees live inside the main checkout's `.worktrees/` (gitignored), never as sibling directories: tooling that sweeps sibling `inferOS-wt-*` directories cannot reach them, and `pnpm wt rm` is the supported way to remove one. `wt rm` only ever acts on a direct child of `.worktrees/` that git lists as a worktree. A name with `/`, `\` or `..`, an absolute path, a symlink, or a registry entry pointing elsewhere is refused, even with `--force`. It removes only through `git worktree remove`. A git worktree created by hand under `.worktrees/` still works, but has no ports or overlay; `wt doctor` lists it, and `wt rm` removes it only with `--force`.

## Ports

Each worktree gets a block of 10 ports between 8800 and 9199. It is the first block that no registered worktree holds and in which nothing listens on IPv4 or IPv6 loopback. The main checkout keeps 8787 and 3000.

InferOps worktrees on the same machine shift InferOps' ports (8080, 8000, 8001, 8090, 3000–3002) by `offset × 100`, which reaches this range from offset 8. So a block containing any port ending in 00, 01, 02, 80 or 90 is never used: 28 blocks remain, the x10–x79 ports of each hundred, starting at 8810.

| Port | Use |
| --- | --- |
| base | Wrangler's public origin (router, `/api`, `/gatekeeper/*`): `VITE_BACKEND_HOST` |
| base + 1 | Vite (`pnpm dev-client`), and the backend's default `PUBLIC_BASE_URL` |
| base + 2 | Wrangler's inspector (`--inspector-port`, from `DEV_INSPECTOR_PORT`) |
| base + 3 … base + 9 | Spare, reserved for the worktree |

Wrangler picks its inspector port itself by probing 9229 upwards, then hands it to workerd a moment later. Two dev servers starting together can both pick 9229, and the second one's workerd then dies with `bind(): Address already in use (os error 98)`. With its own inspector port, a worktree never races another one. A main checkout without an overlay keeps Wrangler's probing. Wrangler's other dev ports are kernel-assigned (port 0), so they cannot collide.

Vite runs with `strictPort` whenever a port was assigned, so a busy port fails at startup instead of drifting to another port that the backend's `PUBLIC_BASE_URL` does not name.

The block is recorded in the per-user registry `$XDG_CONFIG_HOME/inferos/worktrees.json` (default `~/.config/inferos/worktrees.json`). Every change to it is a locked, atomic read-modify-write, so concurrent `wt new` runs never get the same block.

## The `.env.worktree` overlay

`wt new` writes `.env.worktree` at the worktree root:

```dotenv
VITE_BACKEND_HOST=localhost:8810
DEV_CLIENT_PORT=8811
DEV_INSPECTOR_PORT=8812
VP_RUN_CONCURRENCY_LIMIT=7
```

It is read by `pnpm dev-server`/`run-local`, `pnpm local`, `pnpm dev-client` and every `vp run` the repo's scripts start. Precedence is the shell, then `.env.worktree`, then `.dev.vars`, then `.env`. So a one-off `VITE_BACKEND_HOST=… pnpm dev-server` still wins, and the overlay beats the secrets files the worktree shares with the main checkout. `wt` rewrites every registered worktree's overlay on each `new`/`rm`, so don't edit it by hand; set an override in the shell instead.

`VP_RUN_CONCURRENCY_LIMIT` is the machine's `vp run` budget divided by the number of registered worktrees that git still lists, never below 2. `DEV_CLIENT_PORT` must be an integer from 1024 to 65535. Without it, N worktrees each claim the whole machine.

## Caches

- **pnpm store:** shared per user and hardlinked, so `pnpm install` in a new worktree is mostly linking.
- **vp task cache:** per checkout at `node_modules/.vite/task-cache/`, with no setting to share or move it. `wt new` copies the main checkout's cache into the new worktree before building. The copy uses SQLite's online backup for `cache.db` plus the archives. It is a copy, never a symlink, because two checkouts writing one cache concurrently is unsafe. Entries are keyed on workspace-relative inputs, but **today the seeded entries do not hit**. vp fingerprints the pnpm `node_modules/.bin/*` shim each task runs through, and pnpm writes the checkout's absolute path into every shim (`NODE_PATH`, `cmd-shim-target`). So each seeded entry misses on `'node_modules/.bin/tsc' modified`, even from a checkout at the same commit. Excluding `**/node_modules/.bin/**` from a task's cache input made a seeded `@gadgets/typed-storage#build` hit in a trial, so seeding starts paying off once the shared task inputs exclude the shims. A fresh worktree therefore still builds its UIs once, about 10–20 s inside `wt new`. `wt new` prints the hit counts, and `vp run --last-details` in the worktree says why each miss happened. `--no-cache-seed` skips the copy.

## Secrets

`wt new` symlinks the main checkout's root `.env` and `.dev.vars`, when they exist, into the worktree, so a worktree does not silently lose `ANTHROPIC_API_KEY` or other local keys. Links, not copies: a rotated key reaches every worktree, there is no second copy to leak, and the file keeps the main checkout's mode. `wt doctor` warns when that mode is readable by other users. Both names are gitignored, and `wt new` refuses to link one the worktree's branch does not ignore.

`packages/workshop-backend/.dev.vars` is not linked. The dev server appends its per-run secrets to that file and removes them on exit, and it refuses to write through a symlink (`scripts/local-secrets.ts`). Linking it would also let one worktree's run write into the main checkout's file.

## The edit loop

- **While iterating**, run `pnpm check:fast` after each change. It type-checks and tests only the packages your changed files are in. It runs every `scripts/` suite for a `scripts/**` change and `pnpm docs:check` for `docs/`. It ends with a `NOT CHECKED` list of what it skipped. A single test file is `npx vitest run <file>` in its package, once that package's codegen has run. Don't run full suites after every edit.
- **Before hand-off**, run `pnpm check:full` once: `pnpm lint`, `pnpm docs:check`, every `scripts/` suite and `pnpm test`. It caps `vp run` at 4 tasks unless your shell, `.env.worktree` or `.env` sets `VP_RUN_CONCURRENCY_LIMIT`. A worktree's own share from `wt new` therefore applies.
- **CI** is the final gate.

The `iterate` skill and the [check tiers](../architecture/local-development.md#check-tiers) have the details.

## Fewer Workers, faster reloads

Wrangler restarts every Worker on any change, so each backend edit waits on all of them. Start only the gatekeepers you need:

```bash
pnpm dev-server --gatekeepers inferops            # router + backend + gatekeeper-inferops
pnpm dev-server --gatekeepers inferops,github
INFEROS_DEV_GATEKEEPERS=none pnpm dev-server      # router + backend only
```

The router and backend always run. A gatekeeper left out has no Worker and no service bindings, so its routes and its connector in the Workshop are unavailable for that session. `pnpm local status` probes only the Workers the server started. Measured on 2026-10-11 (14 cores, other agents running): an edit to `packages/workshop-backend/src/sharing.ts` went live in about 5.5–8 s with all 17 gatekeepers, about 4.1 s with only `gatekeeper-inferops`, and 3.9 s with none.
