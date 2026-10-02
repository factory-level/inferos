---
title: Local development and Cloudflare parity
updated: 2026-10-01
---

# Local development and Cloudflare parity

Existing commands, proposed wrapper behavior and the limits of emulation.

## Steps

Current commands run from the InferOS repository, not yet from a generated consuming wrapper:

```bash
pnpm install --frozen-lockfile
pnpm configs:check
pnpm dev-server
```

Run `pnpm dev-client` in a second terminal for the Vite frontend. `pnpm run-local` is the existing convenience install/build/run flow. Read `package.json` for the pinned pnpm version and `scripts/run-local.ts` before choosing that flow. The proposed lifecycle JSON interface in the design is not an existing command.

Use synthetic local settings and fixture accounts. Do not copy production tokens into test fixtures. The current default frontend/backend ports are 3000/8787; the wrapper work must expose collision-free overrides. A running port alone is not application readiness.

## Parity matrix

| Capability | Local evidence available | Cloud-only or unresolved evidence |
| --- | --- | --- |
| Workers JavaScript runtime | Wrangler uses workerd through local tooling | Deployed limits, placement and release configuration |
| Durable Objects | Local state and alarms can be exercised | Distributed production behavior, operational recovery and deployment migrations |
| KV/R2 | Local simulated storage and seeded objects | Production consistency, permissions and service behavior |
| Service bindings / RPC | Multi-worker calls with real contracts | Correct deployed names, entrypoints and account wiring |
| Router and frontend | Working-tree run-local derives asset ownership, ASSETS binding and route precedence from the production router | The pinned baseline predates this fix; deployed origin/auth/bindings still require cloud proof |
| External InferOps | Synthetic fixture API and negative permission cases | Live auth, domain version and network failures |
| OAuth/handoff | State, nonce, single-use and staged reconnect tests | Provider redirect registration, real domains and token grants |
| Cloudflare Access | Controlled auth fixtures | Real issuer/audience and Access policy |
| Workers AI | Explicit remote binding mode | No fully local model execution through the Workers AI binding |
| ChatGPT plan inference | Mock request/stream and supported local proof | Personal Workers hosting eligibility remains unverified |
| Logs/traces | Local event assertions and redaction checks | Deployed trace lifecycle, dashboard ingestion and retention |

Cloudflare’s [development binding table](https://developers.cloudflare.com/workers/local-development/bindings-per-env/) distinguishes simulated local bindings from remote support; remote Durable Objects are not simply a direct substitute for local ones. Remote modes can reach actual account resources. [Local data guidance](https://developers.cloudflare.com/workers/local-development/local-data/) describes persistence and seeding; seed Durable Objects through their application API. [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) also retain invocation lifecycle constraints, so await calls rather than treating them as detached work.

## Proposed consuming layout

```text
consumer/
  inferos/                 # pinned submodule
  deployment.jsonc         # candidate nonsecret wrapper config
  gatekeepers/             # wrapper-owned extensions
  blueprints/              # wrapper-owned artifacts
  .agents/skills/          # installed/pinned setup guidance
  scripts/                # deterministic wrapper operations
```

Names outside the submodule are proposed and must be validated against the [upstream starter](https://github.com/cloudflare/cloudflare-os-starter). They are not an existing InferOS generator output.

## Verification contract

Fixture verification should prove: clean clone → config generation → startup → authenticated RPC → board read → proposed transition → approval → authoritative refresh → restart persistence → shutdown. Record runtime versions, elapsed startup, request counts and failure evidence. Test an unexpected external request, second wrapper, stale revision, denied approval and revoked capability. Cloud smoke tests use explicitly provisioned disposable resources and report separately from local results.
