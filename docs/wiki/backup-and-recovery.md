---
title: Backup and recovery of a company's local state
updated: 2026-11-12
---

# Backup and recovery of a company's local state

This page covers how to back up, restore and rehearse recovery of one company's local InferOS state together with the InferOps database behind it (FAC-141). By ADR 0009, one checkout or wrapper is one company.

The InferOps half has its own runbook, the as-built [upgrade and recovery](https://github.com/factory-level/inferops/blob/develop/docs/agent/architecture/upgrade-and-recovery.md) page: each InferOps store, `bun run proof:upgrade` and `bun run proof:recovery`. This page covers InferOS's stores and the two restored together.

Everything here is local. Nothing on this page backs up or restores a deployed stage: Durable Object contents have no export API (inferops ADR 0015 L11), and `pnpm stage:company-storage export-local` is an allow-listed export for offboarding, not a backup.

## What is retained

| Store | Holds | Where, locally |
| --- | --- | --- |
| Durable Objects: each workspace's Overseer and its gadget facets, the gatekeepers, the mock board | References, layout, revisions, held approvals and their dedup keys | `.wrangler/state/v3/do` |
| KV, R2 | Blueprint content, avatars, cached bundles | `.wrangler/state/v3/kv`, `.wrangler/state/v3/r2` |
| InferOps Postgres (the pinned backend's `inferos_<port>`) | Every entity, grant and claim: InferOps is authoritative | The shared Compose Postgres |

InferOS never holds a copy of an InferOps entity, only references to one and the revisions it last read. That's what makes the restore order below safe.

## Back up

Quiesce first: stop the stack, then the backend. Then take both copies together and record them as one restore point, with the time, this checkout's SHA and the backend's revision.

```bash
pnpm local stop
pnpm -s local inferops down                  # keeps the database
pg_dump -h localhost -U postgres -d inferos_<port> -Fc -f pair.dump
tar -czf pair-state.tgz .wrangler/state
```

## Restore

```bash
pnpm local stop; pnpm -s local inferops down
pg_restore -h localhost -U postgres -d inferos_<port> --clean --if-exists --exit-on-error pair.dump
pnpm local reset --yes                       # refused while the stack runs
tar -xzf pair-state.tgz
pnpm -s local inferops up --json
pnpm local start --inferops --stopgap -- --no-ui-watchers
```

## The consistency boundary

**Restore both copies from the same quiesced pair.** Together they give exactly the state at that point.

There is no transaction across the two stores, so a store restored on its own is safe in one direction only:

- **InferOS older than InferOps.** InferOS may still hold an approval InferOps has already applied. Approving it again is refused, as a stale revision, and the issue moves once, not twice.
- **InferOS newer than InferOps.** InferOS may remember approving a move the restored database never saw. InferOS shows the board as InferOps now holds it, with the issue unmoved, and starting it and reading the board writes nothing back. To apply the move again, propose it again.

## The rehearsal

`scripts/proof/recovery-rehearsal.ts` runs all of the above against the acme ENG board under the stopgap bearer, and reports JSON. Run it through heavy-run, from a clean shell, against a dedicated `pnpm wt` worktree. Run it from a checkout of this repository; the target is the worktree it backs up and restores:

```bash
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bash
node scripts/proof/recovery-rehearsal.ts --worktree "$PWD/.worktrees/<name>" --report /tmp/rehearsal.json
```

1. **Seed.** It brings the backend and the stack up, then `pnpm local seed --approval` holds one pending move.
2. **Pair A.** With both stopped, it dumps the database and archives `.wrangler/state`.
3. **State B.** It approves the move, which applies in InferOps, then archives the state again.
4. **Joint restore of pair A.** The issue rows and every state file equal pair A's, and the move is pending again.
5. **Skew 1, InferOS older.** It approves the move, restores only state A, and approves again. The replay is refused, and the issue's revision moved once.
6. **Skew 2, InferOS newer.** It restores database A with state B. `pnpm local verify` reads the board, and the issue rows still equal pair A's.

**Refusals.** It won't run, and touches nothing, when:
- the target is the main checkout, or not directly under `.worktrees/`;
- the target has uncommitted changes;
- the target's stack or backend is already running;
- the shell holds a cloud, deploy or model-provider credential;
- the Postgres host isn't localhost;
- the database isn't the backend's own `inferos_<port>` that this run started.

**When it ends.** It always stops the stack and the backend it started, and the report records whether both stopped. It drops no database: the backend's database is left restored to the rehearsal's last state, which the next `pnpm local inferops up` reuses. Archives are deleted after a passing run, and kept for a failing one.

`scripts/proof/recovery-rehearsal.test.ts` covers each refusal offline.
