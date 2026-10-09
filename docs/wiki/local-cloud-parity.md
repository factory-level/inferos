---
title: Local development and Cloudflare parity
updated: 2026-10-03
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

`verify` reports what an agent sees: `agentView.inferops` (the ambient InferOps account), `agentView.board` (the connection an agent gets as `env.INFEROPS_BOARD`, with the project, host, state and issue counts it just read) and `agentView.approvalQueue` (reachable, pending count). A failure names the step (`signIn`, `inferops`, `workspace`, `board`, `connect`) and the fix. `status` reports whether the gatekeeper is configured for `mock` or `live` InferOps (`INFEROPS_BASE_URL` in the shell, `.dev.vars` or `.env`) by presence only; it never reads or prints a credential. Against a live instance, pass `verify --board inferops://<tenant>.<workspace>/project/board/<KEY>` (for example `inferops://acme.operations/project/board/ENG` against the local InferOps seeds), naming one of the signed-in person's workspaces.

Local state is `.wrangler/state` under the checkout; `reset` names it, requires `--yes`, refuses while the recorded dev server runs, and leaves Wrangler's build scratch and logs alone. Seeded boards and pending moves live in the mock InferOps Durable Object, so they survive restarts and go away with `reset`. The dev server records its pid in `.wrangler/local/dev-server.json` while it runs; `stop` only ever signals that pid, and a listener this checkout did not record is reported, not touched.

Use synthetic settings and fixture accounts. A general upgrade, migration rollback or state-recovery command is not yet supplied. The [verification ledger](local-verification-evidence.md) distinguishes clean-pin proofs from earlier source overlays and records the exact scope of each result.

## Parity matrix

Each capability is placed in the column that describes how local development provides it. **Emulated** means the real code runs under the local runtime (workerd through Wrangler and Miniflare) with simulated platform services; **mocked** means a fake stands in for an external system; **remote** means local development reaches a real Cloudflare or provider resource; **cloud-only** is what only a deployment can establish. A mocked provider succeeding never shows that a real provider, plan or subscription supports the flow.

| Capability | Emulated | Mocked | Remote | Cloud-only |
| --- | --- | --- | --- | --- |
| Workers runtime | workerd runs every Worker's real bundle | — | — | Deployed limits, placement, release bundling |
| Router and frontend assets | Production router config: `ASSETS`, SPA fallback, worker-first paths | A fixture build stands in for `workshop-frontend/dist` in tests | — | Real hostname, TLS, the release's asset upload |
| `/api` Cap'n Web over WebSocket | Upgrade through the router to the Workshop | — | — | Edge WebSocket behaviour behind Access |
| Service bindings and RPC | Router → backend → gatekeeper bindings, `GatekeeperVendor` entrypoints | — | — | Deployed Worker names, preview ids, account wiring |
| Durable Objects | Local SQLite-backed state, alarms, restart persistence | — | — | Distributed placement, migrations on a live namespace, recovery |
| KV / R2 | Local simulated storage | — | — | Production consistency and permissions |
| InferOps / InferLab | — | `src/inferops-fake.ts` (tests); the gatekeeper's built-in demo data (`pnpm local`) | A live InferOps through `INFEROPS_BASE_URL` (`inferops-live.test.ts`, opt-in) | Live auth domains and network failures |
| OAuth and connect handoff | State, nonce, single-use ticket, staged reconnect, `redirect_uri` from `BASE_URL` | Provider `/authorize` and token endpoints | — | Provider redirect registration, real domains and grants |
| Cloudflare Access | — | `verifyCfAccessJwt` with a stub verifier (unit tests); the harness runs without Access | — | Real issuer, audience, policy and service tokens |
| Workers AI | — | The scripted model (`pnpm dev:mock-model`) | `--use-workers-ai-binding` adds the `WORKERS_AI` binding, which reaches the account | No fully local Workers AI execution |
| ChatGPT plan inference | — | — | Feasibility only | Personal Workers hosting eligibility remains unverified |
| Logs and traces | Captured runtime logs and redaction assertions | — | — | Trace lifecycle, dashboard ingestion, retention |
| Wrapper gatekeepers | Discovered and routed for local development | — | — | Release packaging (not implemented) |

### Local evidence

Every local row above is evidenced by a test that runs without a network: the harness fails on any external request that no fake answers.

| Evidence | What it establishes |
| --- | --- |
| `packages/integration-tests/__tests__/router-parity.test.ts` | The production router as the primary Worker in front of the Workshop and the InferOps gatekeeper, over real HTTP: the app shell, a static asset and the SPA fallback (including `/connect/handoff`); `/api` worker-first; a `/gatekeeper/inferops/*` path reaching the gatekeeper while an unbound one falls through to the shell; the Cap'n Web WebSocket through the router; the InferLab connect flow through the router, with `redirect_uri` on the public origin; a board read recorded as an observation; one approval applied once and a second refused; a restart of all three Workers with the account, credentials, observation and a held proposal kept, the held proposal then applied once; and a reconnect after the restart. |
| `packages/integration-tests/__tests__/inferops-isolation.test.ts` | Stale revision, denied approval (permission refused at apply), revoked session and reconnect, a disconnected account's bindings failing, lost write responses replayed rather than reapplied, and the deployment switches across a gatekeeper reload. |
| `packages/integration-tests/__tests__/workshop-canvas.test.ts` | Durable views kept across a Workshop restart. |
| `packages/integration-tests/__tests__/connect-handoff.test.ts` | The connect handoff's ticket, nonce and single use. |
| `packages/integration-tests/__tests__/local-lifecycle-verify.test.ts` | The `pnpm local seed`/`verify` operators against the real Workers, offline. |
| `packages/router/__tests__/router.test.ts` | Routing rules and config integrity with stub bindings. |
| `scripts/consumer/gatekeepers.test.ts` | Wrapper gatekeeper discovery and router wiring with recording stubs. |

A wrapper's own gatekeeper is not booted by the harness: it needs a generated wrapper checkout and its build, which the repository has no fixture for. It is bound and routed by the same `GATEKEEPER_<NAME>` rule `router-parity.test.ts` exercises.

### Runtime and configuration versions

Recorded for the evidence above on 2026-10-03, at the lockfile of this repository:

| Component | Version |
| --- | --- |
| Wrangler | 4.138.0 |
| workerd | 1.20260921.1 |
| Miniflare | 5.20260921.1-alpha |
| `compatibility_date` (every Worker, from `scripts/worker-config.ts`) | 2026-09-04 |
| Node.js | 24.14.0 |
| pnpm | 11.17.0 |
| Vitest | 4.1.11 |

Re-record these when the lockfile or `COMPATIBILITY_DATE` changes and the evidence is rerun.

Cloudflare’s [development binding table](https://developers.cloudflare.com/workers/local-development/bindings-per-env/) distinguishes simulated local bindings from remote support; remote Durable Objects are not simply a direct substitute for local ones. Remote modes can reach actual account resources. [Local data guidance](https://developers.cloudflare.com/workers/local-development/local-data/) describes persistence and seeding; seed Durable Objects through their application API. [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) also retain invocation lifecycle constraints, so await calls rather than treating them as detached work.

## Cloud smoke recipe

`scripts/preview/smoke.ts` checks an already deployed instance from outside. It is a recipe, not part of CI, and it has **not been run against Cloudflare**; nothing in this repository runs it. It never deploys, creates, changes or deletes anything: every request is a GET or a WebSocket handshake closed at once, and it calls neither the Cloudflare API nor Wrangler.

1. Deploy a disposable instance, for example a preview with `node scripts/preview/preview.ts deploy` (see that script's header for the required account and Access settings), and note its router URL.
2. If the instance sits behind Cloudflare Access, create an Access service token allowed by its policy and export `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
3. Optionally, start a connect flow in the Workshop for each OAuth gatekeeper to check, and copy the popup's URL before signing in.
4. Run:

   ```bash
   node scripts/preview/smoke.ts https://<preview>-router.<subdomain>.workers.dev \
     [--gatekeeper inferops]... [--connect-url <popup URL>]... [--timeout 15000]
   ```

5. Tear the instance down with `node scripts/preview/preview.ts delete`.

It prints one JSON report (`ok`, `baseUrl`, `accessServiceToken`, `checks[]`) and exits 0 when every check passed, 1 when one failed and 2 on a usage error:

| Check | Passes when |
| --- | --- |
| `app-shell` | `/` is the HTML app shell and a client route returns the same shell (the SPA fallback). |
| `api` | A WebSocket handshake to `/api`, sent with the instance's own `Origin`, is upgraded, or is refused by an auth challenge (the Workshop's Access refusal, an Access login redirect, a 401 or a 403); a 404 or a 5xx fails. Only an upgrade or the Workshop's own refusal proves the backend was reached. |
| `gatekeeper:<name>` | `/gatekeeper/<name>/` answers from the gatekeeper: not the app shell (an unbound route falls through to it) and not a 502–504. Defaults to every gatekeeper package this checkout deploys. |
| `oauth:<name>` | For each `--connect-url`, the provider redirect's `redirect_uri` is on the base URL's origin under `/gatekeeper/<name>/`. Skipped without a connect URL. Fetching it starts one sign-in attempt, which expires unused; the report never prints the URL, since a connect URL is a bearer capability. |
| `opener-policy` | The app shell (`/`) and a client route carry `Cross-Origin-Opener-Policy: same-origin`. Confirms the deploy applied `_headers`; see [platform pillars](../architecture/platform-pillars.md#cross-origin-opener-policy). |

Without a service token, every path but `/api` is expected to be challenged by Access, and those checks fail saying so. `scripts/preview/smoke.test.ts` covers the checks against a local fake deployment.

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

Fixture verification should prove: clean clone → config generation → startup → authenticated RPC → board read → proposed transition → approval → authoritative refresh → restart persistence → shutdown. `pnpm local start|seed|verify|stop` covers startup through the proposed transition (one pending move) and shutdown for the in-repo stack, and `local-lifecycle-verify.test.ts` runs its operators offline.

Automated in the harness, through the production router (`router-parity.test.ts`) or directly (`inferops-isolation.test.ts`): authenticated RPC, the board read as an observation, approval applied once with a second approval refused, the authoritative refresh (InferOps' issue state and revision after apply), restart persistence of the Workshop's and the gatekeeper's Durable Objects with a held approval applied after the restart, reconnect, stale revision, denied approval, a revoked session and a disconnected account (the revoked capability). A second wrapper side by side is covered for discovery and routing by `scripts/consumer/gatekeepers.test.ts`, not by booting two stacks. Still manual: a clean clone through `pnpm local start` timed end to end, and anything in the cloud-only column. Cloud smoke runs use explicitly provisioned disposable resources and report separately from local results.
