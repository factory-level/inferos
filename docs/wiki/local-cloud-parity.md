---
title: Local development and Cloudflare parity
updated: 2026-10-02
---

# Local development and Cloudflare parity

Current wrapper commands, native development alternatives and the limits of local verification.

## Steps

Generated consumers use the pinned native runtime through wrapper commands:

```bash
pnpm inferos:check
pnpm run setup
pnpm run doctor
pnpm fixtures:check
pnpm views:check
pnpm blueprints:check
pnpm dev
```

See [bootstrap instructions](consumer-bootstrap.md) for an exact supported pin. Set `local.port` in `inferos.config.json` before startup; the wrapper rejects an occupied port and does not stop unrelated processes. `pnpm dev` installs frozen dependencies, builds frontend assets and starts the native multi-Worker runtime on that origin. Explicitly enabled custom Workers use the same router. Canonical Worker configs remain authoritative; never hand-edit generated Wrangler files.

For platform development directly in InferOS, run `pnpm install --frozen-lockfile`, `pnpm configs:check`, and `pnpm dev-server`, with `pnpm dev-client` in a second terminal for Vite. `pnpm run-local` provides the native install/build/run convenience flow. A passing doctor is preflight evidence rather than running-service health; running-service health is `pnpm local status` and `pnpm local verify` below.

## Lifecycle of the in-repo stack

`pnpm local <command>` wraps the stack with JSON reports (`--json`) and stable exit codes (0 passed, 1 failed, 2 usage). All commands take `--port N`; the default is the dev server's (`VITE_BACKEND_HOST`, else 8787). On a non-zero exit pnpm appends an `ELIFECYCLE` line to stdout, so parse the first line or call `node scripts/local/lifecycle.ts` directly.

```bash
pnpm local start                 # port check, then scripts/run-local.ts in the foreground
pnpm local status --json         # exit 0 only when every Worker answers through the router
pnpm local seed                  # account dev/devpassword, mock model, InferOps account, demo screen, board connection, one pending move
pnpm local verify --json         # sign in, read the demo board through the gatekeeper, count pending approvals
pnpm local logs --lines 100      # Wrangler's newest debug log; the start terminal holds the request log
pnpm local stop                  # SIGTERM to the recorded dev server, wait for it to exit
pnpm local reset --yes           # delete .wrangler/state; refused while the stack runs
```

A fresh checkout is: `pnpm install --frozen-lockfile`, `pnpm local start` in one terminal, then `pnpm local seed` and `pnpm local verify` in another. `seed` is idempotent, so run it again after a restart or a reset. The demo screen is only created when `inferos.canvas.json` declares a screen template (`pnpm canvas init`, `pnpm canvas add-screen ...`, restart); otherwise `seed` reports it skipped and the workspace and board connection are still prepared. `pnpm dev:mock-model` serves the scripted model `seed` registers, so a chat works with no model credentials.

`verify` reports what an agent sees: `agentView.inferops` (the ambient InferOps account), `agentView.board` (the connection an agent gets as `env.INFEROPS_BOARD`, with the project, host, state and issue counts it just read) and `agentView.approvalQueue` (reachable, pending count). A failure names the step (`signIn`, `inferops`, `workspace`, `board`, `connect`) and the fix. `status` reports whether the gatekeeper is configured for `mock` or `live` InferOps (`INFEROPS_BASE_URL` in the shell, `.dev.vars` or `.env`) by presence only; it never reads or prints a credential. Against a live instance, pass `verify --board inferops://<host>/project/board/<KEY>`.

Local state is `.wrangler/state` under the checkout; `reset` names it, requires `--yes`, refuses while the recorded dev server runs, and leaves Wrangler's build scratch and logs alone. Seeded boards and pending moves live in the mock InferOps Durable Object, so they survive restarts and go away with `reset`. The dev server records its pid in `.wrangler/local/dev-server.json` while it runs; `stop` only ever signals that pid, and a listener this checkout did not record is reported, not touched.

Use synthetic settings and fixture accounts. A general upgrade, migration rollback or state-recovery command is not yet supplied. The [verification ledger](local-verification-evidence.md) distinguishes clean-pin proofs from earlier source overlays and records the exact scope of each result.

## Parity matrix

| Capability | Local evidence available | Cloud-only or unresolved evidence |
| --- | --- | --- |
| Workers JavaScript runtime | Wrangler uses workerd through local tooling | Deployed limits, placement and release configuration |
| Durable Objects | Local state and alarms can be exercised | Distributed production behavior, operational recovery and deployment migrations |
| KV/R2 | Local simulated storage and seeded objects | Production consistency, permissions and service behavior |
| Service bindings / RPC | Multi-worker calls with real contracts | Correct deployed names, entrypoints and account wiring |
| Router and frontend | Supported pinned run-local derives asset ownership, ASSETS binding and route precedence from the production router; clean-pin browser proofs exist | Older pins lack the fix; deployed origin/auth/bindings still require cloud proof |
| External InferOps | The InferOps gatekeeper's mock board is read over the real RPC and gatekeeper path (`pnpm local verify`, and the harness suite with external traffic intercepted); a live instance via `INFEROPS_BASE_URL` | Live auth, domain version and network failures |
| OAuth/handoff | State, nonce, single-use and staged reconnect tests | Provider redirect registration, real domains and token grants |
| Cloudflare Access | Controlled auth fixtures | Real issuer/audience and Access policy |
| Workers AI | Explicit remote binding mode | No fully local model execution through the Workers AI binding |
| ChatGPT plan inference | Feasibility research only; no supported subscription inference flow proven | Personal Workers hosting eligibility remains unverified |
| Logs/traces | Local event assertions and redaction checks | Deployed trace lifecycle, dashboard ingestion and retention |

Cloudflare’s [development binding table](https://developers.cloudflare.com/workers/local-development/bindings-per-env/) distinguishes simulated local bindings from remote support; remote Durable Objects are not simply a direct substitute for local ones. Remote modes can reach actual account resources. [Local data guidance](https://developers.cloudflare.com/workers/local-development/local-data/) describes persistence and seeding; seed Durable Objects through their application API. [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) also retain invocation lifecycle constraints, so await calls rather than treating them as detached work.

## Generated consuming layout

```text
consumer/
  inferos/                 # exact pinned submodule
  inferos.config.json      # nonsecret profile, features, style, data mode and port
  inferos.extensions.json  # explicitly listed custom Workers
  .inferos/                # copied wrapper command/parser helpers
  fixtures/                # canonical synthetic board JSON
  views/                   # portable composition definitions
  workers/                 # wrapper-owned canonical Worker sources
  gatekeepers/             # extension location; no InferOps gatekeeper yet
  blueprints/              # copied editable native output formats
  profiles/                # reserved customization location
  .agents/skills/          # bootstrap guidance
```

These paths are generated by `scripts/consumer/bootstrap.ts`. Reruns preserve wrapper edits and never silently upgrade the pin. Consumer cloud release composition and required-input wiring remain pending; local custom routes do not prove deployed bindings.

## Verification contract

Fixture verification should prove: clean clone → config generation → startup → authenticated RPC → board read → proposed transition → approval → authoritative refresh → restart persistence → shutdown. `pnpm local start|seed|verify|stop` covers startup through the proposed transition (one pending move) and shutdown for the in-repo stack, and the harness suite `local-lifecycle-verify.test.ts` fails on an unexpected external request. Approval, authoritative refresh, restart persistence under test, a second wrapper, stale revision, denied approval and revoked capability are still manual or untested. Record runtime versions, elapsed startup, request counts and failure evidence. Cloud smoke tests use explicitly provisioned disposable resources and report separately from local results.
