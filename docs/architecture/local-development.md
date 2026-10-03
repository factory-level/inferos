---
title: Cloudflare-like local development
covers:
  - scripts/run-dev-server.ts
  - scripts/run-local.ts
  - scripts/dev
  - packages/workshop-backend/scripts/dev-setup.ts
  - packages/workshop-backend/scripts/dev-verify.ts
  - packages/workshop-backend/scripts/dev-workshop.ts
  - scripts/local
  - packages/workshop-shared/src/password-salt.ts
  - scripts/dev-server-config.ts
  - cloudflare.config.ts
  - scripts/worker-config.ts
  - scripts/worker-dirs.ts
  - custom-gatekeepers
  - packages/router
  - packages/integration-tests
updated: 2026-10-02
---

# Cloudflare-like local development

## Overview

The in-repo stack as of `main` at `4a4504c`: `pnpm dev-server`/`pnpm run-local` start every Worker under one Wrangler process, `pnpm dev:setup` and `pnpm dev:mock-model` prepare a test-ready Workshop ([#42](https://github.com/factory-level/inferos/pull/42)), and `pnpm local` is a machine-readable lifecycle for this checkout ([#95](https://github.com/factory-level/inferos/pull/95)). Wrapper-aware topology ([#9](https://github.com/factory-level/inferos/issues/9)) and cloud parity ([#11](https://github.com/factory-level/inferos/issues/11)) are not implemented. Proposed work is recorded in the [design](../design/local-development.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/run-dev-server.ts` | Discovers configured workers, generates dev wiring, builds gatekeeper UIs and starts Wrangler/watchers. |
| `scripts/run-local.ts` | Convenience local install/build/run flow. |
| `scripts/local/lifecycle.ts`, `scripts/local/stack.ts` | `pnpm local <command>`: status, start, stop, seed, verify, reset and logs for this checkout's stack, with JSON reports and stable exit codes. |
| `packages/workshop-backend/scripts/dev-setup.ts` | `pnpm dev:setup`: prepares a running local Workshop (account, onboarding, mock model, InferOps, demo screen). |
| `packages/workshop-backend/scripts/dev-verify.ts` | `pnpm dev:verify`: readiness over the authenticated RPC, reported as what an agent sees (InferOps account, board read, approval queue). |
| `packages/workshop-backend/scripts/dev-workshop.ts` | What the two operator scripts share: local-only URL check, the browser's password hash, the RPC connection, and finding the seeded workspace and board connection. |
| `scripts/dev/scripted-model.ts` | `pnpm dev:mock-model`: a scripted, credential-free stand-in model for local agent flows. |
| `scripts/worker-config.ts` | Shared canonical Worker configuration factory. |
| `packages/router` | Public routing and frontend assets/backend fallback. |
| `packages/integration-tests` | Real Workers and RPC test harness with external network interception. |

## Data and Control Flow

The repository already has multi-worker Wrangler development and a Vite frontend. Discovery requires a wrangler.jsonc, so gatekeeper-kit is not a Worker. The dev runner scans this repository’s `packages/` and `custom-gatekeepers/` (the fork’s own gatekeepers), both listed once in `scripts/worker-dirs.ts`, which config generation, worker types, the release manifest and previews also use; a package name present in both is rejected. Arbitrary wrapper-owned gatekeeper directories outside this repository are still not a supported discovery contract. The integration harness exercises real RPC and Workers, but is not a consuming-repository bootstrap product. `run-local` assigns frontend assets to the public router, deriving the ASSETS binding, SPA fallback and worker-first paths from the generated production router configuration, and the backend receives no second assets configuration. Normal Vite development (`pnpm dev-server` plus `pnpm dev-client`) still serves the frontend on its separate port.

Before starting Wrangler, `run-dev-server.ts` also resolves the InferOps switches and optional local integrations described under [Configuration](#configuration), and records its pid for `pnpm local stop`.

## Preparing a local instance

`pnpm dev:setup` drives a running local Workshop over the same Cap'n Web API the browser uses, so neither a person nor an agent clicks through signup, onboarding and settings before testing. It signs in as `dev`/`devpassword` (the `VITE_DEV_AUTO_LOGIN` defaults; `--user`/`--password` override), creating the account on first run. The password hash is derived exactly as the browser derives it (Argon2id over `SERVICE_SALT` plus the username, via Node's `crypto.argon2Sync`), so the same credentials work on the login page; `SERVICE_SALT` lives in its own import-free `password-salt.ts` so Node tooling can import it. It then marks onboarding complete and, on request:

- `--mock-model [url]` registers the scripted model as an Ollama model (default `http://localhost:11434`) and makes it the preferred model. `pnpm dev:mock-model` serves it: it answers in the OpenAI-compatible format and plays the agent's side of "add an InferOps Kanban to this canvas", choosing each step from the conversation so far. Every action it triggers runs through the real Workshop and gatekeepers.
- `--inferops` opts into the auto-provisioned InferOps gatekeeper (mock data).
- `--screen <templateId>` ensures an "InferOps Canvas demo" workspace with a screen from that catalog template, and reports its URL.

Every step is idempotent. The JSON report includes the session token, which a browser (or a browser-driving agent) adopts with `localStorage.setItem("authToken", token)`. The command refuses any host but localhost or 127.0.0.1.

## Lifecycle commands

`pnpm local <command>` (`scripts/local/lifecycle.ts`) is the machine-readable lifecycle of this checkout's stack. Every command takes `--json` (one JSON object on stdout; without it a headline precedes the same object, pretty-printed) and `--port N`, resolved by the dev server's own rules (`getDevServerConfig`: `--port`, else `VITE_BACKEND_HOST`, else 8787). Exit codes are 0 for a passed check, 1 for a failed one and 2 for a usage error. pnpm appends its own `ELIFECYCLE` line to stdout on a non-zero exit, so a consumer parses stdout's first line or runs `node scripts/local/lifecycle.ts` directly.

| Command | What it does | Fails (exit 1) when |
| --- | --- | --- |
| `status` | Probes the port, then every configured Worker through the router (`/`, `/api`, `/gatekeeper/<name>`: any answer is `up`, including a 500 an RPC-only gatekeeper throws for lack of a `fetch()`; a 502/503/504 from the dev proxy is `error`; no answer is `down`). Reports the recorded dev server, the InferOps mode (`mock`, or `live` when `INFEROPS_BASE_URL` is set in the shell, `.dev.vars` or `.env`, naming only which of `INFEROPS_API_TOKEN`/`INFEROPS_WORKSPACE_ID`/`INFEROPS_WORKSPACE_SLUG` are missing, never a value), the state directory and the Wrangler log directory. | Nothing listens, a Worker is not `up`, or a live connection is incomplete. |
| `start [-- flags]` | Checks the port on both loopback families (`assertLocalPortAvailable`) and then runs `scripts/run-local.ts --port N` in the foreground with the flags after `--`. It is a thin wrapper: the stack is run-local and run-dev-server. | The port is busy (naming this checkout's own dev server when its record owns it). |
| `stop` | Sends SIGTERM to the pid in `.wrangler/local/dev-server.json`, which `run-dev-server.ts` writes at startup and removes on exit, and waits up to 30 s for it to be gone; the dev server's own handlers tear down Wrangler and the watchers. | The process survives the wait, or something listens that this checkout did not record (it is never signalled). |
| `seed [--screen ID] [--no-approval]` | Runs `dev-setup.ts --mock-model --inferops [--screen ID]` (the screen is the explicit id, else the first screen in `inferos.canvas.json`, else skipped), then `dev-verify.ts --ensure-board [--approval-scenario]`. The session token is dropped from the report. | Nothing listens, or either operator fails; the report names the step. |
| `verify [--board URL]` | Runs `dev-verify.ts` and passes its report through. | Any readiness step fails. |
| `reset --yes` | Deletes `.wrangler/state` (Wrangler's Durable Object, KV, R2 and cache state; the dev server starts Wrangler from the repo root, so every Worker's state lives there) and the dev-server record, nothing else. | `--yes` is missing, or the recorded dev server is still running. |
| `logs [--lines N]` | Reports Wrangler's log directory (`WRANGLER_LOG_PATH`, else `logs/` under its global config directory, which is per user, not per checkout) and the newest file's tail. The terminal running `start` holds the request log. | Never. |

A generated wrapper's `pnpm local` runs this operator from its pinned submodule, with the wrapper's `local.port`; `start` adds `--consumer-root <wrapper>` after the wrapper's own startup refusals, and `seed` defaults `--screen` to the wrapper's first screen template ([consumer configuration](consumer-configuration.md#data-and-control-flow), [walkthrough](../wiki/consumer-bootstrap.md#wrapper-pnpm-local)).

`stack.ts` holds the inspection: port probing, Worker discovery mirroring `run-dev-server.ts` (every `gatekeeper-*` package with a `wrangler.jsonc`, the fork's own gatekeepers filtered by `inferos.canvas.json`), the record file, the state directory and the log location. `lifecycle.ts` takes its process, network and subprocess access as an injectable `LifecycleDeps`, so `scripts/local/lifecycle.test.ts` covers usage errors, the status JSON shape, a stopped and a degraded stack, an occupied port, repeated seeding, failure attribution, reset boundaries, stop, record ownership and log tailing without a running Workshop.

## Readiness as an agent sees it

`pnpm dev:verify` (`dev-verify.ts`) treats an open port as nothing: readiness is an authenticated RPC plus a board read through a gatekeeper connection. It signs in as the same local user (`login` only; it never creates an account), confirms the InferOps account among the connected accounts, opens the `InferOps Canvas demo` workspace, finds the connection to the board URL (default `inferops://demo.local/project/board/DEMO`), opens a session on it, reads the board (which the gatekeeper records as an observation) and lists the pending actions. The report's `agentView` is what an agent would find: `inferops` (connected, account id, display name, `mock` for the demo host or `live` otherwise), `board` (connection id, `suggestedBindingName` `INFEROPS_BOARD`, `tsType`, project, host, state and issue counts) and `approvalQueue` (reachable, pending count). A failed step is reported as `{ ok: false, step, error }` with the hint to run `pnpm local seed`.

The connection is found through the native action log rather than a file: every read through a connection is recorded as an observation carrying the connection's id and resource URL, so `findConnectionByResourceUrl` pages `listActions` until it meets one. That keeps the lookup in the state a reset clears, and makes seeding idempotent. With `--ensure-board` (what `seed` passes) a missing workspace or connection is created; with `--approval-scenario` one issue move is proposed through the session (the first issue that has a later state in its own workflow) only while no move from that connection is pending, so the approval queue holds exactly one synthetic action to review, repeatably. The mock data source keeps each account's demo board in a Durable Object, so seeded boards and pending moves survive restarts and go away with `reset`.

`packages/integration-tests/__tests__/local-lifecycle-verify.test.ts` runs both operator scripts as subprocesses against the real Workshop and the real InferOps gatekeeper (mock data) under `createTestHarness` with the `NetworkInterceptor` installed: verify fails closed before seeding (naming `signIn`, `inferops`, `workspace`), seeding twice finds the same connection and leaves one pending move, the token and password never reach the output, and the escape list is empty, which is what "an offline fixture run makes no external request" means here. The gatekeeper is validated into its own `.wrangler` by the `build:inferops-gatekeeper` task (after its configurator UI is built) before the suite starts, the same way the fixture gatekeeper is.

## Configuration

cloudflare.config.ts is authoritative; pnpm configs:generate emits wrangler.jsonc. The default frontend and backend ports are 3000 and 8787. A root `.dev.vars`, then a root `.env`, fill variables the shell has not set. Remote Workers AI requires account access. See the [settings](../wiki/configuration-reference.md) and [parity](../wiki/local-cloud-parity.md) wiki pages.

The dev server resolves these before it writes the per-Worker dev configs:

- **InferOps integration.** `resolveInferOpsEnabled` (`scripts/dev-server-config.ts`) takes a version 2 wrapper's `INFEROPS_ENABLED` capability, else the shell's `INFEROPS_ENABLED` (default on), and passes `"true"` or `"false"` to the gatekeeper, which enforces it ([#103](https://github.com/factory-level/inferos/pull/103)). A wrapper that turns the capability on while `inferos.canvas.json` leaves the gatekeeper out stops startup. `INFEROPS_BASE_URL`, and the local-development stopgap `INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID` and `INFEROPS_WORKSPACE_SLUG`, pass through from the shell to the gatekeeper; without a base URL the gatekeeper serves its built-in demo data.
- **Sign in with InferLab.** A wrapper's `INFEROPS_AUTH` (or version 1 `features.inferlabLogin`) adds `inferops` to `AUTH_GATEKEEPERS` and sets `INFERLAB_AUTH_ORIGIN`; in-repo, both come from the shell. An inconsistent combination stops startup. Details are in [consumer configuration](consumer-configuration.md#inferops-backed-sign-in).
- **ChatGPT plan usage.** `ENABLE_OPENAI_ASSISTANT_PLUGIN=true` starts the local Bun companion and wires it to the backend; `ANTHROPIC_API_KEY` enables managed local API-key models. Both write their secrets to the backend's `.dev.vars` and remove them on exit ([#40](https://github.com/factory-level/inferos/pull/40)). See [ChatGPT connection](chatgpt-connection.md).
- The backend always runs with `DEV` set, so UI flags resolve to their `dev` values.

## Divergences from Design

- Wrapper discovery and a reviewed topology parity contract remain planned. A generated wrapper exposes `pnpm local` by delegating to the pinned operator (see [consumer configuration](consumer-configuration.md#data-and-control-flow)), which runs from the submodule: `status` lists the Workers the pinned checkout would bind rather than the wrapper's custom Workers, and `status` reads InferOps connection variables from the shell and the submodule's local env files, not the wrapper's.
- `stop` relies on the dev server's record file; a stack started by other means (or before this change) is reported but never signalled. Startup-failure cleanup remains the dev server's own responsibility (its pre-flight and signal handlers), not a lifecycle command.
- Offline interception of external traffic is enforced in the integration harness, where Worker subrequests pass through Node. `pnpm local verify` against a running Wrangler cannot intercept the Workers' own traffic; it reports the configured mode instead.
- `seed` creates the demo canvas screen only when `inferos.canvas.json` declares one; the synthetic board itself comes from the InferOps gatekeeper's mock data, which is the "mock business operations" the MVP note on #10 excludes from the final walkthrough.

## Open Questions

- Choose the wrapper configuration schema after comparing the upstream starter contract with this fork.
- Wrapper extension discovery, cloud auth and real binding parity still need proof.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
