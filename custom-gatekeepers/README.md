# Custom gatekeepers

Gatekeepers owned by this fork live here instead of in `packages/`, so merges from upstream
`cloudflare-os` never touch them and a fork can see at a glance what it added.

Everything else is the same as `packages/gatekeeper-*`:

- Each child is a pnpm workspace package (`pnpm-workspace.yaml` lists `custom-gatekeepers/*`).
- A `gatekeeper-<name>` directory with a `wrangler.jsonc` is a deployable Worker. The dev server
  binds it to the backend as `GATEKEEPER_<NAME>`, and the release manifest ships it. Discovery for
  both roots is `scripts/worker-dirs.ts`; a name used in both `packages/` and here is an error.
- A consumer wrapper keeps its own gatekeepers in its `gatekeepers/` directory instead, never
  here, so the pinned submodule stays unedited. `scripts/worker-dirs.ts` adds them only when the
  dev server is given the wrapper (`--consumer-root`), for local development only, and rejects a
  name already used in `packages/` or here (see
  `docs/architecture/local-development.md#wrapper-topology`).
- `wrangler.jsonc` is generated from `cloudflare.config.ts` by `pnpm configs:generate`.
- Read `.agents/skills/write-gatekeeper/SKILL.md` before writing or changing one, and keep the
  agent-facing `src/types.d.ts` self-contained (lint enforces it here too).

| Package | Purpose |
| --- | --- |
| `gatekeeper-inferops` | InferOps project boards and approved issue transitions. Demo data by default; a live InferOps through `INFEROPS_*` vars for local development only. |
