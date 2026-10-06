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
  - scripts/consumer/gatekeepers.ts
  - custom-gatekeepers
  - packages/router
  - packages/integration-tests
  - scripts/preview/smoke.ts
  - scripts/preview/smoke.test.ts
  - scripts/views
  - packages/workshop-frontend/views.json
  - packages/workshop-frontend/src/demo
updated: 2026-10-05
---

# Cloudflare-like local development

## Overview

The in-repo stack as of `main` at `4a4504c`: `pnpm dev-server`/`pnpm run-local` start every Worker under one Wrangler process, `pnpm dev:setup` and `pnpm dev:mock-model` prepare a test-ready Workshop ([#42](https://github.com/factory-level/inferos/pull/42)), and `pnpm local` is a machine-readable lifecycle for this checkout ([#95](https://github.com/factory-level/inferos/pull/95)). Wrapper-owned gatekeepers are discovered for local development ([#9](https://github.com/factory-level/inferos/issues/9), see [wrapper topology](#wrapper-topology)). For local-to-cloud parity ([#11](https://github.com/factory-level/inferos/issues/11)), the production router's request path is exercised in workerd and an opt-in smoke recipe checks a deployed instance (see [router-path parity](#router-path-parity)); wrapper-aware cloud packaging is not implemented. Proposed work is recorded in the [design](../design/local-development.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/run-dev-server.ts` | Discovers configured workers, generates dev wiring, builds gatekeeper UIs and starts Wrangler/watchers. `--no-ui-watchers` (also through `pnpm local start -- --no-ui-watchers`) skips the per-gatekeeper configurator and app UI watcher processes, each of which holds an inotify instance, for machines near `fs.inotify.max_user_instances`; the UIs are still built once at startup. |
| `scripts/run-local.ts` | Convenience local install/build/run flow. |
| `scripts/local/lifecycle.ts`, `scripts/local/stack.ts` | `pnpm local <command>`: status, start, stop, seed, verify, reset and logs for this checkout's stack, with JSON reports and stable exit codes. |
| `scripts/local/coding.ts`, `scripts/local/runner.ts` | `pnpm local runner start\|status\|stop` and `pnpm local coding doctor`: the InferOps coding runner for a wrapper (see [local coding workflows](local-coding-workflows.md#runner-lifecycle)). |
| `packages/workshop-backend/scripts/dev-setup.ts` | `pnpm dev:setup`: prepares a running local Workshop (account, onboarding, mock model, InferOps, demo screen). |
| `packages/workshop-backend/scripts/dev-verify.ts` | `pnpm dev:verify`: readiness over the authenticated RPC, reported as what an agent sees (InferOps account, board read, approval queue). |
| `packages/workshop-backend/scripts/dev-workshop.ts` | What the two operator scripts share: local-only URL check, the browser's password hash, the RPC connection, and finding the seeded workspace and board connection. |
| `scripts/dev/scripted-model.ts` | `pnpm dev:mock-model`: a scripted, credential-free stand-in model for local agent flows. |
| `scripts/worker-config.ts` | Shared canonical Worker configuration factory. |
| `scripts/worker-dirs.ts` | Worker discovery roots: this checkout's `packages/` and `custom-gatekeepers/`, plus a wrapper's `gatekeepers/` when a consumer root is passed. |
| `scripts/consumer/gatekeepers.ts` | Validates, generates and drift-checks a wrapper's own gatekeepers for local development. |
| `packages/router` | Public routing and frontend assets/backend fallback. |
| `packages/integration-tests` | Real Workers and RPC test harness with external network interception; optionally boots the production router as the primary Worker. |
| `scripts/preview/smoke.ts` | Opt-in, read-only smoke check of a deployed instance's public origin (app shell, `/api` handshake, gatekeeper routes, OAuth redirect origins). |
| `scripts/views/views.ts`, `packages/workshop-frontend/views.json` | `pnpm views`: the registry of every Workshop frontend view and subview, and the commands that list, show, locate, open and check them (see [frontend view registry and demo mode](#frontend-view-registry-and-demo-mode)). |
| `packages/workshop-frontend/src/demo` | Demo mode: in-page fixture targets that serve the frontend's RPC with no Workers, sign-in or setup, plus per-view scenarios and the demo screen picker. |

## Data and Control Flow

The repository already has multi-worker Wrangler development and a Vite frontend. Discovery requires a wrangler.jsonc, so gatekeeper-kit is not a Worker. The dev runner scans this repository’s `packages/` and `custom-gatekeepers/` (the fork’s own gatekeepers), both listed once in `scripts/worker-dirs.ts`, which config generation, worker types, the release manifest and previews also use; a package name present in both is rejected. A wrapper's own `gatekeepers/` directory is a third root only when a caller passes the wrapper explicitly (see [wrapper topology](#wrapper-topology)); nothing infers one from the working directory. The integration harness exercises real RPC and Workers, but is not a consuming-repository bootstrap product. `run-local` assigns frontend assets to the public router, deriving the ASSETS binding, SPA fallback and worker-first paths from the generated production router configuration, and the backend receives no second assets configuration. Normal Vite development (`pnpm dev-server` plus `pnpm dev-client`) still serves the frontend on its separate port.

Before starting Wrangler, `run-dev-server.ts` also resolves the InferOps switches and optional local integrations described under [Configuration](#configuration), and records its pid for `pnpm local stop`.

## Wrapper topology

A consumer wrapper ([consumer configuration](consumer-configuration.md)) runs the pinned submodule's dev server with `--consumer-root <wrapper>`. Besides the extension Workers, that root contributes the wrapper's own gatekeepers, without any file in the pinned checkout changing:

- **Discovery.** `workerPackageDirs(root, { consumerRoot })` adds each child of `<wrapper>/gatekeepers/` (`consumerGatekeeperDirs`). Without `consumerRoot` the result is exactly the pinned checkout's packages, so the release manifest, worker types, `configs:check` and previews are unchanged. The `gatekeepers/` directory, each child and each child's `wrangler.jsonc`/`cloudflare.config.ts` must not be symbolic links, and every child must resolve inside `gatekeepers/`. A child holding a Worker config must be named `gatekeeper-<lowercase-slug>`, the form the router maps back from its `GATEKEEPER_<NAME>` binding; any child whose name a pinned package already uses is rejected. A child with neither config file is a library and never runs, the same `wrangler.jsonc` rule as in-repo.
- **Switch.** `scripts/consumer/gatekeepers.ts` loads them only while the wrapper's `features.customCloudflareCode` is on; off, the directory is inert (nothing read, validated or imported), as the extension manifest is.
- **Manifest gate.** Discovery finds candidates; `readConsumerGatekeepers` decides which load, reading data only. A candidate loads when `inferos.config.json` lists its slug under `gatekeepers` with `enabled: true`, its `connection.json` validates against the package schema and names the same id, and it lists the pin's gatekeeper API level. Anything else is refused with a reason (unlisted and disabled as notices; missing, invalid, mismatched or incompatible contracts, and listed slugs with no directory, as errors), its `cloudflare.config.ts` is never imported and its config never generated. See [consumer configuration](consumer-configuration.md#consumer-workers).
- **Config generation.** Each accepted gatekeeper's `wrangler.jsonc` is generated in the wrapper from its `cloudflare.config.ts` by the same `renderWorkerConfig` the pinned checkout uses (`syncWorkerConfigs` in `generate-worker-configs.ts`). The rendered Worker name must equal the directory name, the entrypoint must stay inside the directory, and remote bindings are refused. `prepareConsumerGatekeepers` regenerates them when the dev server starts, the wrapper's `pnpm gatekeepers:generate` writes them, and `pnpm gatekeepers:check` exits 1 naming each file that differs from its source. `node scripts/generate-worker-configs.ts --check --consumer-root <wrapper>` checks the pinned and wrapper configs together; it is a config-drift tool and applies no manifest gate, so it renders every wrapper gatekeeper with a Worker config. At startup the dev server also writes a `wrangler.dev.jsonc` beside each one (its build directory and `BASE_URL`, absolute and port-specific); new wrappers' `.gitignore` excludes it, while the committed `wrangler.jsonc` stays tracked.
- **Wiring.** `run-dev-server.ts` appends the accepted ones to the gatekeeper list (and prints a warning per refused one), so each gets a dev config, a `GatekeeperVendor` binding on the backend, a router binding and a `BASE_URL` of `http://<host>/gatekeeper/<slug>` (`gatekeeperBaseUrl`) like any pinned gatekeeper. `getDevRouterConfig` (`dev-server-config.ts`) builds the router's dev config from the committed `dev-router`, every gatekeeper, the extension Workers and, in run-local, the production router's assets; it rejects two bindings with one name. Frontend assets, `/api`, `/gatekeeper/<slug>/*` and `/extensions/<id>` therefore share one origin, and an absent optional part (no extensions, no wrapper gatekeepers) contributes no binding, so its route answers 404 or falls through to the assets.
- **Isolation.** A wrapper's `pnpm dev` passes its own `local.port` (`devLaunchArgs` in `runtime.ts`), and Wrangler runs from the wrapper's own submodule, so its state is `<wrapper>/inferos/.wrangler/state`. Two wrappers therefore share neither port, state, generated configs nor gatekeepers, even when their gatekeepers have the same name.

`scripts/consumer/gatekeepers.test.ts` covers these rules with temporary wrappers: an absent directory and a library-only one, pinned discovery unchanged without a consumer root, generation into the wrapper, drift (never generated, source changed, hand edit, no TypeScript source) through the check CLI, name collisions and non-round-tripping names, symbolic links and an escaping entrypoint, the disabled switch, the manifest gate (unlisted, disabled, no contract, an invalid one, one carrying a credential value, a mismatched id, an incompatible or undeclared API level, a listed slug with no directory, and a valid one bound beside refused ones, with refused configs that throw if imported), a `workers/` Worker that is gatekeeper-named, holds a valid contract and is listed as a gatekeeper yet is never discovered as one, routing through the real `packages/router` handler with recording stubs for every binding of the generated dev router config, absent optional bindings, and two wrappers side by side.

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
| `status` | Probes the port and decides whose listener it is: `stack` is `running` only when this checkout's dev-server record is alive and was written for that port, `port-in-use-by-other` when something answers without such a record (an unrelated server on 8787 accepts the connection just the same), and `not-running` otherwise. Only `running` probes every configured Worker through the router (`/`, `/api`, `/gatekeeper/<name>`: any answer is `up`, including a 500 an RPC-only gatekeeper throws for lack of a `fetch()`; a 502/503/504 from the dev proxy is `error`; no answer is `down`). Reports the recorded dev server, the InferOps mode (`mock`, or `live` when `INFEROPS_BASE_URL` is set in the shell, `.dev.vars` or `.env`, naming only which of `INFEROPS_API_TOKEN`/`INFEROPS_WORKSPACE_ID`/`INFEROPS_WORKSPACE_SLUG` are missing, never a value), the state directory and the Wrangler log directory. | Nothing listens, the listener is `port-in-use-by-other` (reported with an `error` naming the port, and never probed), a Worker is not `up`, or a live connection is incomplete. |
| `start [-- flags]` | Checks the port on both loopback families (`assertLocalPortAvailable`) and then runs `scripts/run-local.ts --port N` in the foreground with the flags after `--`. It is a thin wrapper: the stack is run-local and run-dev-server. | The port is busy (naming this checkout's own dev server when its record owns it). |
| `stop` | Sends SIGTERM to the pid in `.wrangler/local/dev-server.json`, which `run-dev-server.ts` writes at startup and removes on exit, and waits up to 30 s for it to be gone; the dev server's own handlers tear down Wrangler and the watchers. | The process survives the wait, or something listens that this checkout did not record (it is never signalled). |
| `seed [--screen ID] [--no-approval]` | Runs `dev-setup.ts --mock-model --inferops [--screen ID]` (the screen is the explicit id, else the first screen in `inferos.canvas.json`, else skipped), then `dev-verify.ts --ensure-board [--approval-scenario]`. The session token is dropped from the report. | Nothing listens, the listener is not this checkout's (`stack: "port-in-use-by-other"`, no operator runs), or either operator fails; the report names the step. |
| `verify [--board URL]` | Runs `dev-verify.ts` and passes its report through. | The stack is not this checkout's running one (as for `seed`), or any readiness step fails. |
| `reset --yes` | Deletes `.wrangler/state` (Wrangler's Durable Object, KV, R2 and cache state; the dev server starts Wrangler from the repo root, so every Worker's state lives there) and the dev-server record, nothing else. | `--yes` is missing, or the recorded dev server is still running. |
| `runner start\|status\|stop [--consumer-root DIR] [--once]` | The local InferOps coding runner of a wrapper, detached and recorded in `.inferos/state/runner/` ([local coding workflows](local-coding-workflows.md#runner-lifecycle)). | Start: refused (flag off, settings missing, not ready). Status: not running, not ready or paused. Stop: it survives 30 s. |
| `coding doctor [--consumer-root DIR]` | Whether that runner may start: flag, allowlist, settings, child environment, CLI version, Codex sign-in, pause file. | Any check fails. |
| `logs [--lines N]` | Reports Wrangler's log directory (`WRANGLER_LOG_PATH`, else `logs/` under its global config directory, which is per user, not per checkout) and the newest file's tail. The terminal running `start` holds the request log. | Never. |

A generated wrapper's `pnpm local` runs this operator from its pinned submodule, with the wrapper's `local.port`; `start` adds `--consumer-root <wrapper>` after the wrapper's own startup refusals, and `seed` defaults `--screen` to the wrapper's first screen template, and `runner`/`coding` get `--consumer-root <wrapper>` ([consumer configuration](consumer-configuration.md#data-and-control-flow), [walkthrough](../wiki/consumer-bootstrap.md#wrapper-pnpm-local)).

`stack.ts` holds the inspection: port probing, Worker discovery mirroring `run-dev-server.ts` (every `gatekeeper-*` package with a `wrangler.jsonc`, the fork's own gatekeepers filtered by `inferos.canvas.json`), the record file and the ownership rule built on it (`stackOwnership`), the state directory and the log location. `lifecycle.ts` takes its process, network and subprocess access as an injectable `LifecycleDeps`, so `scripts/local/lifecycle.test.ts` covers usage errors, the status JSON shape, a stopped and a degraded stack, an occupied port, a listener this checkout did not start (a real socket with no record, and with a record for another port), repeated seeding, failure attribution, reset boundaries, stop, record ownership and log tailing without a running Workshop.

## Readiness as an agent sees it

`pnpm dev:verify` (`dev-verify.ts`) treats an open port as nothing: readiness is an authenticated RPC plus a board read through a gatekeeper connection. It signs in as the same local user (`login` only; it never creates an account), confirms the InferOps account among the connected accounts, opens the `InferOps Canvas demo` workspace, finds the connection to the board URL (default `inferops://demo.local/project/board/DEMO`), opens a session on it, reads the board (which the gatekeeper records as an observation) and lists the pending actions. The report's `agentView` is what an agent would find: `inferops` (connected, account id, display name, `mock` for the demo host or `live` otherwise), `board` (connection id, `suggestedBindingName` `INFEROPS_BOARD`, `tsType`, project, host, state and issue counts) and `approvalQueue` (reachable, pending count). A failed step is reported as `{ ok: false, step, error }` with the hint to run `pnpm local seed`.

The connection is found through the native action log rather than a file: every read through a connection is recorded as an observation carrying the connection's id and resource URL, so `findConnectionByResourceUrl` pages `listActions` until it meets one. That keeps the lookup in the state a reset clears, and makes seeding idempotent. With `--ensure-board` (what `seed` passes) a missing workspace or connection is created; with `--approval-scenario` one issue move is proposed through the session (the first issue that has a later state in its own workflow) only while no move from that connection is pending, so the approval queue holds exactly one synthetic action to review, repeatably. The mock data source keeps each account's demo board in a Durable Object, so seeded boards and pending moves survive restarts and go away with `reset`.

`packages/integration-tests/__tests__/local-lifecycle-verify.test.ts` runs both operator scripts as subprocesses against the real Workshop and the real InferOps gatekeeper (mock data) under `createTestHarness` with the `NetworkInterceptor` installed: verify fails closed before seeding (naming `signIn`, `inferops`, `workspace`), seeding twice finds the same connection and leaves one pending move, the token and password never reach the output, and the escape list is empty, which is what "an offline fixture run makes no external request" means here. The gatekeeper is validated into its own `.wrangler` by the `build:inferops-gatekeeper` task (after its configurator UI is built) before the suite starts, the same way the fixture gatekeeper is.

## Router-path parity

`startHarness({ router: {} })` (`packages/integration-tests/src/harness.ts`) boots `packages/router` from its checked-in `wrangler.jsonc` as the harness's primary Worker, ahead of the Workshop and the gatekeepers, so the harness URL is the deployment's public origin. The router keeps its production assets stanza (SPA fallback and worker-first paths) with `assets.directory` pointed at `fixtures/router-assets`, a two-file stand-in for the frontend build; it binds `WORKSHOP_BACKEND` and one `GATEKEEPER_<binding>` per gatekeeper to the gatekeeper's default export, the bindings the deploy service adds. Without the option the Workshop stays primary, so other suites are unchanged. The router is a Worker input of the suite (`src/worker-inputs.ts`), so watch mode reruns on a router change.

`__tests__/router-parity.test.ts` sends every request to that origin over real HTTP: static assets and the SPA fallback, `/api` worker-first, the gatekeeper and unbound gatekeeper routes, the Cap'n Web WebSocket, the InferOps gatekeeper's InferLab sign-in legs (asserting the provider `redirect_uri` is on the public origin), a board read recorded as an observation, one approval applied once, a restart of all three Workers via `server.update` with Durable Object state kept, and a reconnect. Reloads wait with `settled()` and retry side-effect-free phases with `overFreshConnection()`, now exported from `src/rpc-client.ts` and shared with `inferops-isolation.test.ts`, because a WebSocket opened just after a reload can be dropped.

`scripts/preview/smoke.ts` is the cloud half: given a deployed base URL and an optional Access service token (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`), it checks the app shell and SPA fallback, a `/api` WebSocket handshake (upgraded or auth-challenged, never 404 or 5xx), each gatekeeper route answering from a gatekeeper rather than the shell, and, for connect URLs passed with `--connect-url`, the provider `redirect_uri` origin. It only sends GETs and closes the handshake at once, prints a JSON report and exits 0, 1 or 2. Its checks are pure classifiers over a response, which `smoke.test.ts` drives against a local fake server under `node --test`. The [parity wiki](../wiki/local-cloud-parity.md) holds the matrix, the recorded runtime versions and the recipe.

## Frontend view registry and demo mode

`packages/workshop-frontend/views.json` lists every screen of the Workshop frontend as a tree of views: routes, regions, tabs, steps, modals, menus, popovers, cards, toasts, banners, states and app-wide styling. Each entry records its route, how to make it visible locally (`reach`), its source files with the primary file first, the components and styling it is built from, a stable DOM selector when the code has one, and the flags it depends on. The file is data only; `pnpm views` (`scripts/views/views.ts`) reads it:

- `list [query]`, `show <id>` and `files <id> [--deep]` find a view and its source files, and `--json` gives agents the same output in machine-readable form.
- `url <id>` and `open <id>` resolve a view's route against `--base`, `$VIEWS_BASE_URL` or `http://localhost:8787`. Route parameters come from `--param name=value`.
- `check` fails when the registry has drifted from the code. It reports a route declared under `src/routes` with no view of kind `route`, a view that names a missing file, route or parent, a parent loop, and a non-test `.tsx` file that no view, `nonViewFiles` or `unusedFiles` entry accounts for. It also reports an `unusedFiles` entry that something now imports. It is not yet part of `pnpm lint` or CI.

`pnpm views demo [--port <n>]` serves the frontend alone on Vite, by default on port 3100, with `VITE_DEMO=true`. In that mode `main.tsx` does not open the backend WebSocket. It loads `src/demo/boot.ts`, which runs Cap'n Web over a `MessageChannel` to fixture `RpcTarget`s in the same page. The build-time constant compiles this branch and `src/demo` out of every other build. `VITE_DEMO` is a declared `cache.env` input of the frontend build (`scripts/env-passthrough.test.ts`).

- `src/demo/world.ts` is the shared fixture world: the signed-in user, server config, UI flags (the `dev` values) and workspaces. It is rebuilt on every page load.
- `src/demo/registry.ts` holds one method table per RPC interface. The modules under `src/demo/areas/` fill those tables with `provide()`. A call to a method that no area provides rejects with a "not implemented in demo" error and a console warning, so a screen that still needs fixtures fails visibly instead of hanging.
- `src/demo/scenarios.ts` maps view ids to scenarios. `?demo=<view-id>` selects one for the tab. A scenario may adjust the world, choose the path to open, seed browser storage, and run UI steps (click, hover, type, press, wait) to reach menus, dialogs and tabs that a route alone does not show. A view with no scenario opens its route with the default world. `pnpm views open <id> --demo` builds that URL.
- `src/demo/DemoPicker.tsx` is an overlay listing every registered view (Ctrl/Cmd+Shift+K) that reloads the page into the chosen one.

## Configuration

cloudflare.config.ts is authoritative; pnpm configs:generate emits wrangler.jsonc. The default frontend and backend ports are 3000 and 8787. A root `.dev.vars`, then a root `.env`, fill variables the shell has not set. Remote Workers AI requires account access. See the [settings](../wiki/configuration-reference.md) and [parity](../wiki/local-cloud-parity.md) wiki pages.

The dev server resolves these before it writes the per-Worker dev configs:

- **InferOps integration.** `resolveInferOpsEnabled` (`scripts/dev-server-config.ts`) takes a version 2 wrapper's `INFEROPS_ENABLED` capability, else the shell's `INFEROPS_ENABLED` (default on), and passes `"true"` or `"false"` to the gatekeeper, which enforces it ([#103](https://github.com/factory-level/inferos/pull/103)). A wrapper that turns the capability on while `inferos.canvas.json` leaves the gatekeeper out stops startup. `INFEROPS_BASE_URL`, and the local-development stopgap `INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID` and `INFEROPS_WORKSPACE_SLUG`, pass through from the shell to the gatekeeper; without a base URL the gatekeeper serves its built-in demo data. `MOCK_INFEROPS_SYNTHETIC_ISSUES` passes through the same way and adds a large synthetic `PERF` board to that demo data for performance runs (see [InferOps gatekeeper](inferops-gatekeeper.md)).
- **Sign in with InferLab.** A wrapper's `INFEROPS_AUTH` (or version 1 `features.inferlabLogin`) adds `inferops` to `AUTH_GATEKEEPERS` and sets `INFERLAB_AUTH_ORIGIN`; in-repo, both come from the shell. An inconsistent combination stops startup. Details are in [consumer configuration](consumer-configuration.md#inferops-backed-sign-in).
- **ChatGPT plan usage.** `ENABLE_OPENAI_ASSISTANT_PLUGIN=true` starts the local Bun companion and wires it to the backend; `ANTHROPIC_API_KEY` enables managed local API-key models. Both write their secrets to the backend's `.dev.vars` and remove them on exit ([#40](https://github.com/factory-level/inferos/pull/40)). See [ChatGPT connection](chatgpt-connection.md).
- The backend always runs with `DEV` set, so UI flags resolve to their `dev` values.

## Divergences from Design

- Wrapper gatekeepers are discovered for local development only. The release manifest does not package them (cloud parity, [#11](https://github.com/factory-level/inferos/issues/11)), the gatekeeper UI pre-flight (`vp run build:configurator`/`build:app:dev`) covers only workspace packages, and a wrapper gatekeeper's dependencies must resolve from the wrapper, since it is not a package of the pinned workspace. A reviewed topology parity contract remains planned.
- A generated wrapper exposes `pnpm local` by delegating to the pinned operator (see [consumer configuration](consumer-configuration.md#data-and-control-flow)), which runs from the submodule: `status` lists the Workers the pinned checkout would bind rather than the wrapper's custom Workers and gatekeepers, and `status` reads InferOps connection variables from the shell and the submodule's local env files, not the wrapper's.
- `stop` relies on the dev server's record file; a stack started by other means (or before this change) is reported but never signalled. For the same reason `status`, `seed` and `verify` treat such a stack as `port-in-use-by-other`: ownership is the record's live pid and port, not an identifying endpoint, so a reused pid could still pass for this checkout's server. Startup-failure cleanup remains the dev server's own responsibility (its pre-flight and signal handlers), not a lifecycle command.
- The cloud smoke recipe has not been run against a Cloudflare deployment, and no CI job runs it; Cloudflare Access, real OAuth provider registration and deployed bindings remain unproven. A wrapper's own gatekeeper is not booted by the router-parity suite (it needs a generated wrapper and its build); its routing rests on the same `GATEKEEPER_<NAME>` rule and on `scripts/consumer/gatekeepers.test.ts`.
- Offline interception of external traffic is enforced in the integration harness, where Worker subrequests pass through Node. `pnpm local verify` against a running Wrangler cannot intercept the Workers' own traffic; it reports the configured mode instead.
- `seed` creates the demo canvas screen only when `inferos.canvas.json` declares one; the synthetic board itself comes from the InferOps gatekeeper's mock data, which is the "mock business operations" the MVP note on #10 excludes from the final walkthrough.
- The frontend view registry and demo mode are local development tooling that the design does not describe. Demo mode serves fixtures, not the authenticated RPC and fixture board read the design defines as readiness, so a screen that renders in demo mode says nothing about a running stack. Fixture coverage is partial: views whose RPC methods no area provides render their error state. Operate mode has no fixtures yet: `AuthenticatedApi.getOperateSession` is unimplemented, so every page that mounts the app shell logs a failed operate-session subscription, and the `operate.*` views do not render their content. Nothing checks that every view id named by a demo scenario still exists in `views.json`, although a comment in `scenarios.ts` says `pnpm views check` does.

## Open Questions

- Choose the wrapper configuration schema after comparing the upstream starter contract with this fork.
- Whether wrapper gatekeepers should stay behind `features.customCloudflareCode`, which the design describes only for the extension manifest, or get their own switch.
- Whether `pnpm views check` should join `pnpm lint` and CI, so that a frontend change has to update `views.json` with it.
- Cloud auth and real binding parity still need proof: whether the smoke recipe should become a gated CI job against disposable previews.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
