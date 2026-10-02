---
title: Consumer configuration and bootstrap implementation
covers:
  - packages/workshop-backend/src/admin-config.ts
  - packages/workshop-backend/src/admin-settings.ts
  - packages/workshop-backend/scripts/initialize-consumer-profile.ts
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/deployment-config.ts
  - packages/workshop-frontend/src/ThemeContext.tsx
  - packages/workshop-frontend/src/theme.ts
  - packages/workshop-frontend/src/main.tsx
  - scripts/consumer
  - .agents/skills/bootstrap-inferos
updated: 2026-10-01
---

# Consumer configuration and bootstrap implementation

## Overview

The working tree now contains a dependency-free Node bootstrap command and strict consumer configuration parser. It can create a pinned, recursively cloneable wrapper and validate its actual gitlink. It also initializes the consumer site name and profile instructions through the administrator capability. The deployment fallback theme is also applied. View/data adapters and density defaults remain pending.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/consumer/config.ts` | Version 1 contract, exact keys/types, pin and URL checks, flag dependency validation |
| `scripts/consumer/bootstrap.ts` | Atomic creation in a sibling temporary directory, pinned submodule, wrapper files, copied standard blueprint sources and rerun protection |
| `scripts/consumer/runtime.ts` | Check actual submodule/index pin, install locked dependencies, diagnose local prerequisites, launch native Workshop baseline |
| `scripts/consumer/project-board.json` | Synthetic fixture matching inspected InferOps board wire fields |
| `scripts/consumer/bootstrap.test.ts` | Fresh recursive clone, rerun preservation, drift rejection, failure cleanup and configuration failures |
| `.agents/skills/bootstrap-inferos` | Coding-agent setup guidance with honest readiness reporting |

## Data and Control Flow

The bootstrap accepts destination, repository and full commit SHA. It validates inputs, initializes Git in a staging directory, adds the submodule, checks out the requested commit and stages its gitlink. It copies runtime/parser helpers into the wrapper, emits explicit configuration and a synthetic board, verifies the pin and atomically renames the directory. A failed operation removes only its own staging directory. Existing unknown directories are rejected; an existing managed wrapper is checked without rewriting its files.

The copied wrapper runtime loads configuration and compares the actual submodule HEAD and staged gitlink. `check` reports configuration readiness, pending adapters and whether the submodule has local modifications; a matching HEAD alone is not an exact-revision proof. `setup` installs dependencies with the frozen upstream lockfile. `dev` checks IPv4/IPv6 loopback port availability before delegating to native run-local with the configured port. A busy port fails with a configuration instruction and does not stop the other listener. It rejects enabled unimplemented features or remote InferOps mode; it reports that fixture/profile/style application is pending even in baseline mode.

`doctor` aggregates nonmutating configuration/pin, Node, native-script, pnpm-version, local-tool and port checks. Missing dependencies point to `pnpm run setup`; requested unavailable features are errors. It exits nonzero on errors and reports dirty upstream code and pending runtime adapters as warnings. Its `runtimeReady: false` is separate from the preflight `ok` field. It does not claim running-service health or cloud parity and never stops a listener. The native launcher now uses a frozen-lockfile install as well as the wrapper setup command.

The bootstrap copies the pinned standard blueprint directory into wrapper-owned `blueprints/`. Local startup selects that complete set through the existing `BUNDLED_BLUEPRINTS_DIR` override; no kernel or installer API changes are needed. Empty legacy directories retain upstream defaults. A symlinked blueprint root is rejected. `blueprints:check` uses the pinned native compiler with a throwaway output and cleans it on success or failure, leaving the backend module untouched. Wrapper edits are read afresh on validation/startup; they are not yet watched automatically. The native revision and installed-gadget ownership rules remain unchanged.

## One-time profile initialization

`pnpm profile:init` runs the pinned backend's Node operator against `ws://localhost:<local.port>/api`, authenticated by `INFEROS_ADMIN_SESSION`. It resolves `personal` or `inferops-operations` instructions and uses the explicit configured site name and theme. It never sends the session to the configured InferOps data endpoint, stores it, or prints remote error text. Older pins without the operator fail explicitly. The command times out after 15 seconds and closes its RPC transport.

`AdminApi.initializeProfile` is obtained through the existing administrator capability. It validates the same site-name/instruction limits as existing setters. `AdminSettings` performs initialization in its serialized configuration mutation queue. The optional `profileInitialized: true` marker is stored and mirrored with the settings, including the existing rollback behavior if KV writing fails. One concurrent request initializes; later requests return `already-initialized`. If a target field was already customized (including a non-system fallback theme), all are preserved and initialization is consumed. Resetting fields afterward cannot make a rerun overwrite administrator choices. Authentication, grants, connectors and unrelated configuration are unchanged.

The operator has a dedicated Node-plus-Workers type-check program because the real shared RPC interface references Workers globals. The backend build checks it; ordinary Node build scripts keep their existing narrower program. No handwritten mirror of the RPC interface is used.

## Runtime theme resolution

The profile operator sends `styling.theme` as `defaultTheme`; `AdminSettings` persists it with profile initialization. The ordinary admin setter can change it later. Normalization maps old/malformed stored values to `system`, and public server config includes the default without authentication data. The shared API keeps the field optional for older consumers.

`ThemeProvider` receives the asynchronously loaded default from the main application. It tracks an explicit browser preference separately from that fallback, derives the effective mode, subscribes to OS appearance with `useSyncExternalStore`, and applies the resolved mode to the document. Changing the deployment default never overwrites local storage or an existing in-memory choice. The existing theme controls and Kumo palettes are reused. An admin-panel control for the new deployment setter remains pending.

## Configuration

The initial profile is inferops-operations, with all three optional features disabled. The configured site name can be initialized through the operator; theme is applied as a deployment fallback; density remains validation-only. Fixture path is fixed to a wrapper-owned synthetic board. Remote mode accepts a noncredentialed HTTPS base URL but cannot launch until its adapter exists. Git sources support HTTPS or explicitly supplied absolute local paths. No cloud resources or production credentials are created.

## Divergences from Design

The [design](../design/consumer-configuration.md) requires live InferOps projection, runtime flag enforcement, composable/durable views, complete profile/style settings and custom Worker manifests. Initial site name, profile instructions and fallback theme are implemented so far; the remaining adapters are unimplemented. The native development runner's state/topology and lifecycle limitations remain. Bootstrap is not yet an upgrade/recovery service and does not copy production domain storage.

## Open Questions

The generated wrapper copies its small operator helpers so it can pin a prior InferOS revision. A reviewed upgrade command must define helper-version compatibility and update policy. Complete runtime and cloud validation is still required before declaring the objective complete.
