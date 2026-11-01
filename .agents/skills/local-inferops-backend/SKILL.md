---
name: local-inferops-backend
description: Run a real, pinned InferOps backend beside this InferOS checkout and develop or verify against it instead of the gatekeeper's demo data - `pnpm local inferops up|status|verify|env|down` and `pnpm local start --inferops`. Use whenever a task needs InferOS to talk to InferOps locally (Kanban, approvals, Wiki, per-person sign-in, the live suite), when asked to "run against inferops", "test with a real backend", or to prove an InferOps-backed feature, and whenever an inferops worktree and an InferOS worktree must run at the same time.
---

# A pinned InferOps backend for this checkout

InferOS is developed against the InferOps revision its gatekeeper is pinned to
(`custom-gatekeepers/gatekeeper-inferops/connection.json`, `compatibility.provider.revision`),
not against whatever `../inferops` has checked out and not against the gatekeeper's mock board.
`scripts/local/inferops.ts` runs that revision's API from source, seeded, headless, with no
`bun run bootstrap` and no cloud credential. The architecture page
(`docs/architecture/local-development.md`, "InferOps test backend") is the contract; this is the
procedure.

## Before you start

1. Use a clean shell: `env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bash` is enough. `up` refuses
   a shell holding cloud, deploy or model-provider credentials (by name) and reports a gatekeeper
   wiring already present in the shell, `.env.worktree`, `.dev.vars`, `.env` or the gatekeeper's
   own `.dev.vars`.
2. The sibling inferops repository must exist (`../inferops` beside the InferOS main checkout, or
   `INFEROPS_REPO=<path>`) and hold the pinned SHA; `up` fetches it otherwise.
3. Work in a `pnpm wt` worktree when another InferOS stack is up on this machine: the backend is
   per stack port (API on port + 10000, database `inferos_<port>`), so two checkouts on 8787 would
   share one.

## Procedure

1. `pnpm -s local inferops up --json`. First run: the managed worktree under `.inferops/` is
   created and installed (about a minute), the database is prepared (init-db, migrate, seed,
   reserved seed) and the API comes up; later runs reuse the database and take about 10 s. Read
   `apiUrl`, `revision`, `database`, `signIn`. A running backend is adopted; `--fresh`, another
   `--rev` or another `--dir` needs `pnpm local inferops down` first.
2. `pnpm -s local inferops verify --json`. It must report `ok: true` with `stopgap` (the acme `ENG`
   board by bearer) and `signIn` (the grokbot `GROK` board through the stub SSO persona sign-in).
   A failing `sign-in` step with a 400 on `/authorize` means this stack's origin is not what the
   backend registered: check `VITE_BACKEND_HOST` and restart the backend.
3. Start InferOS wired to it, in another terminal of the same clean shell:
   - `pnpm local start --inferops -- --no-ui-watchers` for per-person sign-in. In the browser,
     "Continue with InferOps" opens the backend's persona page; sign in as `grokbot-owner`. The
     board reachable this way is `inferops://grokbot.operations/project/board/GROK`. No InferOps
     account is auto-provisioned in this mode, so `pnpm local seed` prepares everything but that.
   - `pnpm local start --inferops --stopgap -- --no-ui-watchers` for the ambient account on
     `inferops://acme.operations/project/board/ENG` (headless `pnpm local seed`, `pnpm local verify
     --board inferops://acme.operations/project/board/ENG`, `dev-verify.ts`).
   The two wirings are exclusive by the gatekeeper's rules; `pnpm local status` shows which one the
   stack runs under (`inferops.mode`, and the backend row with its `wiring`).
4. For the live suite: `eval "$(pnpm -s local inferops env --stopgap)"` then
   `pnpm --filter @gadgets/integration-tests test:run -- inferops-live`. The bearer is printed to
   that shell only. Steps `k` and `l` need an intake's pillars applied in the `knowledge` workspace
   first (the suite's header says so; the seeds do not do it), and step `m` fails today (the
   gatekeeper refuses the ENG binding in a new gadget, an open InferOS finding); the other eleven
   pass. Report that split, not "the live suite failed".
6. To prove the backend itself on a machine, run the repeatable proof instead of a hand session:
   `INFEROPS_BACKEND_LIVE=1 node --test scripts/local/inferops.live.test.ts` (its own port, 8797 by
   default; `INFEROPS_BACKEND_LIVE_PORT` changes it). It must pass before any claim that case 1 works.
5. Finish with `pnpm local stop` and `pnpm -s local inferops down` (`--purge` also drops the
   database and removes the managed worktree). `pnpm -s local inferops status --json` must then
   say `not-running` and the API port must be free.

## Running beside inferops' own sandboxes

inferops has the inverse: in an inferops checkout, `bun run dev inferos --path <InferOS checkout>`
once, then `bun run dev up` starts that InferOS on `8787 + offset × 100` beside its fleet, wired
to its API (`inferops sandbox status` shows the `inferos` row). Both directions run at once on one
machine without sharing a port, a database or a checkout: inferops uses `8080|8000|8001|8090|
3000-3002 + offset × 100` and `inferlab_<offset>`, its sidecar InferOS `8787 + offset × 100`; a
`pnpm wt` worktree here uses a block whose ports end in 10-79, its backend that port + 10000 and
`inferos_<port>`. Never point inferops' sidecar at a checkout that is already running its own
stack, and never run two backends from one InferOS checkout.

## Evidence and limits

- Report `inferops verify`'s JSON and, for browser flows, what the persona page and the board
  showed. Never paste a bearer; the reports carry none.
- The backend is the API alone (no InferOps web clients, no worker): board, issue, transition,
  approval and Wiki routes work; Operate cards, webhook delivery and the email lane do not run.
- A passing run proves this checkout against the pinned revision locally. It is not cloud parity,
  and no CI job runs it (it would need both repositories checked out).
- Moving the pin is a contract step: regenerate `scripts/consumer/project-board.schema.json`
  (`node scripts/consumer/generate-board-schema.ts ../inferops <sha>`) in the same change.
