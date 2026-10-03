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
  - packages/workshop-frontend/src/ServerConfigContext.tsx
  - packages/workshop-frontend/src/BlueprintsPage.tsx
  - packages/workshop-frontend/src/components/GadgetList.tsx
  - scripts/run-dev-server.ts
  - scripts/dev-server-config.ts
  - packages/router
  - scripts/consumer
  - .agents/skills/bootstrap-inferos
  - .agents/skills/skill-upload
updated: 2026-10-02
---

# Consumer configuration and bootstrap implementation

## Overview

The working tree now contains a dependency-free Node bootstrap command and strict consumer configuration parser. It can create a pinned, recursively cloneable wrapper and validate its actual gitlink. It also initializes the consumer site name and profile instructions through the administrator capability. The deployment fallback theme is also applied. Listing density is also applied to workspace rows and Explore listings. Canvas composition and durable layout storage are available; board data and agent tools remain pending.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/consumer/config.ts` | Version 1 and 2 contract, exact keys/types, pin and URL checks, flag and capability dependency validation, version 1 to 2 migration |
| `scripts/consumer/bootstrap.ts` | Atomic creation in a sibling temporary directory, pinned submodule, wrapper files, copied standard blueprint sources and rerun protection |
| `scripts/consumer/runtime.ts` | Check actual submodule/index pin, report capability support, install locked dependencies, diagnose local prerequisites, launch native Workshop baseline |
| `scripts/consumer/project-board.json` | Synthetic fixture matching inspected InferOps board wire fields |
| `scripts/consumer/bootstrap.test.ts` | Fresh recursive clone, rerun preservation, drift rejection, failure cleanup and configuration failures |
| `.agents/skills/bootstrap-inferos` | Coding-agent setup guidance with honest readiness reporting |
| `.agents/skills/skill-upload` | Coding-agent guidance for installing, authoring and publishing wrapper skill packs, copied into wrappers |

## Data and Control Flow

The bootstrap accepts destination, repository and full commit SHA. It validates inputs, initializes Git in a staging directory, adds the submodule, checks out the requested commit and stages its gitlink. It copies runtime/parser helpers, the `bootstrap-inferos` and `skill-upload` skills and the starter skill packs (`skills/`, with a default `inferos.skills.json`; see [repo setup skills](repo-setup-skills.md#skill-packs)) into the wrapper, emits explicit configuration and a synthetic board, verifies the pin and atomically renames the directory. A failed operation removes only its own staging directory. Existing unknown directories are rejected; an existing managed wrapper is checked without rewriting its files.

The copied wrapper runtime loads configuration and compares the actual submodule HEAD and staged gitlink. `check` reports configuration readiness, pending adapters and whether the submodule has local modifications; a matching HEAD alone is not an exact-revision proof. `setup` installs dependencies with the frozen upstream lockfile. `dev` checks IPv4/IPv6 loopback port availability before delegating to native run-local with the configured port. A busy port fails with a configuration instruction and does not stop the other listener. It rejects features absent from the pinned source and remote InferOps mode; it reports pending fixture/data and agent canvas adapters and requires the separate administrator profile initialization even in baseline mode.

`doctor` aggregates nonmutating configuration/pin, Node, native-script, pnpm-version, local-tool and port checks. Missing dependencies point to `pnpm run setup`; requested unavailable features are errors. It exits nonzero on errors and reports dirty upstream code and pending runtime adapters as warnings. Its `runtimeReady: false` is separate from the preflight `ok` field. It does not claim running-service health or cloud parity and never stops a listener. The native launcher now uses a frozen-lockfile install as well as the wrapper setup command.

The bootstrap copies the pinned standard blueprint directory into wrapper-owned `blueprints/`. Local startup selects that complete set through the existing `BUNDLED_BLUEPRINTS_DIR` override; no kernel or installer API changes are needed. Empty legacy directories retain upstream defaults. A symlinked blueprint root is rejected. `blueprints:check` uses the pinned native compiler with a throwaway output and cleans it on success or failure, leaving the backend module untouched. Wrapper edits are read afresh on validation/startup; they are not yet watched automatically. The native revision and installed-gadget ownership rules remain unchanged.

## One-time profile initialization

`pnpm profile:init` runs the pinned backend's Node operator against `ws://localhost:<local.port>/api`, authenticated by `INFEROS_ADMIN_SESSION`. It resolves `personal` or `inferops-operations` instructions and uses the explicit configured site name, theme and density. It never sends the session to the configured InferOps data endpoint, stores it, or prints remote error text. Older pins without the operator fail explicitly. The command times out after 15 seconds and closes its RPC transport.

`AdminApi.initializeProfile` is obtained through the existing administrator capability. It validates the same site-name/instruction limits as existing setters. `AdminSettings` performs initialization in its serialized configuration mutation queue. The optional `profileInitialized: true` marker is stored and mirrored with the settings, including the existing rollback behavior if KV writing fails. One concurrent request initializes; later requests return `already-initialized`. If a target field was already customized (including a non-system fallback theme), all are preserved and initialization is consumed. Resetting fields afterward cannot make a rerun overwrite administrator choices. Authentication, grants, connectors and unrelated configuration are unchanged.

The operator has a dedicated Node-plus-Workers type-check program because the real shared RPC interface references Workers globals. The backend build checks it; ordinary Node build scripts keep their existing narrower program. No handwritten mirror of the RPC interface is used.

## Runtime theme resolution

The profile operator sends `styling.theme` as `defaultTheme`; `AdminSettings` persists it with profile initialization. The ordinary admin setter can change it later. Normalization maps old/malformed stored values to `system`, and public server config includes the default without authentication data. The shared API keeps the field optional for older consumers.

`ThemeProvider` receives the asynchronously loaded default from the main application. It tracks an explicit browser preference separately from that fallback, derives the effective mode, subscribes to OS appearance with `useSyncExternalStore`, and applies the resolved mode to the document. Changing the deployment default never overwrites local storage or an existing in-memory choice. The existing theme controls and Kumo palettes are reused. An admin-panel control for the new deployment setter remains pending.

## Configuration

The initial profile is inferops-operations, with composable and durable views enabled and custom Cloudflare code disabled. New wrappers materialize compact density, system theme and InferOS branding as explicit values. The configured site name can be initialized through the operator; theme is applied as a deployment fallback; density applies curated desktop workspace/Explore listing spacing. Fixture path is fixed to a wrapper-owned synthetic board. Remote mode accepts a noncredentialed HTTPS base URL but cannot launch until its adapter exists. Git sources support HTTPS or explicitly supplied absolute local paths. No cloud resources or production credentials are created. Custom Worker local support is described below.

## Divergences from Design

The [design](../design/consumer-configuration.md) requires live InferOps projection, runtime flag enforcement, composable/durable views, complete profile/style settings and custom Worker manifests. Site name, profile instructions, fallback theme, listing density, local custom Workers and canvas layout persistence are implemented. Authorized InferOps data, agent composition tools, complete view-sharing and cloud extension deployment remain pending. The native development runner's state/topology and lifecycle limitations remain. Bootstrap is not yet an upgrade/recovery service and does not copy production domain storage.

The [capability design](../design/feature-capabilities.md) requires each flag to be enforced at server operations, declared tools, the CLI and the UI, with a named owner, default and disable policy. Only the configuration contract, its migration and the CLI support report exist. No capability has an implementation, so all eight report `unsupported` and none can be switched on.

## Open Questions

The generated wrapper copies its small operator helpers so it can pin a prior InferOS revision. A reviewed upgrade command must define helper-version compatibility and update policy. Complete runtime and cloud validation is still required before declaring the objective complete.

Capability configuration ([#67](https://github.com/factory-level/inferos/issues/67)) leaves these undecided. Each has a conservative interim choice in code, not a decision:

- **Owner and default of each capability.** The design leaves both open. Every capability defaults to off and no profile enables one. No owner is recorded.
- **Legacy flag mapping.** The design names no capability equivalent for `composableViews`, `durableViews` or `customCloudflareCode`, so all three are retained under `features` and none maps to a capability. Whether any is later retired is open.
- **Further dependencies.** Only `INFEROPS_CANVAS_STATE_MACHINE` requires `INFEROPS_ENABLED` is stated. Whether `INFEROPS_AUTH` requires `INFEROPS_ENABLED`, whether the state machine requires `composableViews`, and whether the publication flags depend on anything are not validated. The "valid configured flow and runtime dependencies" of the state machine have no configuration fields yet.
- **Migrated capability values.** The migration writes all eight as explicit `false` rather than leaving them to inherit, matching how bootstrap materializes a profile. If inheriting is preferred, the migration should write an empty `capabilities` object.
- **New wrappers stay on version 1.** Bootstrap can pin a revision whose parser predates version 2, so it still writes version 1. When bootstrap should write version 2 is open.
- **No migration command.** `migrateConsumerConfig` is a function; no wrapper command rewrites `inferos.config.json`, and existing wrappers would need the newer copied helpers to get one.
- **Where support is declared.** The source table lives in the copied `runtime.ts`, so a wrapper with older helpers reports a capability unsupported even after its pin gains the code. Whether the pinned revision should declare its own supported set is part of the helper-compatibility question above.
- **Remaining enforcement.** Server, tool and UI enforcement, and the drain or cancel policy on disable, belong to each capability's own change.

## Listing density

`displayDensity` is normalized to comfortable for missing/invalid persisted values and published in admin/public configuration. `AdminApi.setDisplayDensity` validates comfortable/compact and supports later administrator changes. Profile initialization treats an existing compact setting as customization, preserving all target settings together. Initialization already consumed by an older version is not reapplied when density support is added; use the explicit setter.

The frontend reads deployment density from its existing server-config context. Compact spacing applies at the `sm` breakpoint and above to workspace rows, Explore rows, grid gaps and card content; mobile spacing is unchanged. Loading rows/grid gaps follow the same density. Font sizes, Kumo colors, keyboard interactions, menus and gadget-owned layouts remain unchanged. This is curated listing spacing, not a global CSS scale or a canvas density implementation. Configuration refresh requires a client reconnect/reload; an admin-panel control remains pending.

## InferLab sign-in flag

`features.inferlabLogin` (default false, set by no profile, so its provenance is `default` unless the wrapper overrides it) turns on "Sign in with InferLab". The wrapper runtime accepts it only on pins containing `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts`. `run-dev-server.ts --consumer-root` resolves it through `getInferLabLoginVars` (`scripts/dev-server-config.ts`):

- It appends `inferops` to the backend's `AUTH_GATEKEEPERS`, keeping vendors the shell lists.
- It sets the gatekeeper's `INFERLAB_AUTH_ORIGIN` to the shell value, or `http://localhost:8080`.

Startup fails if the wrapper's canvas config left `gatekeeper-inferops` out. Disabled, both variables pass through from the shell unchanged. Password login is unaffected. See [sign-in](../oauth-signin.md#inferlab).

## Consumer Workers

`scripts/consumer/extensions.ts` reads an explicit v1 manifest only while custom code is enabled. It validates names, directory containment, canonical configs/entrypoints and duplicate destinations, then uses `renderWorkerConfig` to generate per-Worker local configs. All configs validate before writes; generated-file symlinks are rejected. No Worker packages are discovered by name. The canonical config is executable trusted deployer code; path validation is not a JavaScript sandbox.

`run-dev-server.ts --consumer-root` adds those configs to the existing Wrangler invocation and injects only HTTP service bindings into the router. `CUSTOM_CLOUDFLARE_CODE` is a deployer-controlled string switch, separate from AdminConfig and rollout flags. The router requires it plus a matching `CONSUMER_*` binding. Reserved `/extensions` routes run before SPA asset fallback in both canonical and local router configs. Disabled routes return 404 without calling a service. Requests retain their method/body/path; endpoint authentication belongs to the Worker.

Bootstrap creates a disabled public hello example, manifest, validation command and generated-file ignore. The wrapper runtime accepts the custom code flag only on a supporting pin; doctor validates the manifest without importing custom config modules. `extensions:check` additionally renders canonical configs. Remote InferOps remains blocked; view features require a supporting pin. Cloud consumer manifest composition and deployment remain unimplemented; no feature flag grants resource access or triggers deployment.

## Durable-view server boundary

The native Overseer capability now offers workspace-scoped definition storage behind exact-string `COMPOSABLE_VIEWS` and `DURABLE_VIEWS` deployment bindings. Owner/build sessions can use it; use-only sessions cannot. The consumer launcher maps view flags to these bindings. Public server configuration advertises the effective flags to the builder Canvas page. Starter definitions are imported explicitly; no automatic installation or board data access occurs. See [canvas architecture](inferops-canvas.md) for transaction, sharing and resource-authorization boundaries.

## Profile resolution and provenance

The v1 parser accepts partial `features` and `styling` objects, while keeping those objects and all other top-level fields required. Unknown keys, explicit null/undefined and invalid values fail validation. Each field resolves base default → selected profile → own explicit override; false is an override. Dependency validation runs after resolution, so disabling only composableViews in the operations profile fails while inherited durableViews remains enabled. No dependent flag is silently changed.

The personal profile inherits disabled features, InferOS branding, comfortable density and system theme. Operations overrides both view flags to true and density to compact, and inherits the InferOS name. The custom Worker flag and theme remain base defaults. `inferos:check` reports resolved features/style and per-field default/profile/override provenance. Bootstrap writes a fully explicit snapshot of the operations profile so switching the profile name alone does not reset choices. Existing fully explicit wrappers retain their values. To opt back into inheritance, remove only the selected nested fields after reviewing the pinned parser support. All native launch/profile/extension consumers use the same parser. This resolution does not overwrite initialized AdminConfig or alter authentication, grants or rollout flags.

## Capability flags and schema version 2

`inferos.config.json` has two accepted versions. Version 1 is unchanged: the same keys, the same resolution and the same resolved object, with no `capabilities` field in the configuration or its provenance. Version 2 adds one required `capabilities` object whose keys are the eight names of [ADR 0001](../adr/0001-customer-capability-flag-vocabulary.md): `INFEROPS_ENABLED`, `INFEROPS_CANVAS_STATE_MACHINE`, `HARNESS_HG_ENABLED`, `INFEROPS_AUTH`, `PUBLISH_CLOUDFLAREOS_WIDGET`, `PUBLISH_CLOUDFLAREOS_APP`, `AGENT_DEPLOYMENTS` and `CODING_WORKBENCH_ENABLED`. It resolves like `features`: base default (off), then profile (none sets one), then explicit override, with per-field provenance. A `capabilities` key in a version 1 file, any other version, an unknown capability key and a non-boolean value all fail. Errors name the field and never include the rejected value.

Version 2 keeps `features` and its `durableViews` requires `composableViews` rule. `CAPABILITY_REQUIREMENTS` adds one rule: `INFEROPS_CANVAS_STATE_MACHINE` requires `INFEROPS_ENABLED`. A missing requirement is an error; the parser never turns another flag on. A capability is a configuration value only. It grants no resource, credential or deployment authority.

`migrateConsumerConfig` validates a version 1 file and returns the same file as version 2. Every written setting is kept as written, omitted `features` and `styling` fields still inherit, and all eight capabilities are written as explicit `false`. `LEGACY_FLAG_COMPATIBILITY` is the compatibility mapping: the three legacy flags are retained with their meaning and none maps to a capability, so a durable layout does not become state-machine execution and custom code activation does not become an agent permission. The function does not write files, and no wrapper command calls it yet.

`runtime.ts` holds `capabilitySources`, the pinned source path that makes an installation honour each capability. All eight entries are `null` at this revision: nothing reads any of the flags. `custom-gatekeepers/gatekeeper-inferops` serves mock boards and is selected through `inferos.canvas.json`, not through `INFEROPS_ENABLED`, so it does not count. `inferos:check` prints `schemaVersion` and a `capabilities` report with, per name, `state` (`enabled`: on and installed; `supported`: installed and off; `unsupported`: code absent), `requested` and `source` (default, profile or override). A version 1 wrapper gets the same report with every capability unrequested.

Switching on an unsupported capability fails instead of doing nothing. `inferos:check` still prints the report, with `ok: false`, and exits nonzero; `doctor` reports a runtime error; `dev` refuses to start; and `run-dev-server.ts --consumer-root` throws before any Worker is prepared. The same three commands also refuse a version 2 file when the pinned revision's own `scripts/consumer/config.ts` is missing or rejects it, because the pinned launcher parses that file itself.

## Canonical fixture validation

`generate-board-schema.ts` exports the canonical InferOps board DTO through Zod JSON Schema from a clean reviewed checkout. `project-board.schema.json` records repository/revision/path/export provenance. `fixtures.ts` loads that generated contract through Zod and applies local sample bounds and relationship checks. The small relationship projection selects only keys needed for referential checks after canonical validation; it is not another complete board DTO. No gatekeeper protocol or data authorization is implemented by this module.

Generated wrappers expose fixtures:check; doctor and dev invoke the pinned validator. Missing support or dependencies fails explicitly. Fixture mode checks a regular bounded JSON file and rejects symlinked fixture directory/files, duplicate IDs, project-reference mismatch and inconsistent column membership/workflow. It reports only counts and schema revision. Remote mode avoids the fixture entirely and remains startup-blocked. The schema is generated from InferOps 29b01a024c377b9c37b8754e7001b290e15d1509; drift checks against a different revision require explicit regeneration and review.
