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
  - .agents/skills/local-coding
  - .agents/skills/verify-inferos
  - .agents/skills/upgrade-inferos
  - .agents/skills/recover-inferos
updated: '2026-10-05'
obsidian_designs:
- note: software/InferOS/InferOS Feature Flags.md
  sections:
  - Consumer configuration
---

# Consumer configuration and bootstrap implementation

## Overview

The working tree now contains a dependency-free Node bootstrap command and strict consumer configuration parser. It can create a pinned, recursively cloneable wrapper and validate its actual gitlink. It also initializes the consumer site name and profile instructions through the administrator capability. The deployment fallback theme is also applied. Listing density is also applied to workspace rows and Explore listings. Canvas composition and durable layout storage are available; board data and agent tools remain pending.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/consumer/config.ts` | Version 1 and 2 contract, exact keys/types, pin and URL checks, flag and capability dependency validation, version 1 to 2 migration |
| `scripts/consumer/bootstrap.ts` | Atomic creation in a sibling temporary directory, pinned submodule, wrapper files, copied standard blueprint sources, optional profile/capability choice with InferOps gatekeeper selection, and rerun protection. The wrapper's `.gitignore` covers `node_modules/`, `.wrangler/`, `.env*`, `.dev.vars*`, `.inferos/state/` and the generated, machine-specific `wrangler.consumer.jsonc` and `wrangler.dev.jsonc` files (the dev server writes the latter beside each wrapper gatekeeper, with absolute paths and the local port) |
| `scripts/consumer/runtime.ts` | Check actual submodule/index pin, report capability support, install locked dependencies, diagnose local prerequisites, launch native Workshop baseline, delegate `pnpm local` to the pinned lifecycle operator, migrate a version 1 file (`config migrate`) and delegate `intake apply` to the pinned intake command |
| `scripts/consumer/wrapper-files.ts` | What bootstrap writes and who owns it: the templates (`.inferos` helpers, wrapper skills, README, `.gitignore`), the managed `package.json` keys, and the `.inferos/files.json` record with each file's class and sha256 ([maintenance](#wrapper-maintenance-verify-upgrade-recover)) |
| `scripts/consumer/maintenance.ts` | Copied to `.inferos/maintenance.ts`: `verify`, `recover <ports\|config\|fixtures\|state>` and the `upgrade` driver that runs the target revision's planner |
| `scripts/consumer/upgrade.ts` | Plan or apply a pin change from a checkout at the target revision; `--branch` commits it as a reviewed upgrade and `--open-pr` opens the PR |
| `scripts/consumer/reconcile.ts` | Three-way reconciliation: per-file merge policy, the original rebuilt from the submodule's history, `git merge-file --diff3` ([reconciliation](#three-way-reconciliation-and-reviewed-upgrades)) |
| `scripts/consumer/upgrade-review.ts` | The upgrade review (code, configuration, capabilities, connections, migrations, action kinds), its Markdown rendering, and the portability scan |
| `scripts/consumer/wrapper-templates/` | The wrapper `README.md` and `.gitignore` templates, kept as files so their copies record an upstream `source` |
| `scripts/consumer/maintenance.test.ts` | Files record, upgrade with customizations kept, two differently customized wrappers on one target, a reviewed branch with PR, summary and secret checks, the missing-record path, verify report shape, recover dry run and apply |
| `scripts/consumer/settings.ts` | The selected private customer's settings table (#19): kind (secret, reference or value), owner, default, required-when predicate, local or cloud source and where each is read. `validateSettings` reports missing, invalid, credentialed, contradictory and unsupported settings without values; it also generates the table in [configuration reference](../wiki/configuration-reference.md#selected-customer-settings) |
| `scripts/consumer/intake.ts` | Derive managed configuration, a starter view and screen template, and requirement dispositions from a reviewed intake; see [customer onboarding](customer-onboarding.md) |
| `scripts/consumer/project-board.json` | Synthetic fixture matching inspected InferOps board wire fields |
| `scripts/consumer/bootstrap.test.ts` | Fresh recursive clone, rerun preservation, drift rejection, failure cleanup, configuration failures, the version 2 customer shell and wrapper `pnpm local` delegation |
| `.agents/skills/bootstrap-inferos` | Coding-agent setup guidance with honest readiness reporting |
| `.agents/skills/skill-upload` | Coding-agent guidance for installing, authoring and publishing wrapper skill packs, copied into wrappers |
| `.agents/skills/local-coding` | Coding-agent SOP for the local coding runner (setup, `pnpm local runner`/`coding doctor`, recovery, applying a patch), copied into wrappers |
| `.agents/skills/verify-inferos`, `upgrade-inferos`, `recover-inferos` | Coding-agent procedures for the three maintenance commands, copied into wrappers |

## Data and Control Flow

The bootstrap accepts destination, repository and full commit SHA, plus optional `--profile` and repeatable `--capability` flags (`InitialConsumerOptions` in `config.ts`). It validates inputs, initializes Git in a staging directory, adds the submodule, checks out the requested commit and stages its gitlink. It copies runtime/parser/maintenance helpers (reached through the `inferos` script, `node .inferos/runtime.ts`, as well as the named scripts), the `bootstrap-inferos`, `skill-upload`, `local-coding`, `verify-inferos`, `upgrade-inferos` and `recover-inferos` skills and the starter skill packs (`skills/`, with a default `inferos.skills.json`; see [repo setup skills](repo-setup-skills.md#skill-packs)) into the wrapper, emits explicit configuration and a synthetic board, writes the wrapper's own `pnpm-lock.yaml`, verifies the pin, records every file it wrote in `.inferos/files.json` and atomically renames the directory. A failed operation removes only its own staging directory. Existing unknown directories are rejected; an existing managed wrapper is checked without rewriting its files.

### Customer shell options

Without options the file is version 1 with the `inferops-operations` snapshot, as before. `--profile personal` materializes the personal profile instead. Any `--capability` makes `initialConsumerConfig` write version 2 with all eight capabilities explicit (the requested ones `true`, the rest `false`, as `migrateConsumerConfig` writes them), so a later default cannot switch one on; an unknown name fails. No profile sets a capability: the deployer names each one. When `INFEROPS_ENABLED` or `INFEROPS_AUTH` is requested, bootstrap runs the *pinned* `scripts/consumer/canvas.ts` in the staging directory (`gatekeeper enable gatekeeper-inferops`, and for `INFEROPS_ENABLED` `add-screen operations Operations <targetRef>`), so `inferos.canvas.json` is validated against what the pin builds and satisfies the launcher's rule that `INFEROPS_ENABLED` needs the gatekeeper selected. A version 2 wrapper then runs its own copied `.inferos/runtime.ts check` before the rename; a pin without the canvas CLI, version 2 parsing or a requested capability's source fails bootstrap and leaves no destination. These options shape only creation: a rerun returns `created: false` and rewrites neither file, whatever options it is given.

The copied wrapper runtime loads configuration and compares the actual submodule HEAD and staged gitlink. `check` reports configuration readiness, pending adapters and whether the submodule has local modifications; a matching HEAD alone is not an exact-revision proof. `setup` installs dependencies with the frozen upstream lockfile. `dev` checks IPv4/IPv6 loopback port availability before delegating to native run-local with the configured port. A busy port fails with a configuration instruction and does not stop the other listener. It rejects features absent from the pinned source and remote InferOps mode; it reports pending fixture/data and agent canvas adapters and requires the separate administrator profile initialization even in baseline mode.

`local` delegates to the pinned `scripts/local/lifecycle.ts` (or fails with "does not support the local lifecycle" on older pins) with `cwd` the submodule and `VITE_BACKEND_HOST` from `local.port`. `localLifecycleArgs` adapts the arguments to the wrapper: `start` gets `--consumer-root <wrapper>` appended to its run-local flags, and `seed` without `--screen` gets the first screen id in the wrapper's `inferos.canvas.json`. `start` first runs `assertStartable`, the refusals `dev` shares (blocked capabilities, unsupported schema, unavailable features or remote mode, custom Workers on an unsupporting pin, fixture validation); the port check stays with each launcher. Both `dev` and `local` run the pinned script in the foreground through its `relayTermination`.

`doctor` aggregates nonmutating configuration/pin, Node, native-script, pnpm-version, local-tool and port checks. Missing dependencies point to `pnpm run setup`; requested unavailable features are errors. It exits nonzero on errors and reports dirty upstream code and pending runtime adapters as warnings. Its `runtimeReady: false` is separate from the preflight `ok` field. Its `settings` check (`diagnoseSettings`) imports the *pinned* `scripts/consumer/settings.ts` and runs `validateSettings` over the resolved configuration, the shell and whether `inferos.canvas.json` selects the InferOps gatekeeper. Only error findings fail doctor; warnings (shell values a version 2 wrapper overrides, the unchecked Codex login) and unsupported rows (the Wiki binding, a cloud deployment target) are reported. The report's `settings` field lists each row's state (`set`, `unset`, `unchecked`, `unsupported`) and the findings; a secret is reported only as present or absent, and no message carries a value. A pin without the table yields a warning. It does not claim running-service health or cloud parity and never stops a listener. The native launcher now uses a frozen-lockfile install as well as the wrapper setup command.

The bootstrap copies the pinned standard blueprint directory into wrapper-owned `blueprints/`. Local startup selects that complete set through the existing `BUNDLED_BLUEPRINTS_DIR` override; no kernel or installer API changes are needed. Empty legacy directories retain upstream defaults. A symlinked blueprint root is rejected. `blueprints:check` uses the pinned native compiler with a throwaway output and cleans it on success or failure, leaving the backend module untouched. Wrapper edits are read afresh on validation/startup; they are not yet watched automatically. The native revision and installed-gadget ownership rules remain unchanged.

## Wrapper maintenance: verify, upgrade, recover

`runtime.ts` hands `verify`, `recover` and `upgrade` to `.inferos/maintenance.ts` before its own configuration check, so they answer with a JSON report even when the wrapper does not check. Each prints one JSON object and exits 0 (healthy), 1 (not) or 2 (usage), like the lifecycle operator.

**File record.** `.inferos/files.json` (`schemaVersion: 1`) lists every file bootstrap wrote with its class, the sha256 of the bytes written and, for copies, the upstream `source` path. The submodule is listed under `shared`. The classes are:
- `generated`: `.inferos/bootstrap.json`, and `package.json`, where only `packageManager`, `engines` and InferOS's own scripts are managed (`renderPackageJson` merges them and keeps the customer's other keys and scripts).
- `copied-template`: the `.inferos` helpers, the six wrapper skills, `README.md` and `.gitignore`.
- `customer-owned`: everything else, including the configuration, blueprints, skill packs, fixture, views, workers, `inferos.canvas.json`, `pnpm-lock.yaml` and the `.gitkeep` files. The blueprints, skill packs and fixture record the upstream `source` they were copied from.

The `source` and hash identify the original text, which upgrade rebuilds from the submodule's history ([reconciliation](#three-way-reconciliation-and-reviewed-upgrades)).

**verify** runs `checkConsumer` (plus schema and capability support), `diagnoseConsumer` and the pinned lifecycle's `status --json`. Only when that status says the listener is the wrapper's own stack (`stack: "running"`) does it run `verify --json` and ignore doctor's port error, which is then the stack's own listener. A pin whose operator predates the `stack` field reports only `listening`, so for it the wrapper checks the submodule's dev-server record (`inferos/.wrangler/local/dev-server.json`, a live pid recorded for `local.port`) itself. A stopped stack makes the live checks `skipped`; a port held by another process (`port-in-use-by-other`) makes them `skipped` with that reason, never runs `local verify` against it, and leaves doctor's port error standing. `--live` turns either into a failure. The report is `{ok, revision, live, failures, checks[{name, status, reasons, details}]}`.

**upgrade `<sha>` [`--plan`|`--apply`]** fetches the commit into the submodule when it is missing (the only network access), adds a temporary detached worktree of the submodule at the target, and runs *that* revision's `scripts/consumer/upgrade.ts`, so the target renders its own templates and judges its own configuration support. The planner refuses to run from a checkout at any other revision. The plan reports:
- blockers: a dirty wrapper tree (naming the dirty paths, and saying to commit an untracked `pnpm-lock.yaml`), a wrapper that does not check, a configuration the target cannot parse, or enabled capabilities the target does not ship.
- the submodule move (`forward`, `same` or `not-a-descendant`).
- what `config migrate` would do against the target for a version 1 file. This is advisory only; the upgrade never migrates.
- a per-file action. Generated files get `regenerate`. A copied template gets `update` when its hash matches the record, `add` when it is new, `merge` or `conflict` when it was edited and could be reconciled, and `needs-review` when it was edited but not mergeable, deleted, has no baseline, or when `files.json` is missing. A template the target dropped gets `removed-upstream`. A customer-owned starter whose upstream source changed gets `update` when unedited, `merge` or `conflict` when edited, and `upstream-changed` when it is the fixture, was deleted, or cannot be merged.
- `review`, the change between the two revisions ([below](#three-way-reconciliation-and-reviewed-upgrades)).
- the state rollback limit.

`--apply` checks out the target in the submodule and stages the gitlink. It writes the `regenerate`/`update`/`add`/`merge` files and puts the conflicted merge, or the target's text, for each `conflict`, `needs-review` and `upstream-changed` file under the ignored `.inferos/state/upgrade/<sha>/`. It rewrites only `upstream.revision` in `inferos.config.json`, then `.inferos/bootstrap.json` and `.inferos/files.json`. A written file's record takes the target's hash, including a merged one, so the next upgrade merges from the target's text. A file left for review keeps its old baseline, or none, so it stays flagged until it is resolved. Apply stages the result, reruns `checkConsumer` and, without `--branch`, never commits or deploys.

### Three-way reconciliation and reviewed upgrades

**Originals come from Git, not from copies.** `reconcile.ts` rebuilds the original of an edited copy by reading its recorded `source` from the wrapper's submodule, first at the record's revision and the current pin, then through the last 200 commits that touched it, and keeps the blob whose sha256 matches the record. The wrapper stores no second copy of each file. A file without a `source` (a wrapper bootstrapped before the README and `.gitignore` moved to `scripts/consumer/wrapper-templates/`) or whose original is not in reach falls back to `needs-review`.

**Merge policy, per file.**

| Files | Edited copy |
| --- | --- |
| `.inferos/` helpers | `needs-review`: operator code, so an edit is a private core patch, which is never merged automatically |
| `fixtures/` | `upstream-changed`, edited or not: the customer's board data |
| Binary (a NUL byte or invalid UTF-8) | `needs-review`/`upstream-changed`; replaced only while unedited |
| `*.json` (blueprint manifests) | Text merge; a result that does not parse is a `conflict` |
| Other text (skills, SOPs, blueprint sources, README, `.gitignore`) | Text merge |

The merge is `git merge-file --diff3` on temporary copies, labelled `wrapper`, `original` and `inferos <sha>`. A clean result is written; a conflicted one goes, markers included, only to `.inferos/state/upgrade/<sha>/<path>`, which is gitignored, never into the customer's file. Customer-owned files with no upstream `source` (configuration, views, workers, gatekeepers, intake) are never read for merging or written.

**Review.** `upgrade-review.ts` reads the submodule's history between the pin and the target: the commit list (up to 50), shortstat and a GitHub compare link; configuration schema sources that changed; additions and removals in `CAPABILITY_NAMES`, `CAPABILITY_REQUIREMENTS` and `capabilitySources`; changed `connection.json` and gatekeeper `deploy-inputs.json` files with their diff; new and removed `migrations` entries in each changed `cloudflare.config.ts`; and action kinds, as literal `tag:` values in gatekeeper sources and record `kind:` values in `*actions.ts`, plus every gatekeeper whose source changed. It is a text reading: computed tags, OAuth scopes in code and new methods are not analysed, and the summary says so.

**Reviewed branch.** `--apply --branch <name>` checks the plan, creates the branch from HEAD, applies, and scans before committing. The scan refuses staged paths under `.dev.vars*`, `.env*`, `.wrangler/`, `.inferos/state/` or `node_modules/`, any value of 12 or more characters from the wrapper's root `.dev.vars*`/`.env*` files, and known token shapes (private keys, GitHub, `sk-`, Slack, AWS, bearer) in the staged diff and in the summary. A finding is reported by name and leaves the branch uncommitted. Otherwise it commits with the summary as the message and writes the summary to `.inferos/state/upgrade/<sha>/UPGRADE.md`. `--open-pr <owner/repo>` then pushes to `origin` and runs `gh pr create --base <previous branch> --body-file UPGRADE.md`. Nothing is merged. `maintenance.ts` passes every flag through to the target's `upgrade.ts`, so the target decides what it accepts.

**Authority.** The wrapper holds no grants, bindings, approvals, auto-approval rules or agent memory, so an upgrade cannot carry or widen them. Auto-approval rules are stored in the deployment per gatekeeper and action kind (`setAutoApprovedActionKind`), so a new kind starts with none, and each of its actions waits for a manual decision until someone enables one. The summary flags each new kind for review. `maintenance.test.ts` checks this for a target that adds a delete action kind: the branch diff holds only InferOS-managed and reconciled files, and fake tokens planted in `.dev.vars`, `.inferos/state/` and local Wrangler state appear in neither the diff nor the commit message.

This answers two open questions in [connection extensions](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Connection%20packages%20and%20reviewed%20updates). Classification is recorded in `.inferos/files.json`, with the submodule listed as `shared`. The three-way mechanism is the original rebuilt from Git plus `git merge-file`, under the per-file policy above.

**recover** is a dry run unless given `--apply`. Each action is `auto` or `manual`, and `ok` means none is left outstanding.
- `ports`: stops the wrapper's own recorded dev server, or moves `local.port` to the next free port; it never stops another process.
- `config`: runs `git submodule update --init inferos` when the gitlink and `upstream.revision` agree but the checkout differs (refused while the submodule has local changes). A gitlink that disagrees with `upstream.revision` is reported as manual. It also rewrites `bootstrap.json`, re-merges the managed `package.json` keys and restores missing templates from the pin's own `wrapper-files.ts`. Edited templates and an invalid configuration are only reported.
- `fixtures`: renames an invalid fixture to `<fixture>.invalid-<time>` and restores the pinned starter, only when the starter validates against `inferops.targetRef`.
- `state`: states the rollback limit (local state is reset only, never migrated back) and with `--apply` runs the pinned `reset --yes`.

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

The [design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Feature%20Flags.md%23Consumer%20configuration) requires live InferOps projection, runtime flag enforcement, composable/durable views, complete profile/style settings and custom Worker manifests. Site name, profile instructions, fallback theme, listing density, local custom Workers and canvas layout persistence are implemented. Authorized InferOps data, agent composition tools, complete view-sharing and cloud extension deployment remain pending. The native development runner's state/topology and lifecycle limitations remain. Upgrade and recovery cover the local wrapper only. Edited copies are reconciled three-way, and `--branch`/`--open-pr` produce a reviewed upgrade branch and PR (#75). Cloud smoke checks are not implemented, and nothing copies production domain storage. The [connection extensions](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Connection%20packages%20and%20reviewed%20updates) design asks for upgrades to show OAuth, data and approval changes. The review reads these from known files only (`connection.json`, `deploy-inputs.json`, `migrations` and literal action-kind tags). It does not analyse OAuth scopes requested in code or new gatekeeper methods, and pending-action compatibility across versions is not checked.

Durable views ship as the bounded #34 slice (MVP scope in #1): the one private Kanban/Operate view persists through reload and local Worker restart, rejects stale expected revisions with a conflict, and is scoped to the workspace's build-access boundary. The design's export-with-binding-requirements and import-time rebind, independent view sharing, deployment-update recovery and supported schema migration are post-release. Import today validates content and mints a new definition without rebinding authority, and a view is shared only by sharing its workspace. Evidence is in [canvas architecture](inferops-canvas.md#resolving-a-board-reference).

The [capability design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Feature%20Flags.md%23Capability%20contract%20and%20migration%20review) requires each flag to be enforced at server operations, declared tools, the CLI and the UI, with a named owner, default and disable policy. Three capabilities have an implementation: `INFEROPS_AUTH` (see [InferOps-backed sign-in](#inferops-backed-sign-in)), `INFEROPS_ENABLED` (see [InferOps integration](#inferops-integration-inferops_enabled)) and `CODING_WORKBENCH_ENABLED` (see [Coding dispatch](#coding-dispatch-coding_workbench_enabled)). The other five report `unsupported` and cannot be switched on. No implemented capability has a declared-tool or cloud deployment path yet.

Settings validation ([#19](https://github.com/factory-level/inferos/issues/19)) covers only the selected private local customer, as #19's MVP scope narrows the [repo setup design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Repository%20setup%20skills): identity, the InferOps target and Wiki references, host and runtime, local custom components and the coding adapter. Admin, model, storage, router and observability settings, and deployment-provider matrices, are post-release; they stay in the explanatory table. Doctor requires `INFERLAB_AUTH_ORIGIN` when sign-in is on even though startup falls back to `http://localhost:8080`. `INFEROPS_CLI` and the Codex login are listed for the coding adapter before the local runner lifecycle that reads them ships (#72); doctor checks the CLI path's form, not that it runs, and does not run Codex.

## Open Questions

The generated wrapper copies its small operator helpers so it can pin a prior InferOS revision. `upgrade` refreshes them as copied templates; a wrapper whose helpers predate the command runs the target's `scripts/consumer/upgrade.ts` from an InferOS checkout at the target revision. Edited helpers are never merged and stay `needs-review`; whether they should block an upgrade instead is open. Whether an unedited blueprint starter should be refreshed automatically (it is, and the change is visible in the reviewed diff) or only reported is a policy question for a human reviewer. Complete runtime and cloud validation is still required before declaring the objective complete.

Capability configuration ([#67](https://github.com/factory-level/inferos/issues/67)) leaves these undecided. Each has a conservative interim choice in code, not a decision:

- **Owner and default of each capability.** The design leaves both open. Every capability defaults to off and no profile enables one. Only `INFEROPS_ENABLED` has a recorded owner (the deployer, below); the rest have none.
- **Legacy flag mapping.** The design names no capability equivalent for `composableViews`, `durableViews` or `customCloudflareCode`, so all three are retained under `features` and none maps to a capability. Whether any is later retired is open.
- **Further dependencies.** `INFEROPS_CANVAS_STATE_MACHINE` and `CODING_WORKBENCH_ENABLED` requiring `INFEROPS_ENABLED` are stated. `INFEROPS_AUTH` does not require `INFEROPS_ENABLED`: sign-in is an identity mode, and the gatekeeper that serves it runs whenever `inferos.canvas.json` installs it, refusing data while the integration is off. Whether whether the state machine requires `composableViews`, and whether the publication flags depend on anything are not validated. The "valid configured flow and runtime dependencies" of the state machine have no configuration fields yet.
- **Migrated capability values.** The migration writes all eight explicitly rather than leaving them to inherit, matching how bootstrap materializes a profile. All are `false` except `INFEROPS_ENABLED`, which the caller sets from whether the version 1 wrapper's `inferos.canvas.json` installs the gatekeeper (`MigrationContext.inferOpsGatekeeperSelected`), because version 2 would otherwise turn a running integration off. If inheriting is preferred, the migration should write an empty `capabilities` object.
- **New wrappers stay on version 1.** Bootstrap can pin a revision whose parser predates version 2, so it still writes version 1. When bootstrap should write version 2 is open.
- **Migration in existing wrappers.** `pnpm inferos config migrate` runs `migrateConsumerConfig` against the wrapper (`migrateWrapperConfig`), carrying over whether the gatekeeper runs (`inferOpsGatekeeperSelected`: no canvas file means every built custom gatekeeper runs). Wrappers created before it need the newer copied helpers and the `inferos` script to get it.
- **Where support is declared.** The source table lives in the copied `runtime.ts`, so a wrapper with older helpers reports a capability unsupported even after its pin gains the code. Whether the pinned revision should declare its own supported set is part of the helper-compatibility question above.
- **Remaining enforcement.** Server, tool and UI enforcement, and the drain or cancel policy on disable, belong to each capability's own change.

## Listing density

`displayDensity` is normalized to comfortable for missing/invalid persisted values and published in admin/public configuration. `AdminApi.setDisplayDensity` validates comfortable/compact and supports later administrator changes. Profile initialization treats an existing compact setting as customization, preserving all target settings together. Initialization already consumed by an older version is not reapplied when density support is added; use the explicit setter.

The frontend reads deployment density from its existing server-config context. Compact spacing applies at the `sm` breakpoint and above to workspace rows, Explore rows, grid gaps and card content; mobile spacing is unchanged. Loading rows/grid gaps follow the same density. Font sizes, Kumo colors, keyboard interactions, menus and gadget-owned layouts remain unchanged. This is curated listing spacing, not a global CSS scale or a canvas density implementation. Configuration refresh requires a client reconnect/reload; an admin-panel control remains pending.

## InferOps-backed sign-in

`features.inferlabLogin` (version 1; default false, set by no profile, so its provenance is `default` unless the wrapper overrides it) and `capabilities.INFEROPS_AUTH` (version 2) are one switch, `inferOpsAuthRequested` in `config.ts`: either turns on "Sign in with InferLab" and per-person InferOps accounts. `LEGACY_FLAG_COMPATIBILITY.inferlabLogin` names `INFEROPS_AUTH` as its capability; migration keeps a version 1 wrapper's flag as written and writes the capability `false`, so resolved behaviour is unchanged. `capabilitySources.INFEROPS_AUTH` is `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts`, so the runtime accepts either on pins containing it and `inferos:check` reports the capability `supported` or `enabled` there. `run-dev-server.ts --consumer-root` resolves the switch through `getInferLabLoginVars` (`scripts/dev-server-config.ts`):

- It appends `inferops` to the backend's `AUTH_GATEKEEPERS`, keeping vendors the shell lists.
- It sets the gatekeeper's `INFERLAB_AUTH_ORIGIN` to the shell value, or `http://localhost:8080`.

Then `inferLabLoginStartupError` checks the result, in-repo and in a wrapper alike: with `DISABLE_PASSWORD_AUTH=true`, some gatekeeper must be allowlisted (the backend would otherwise keep password login on rather than lock everyone out); with `inferops` allowlisted, `gatekeeper-inferops` must be enabled in the canvas config and `INFERLAB_AUTH_ORIGIN` must be a bare HTTPS origin or HTTP on loopback. Otherwise startup stops with the reason. Disabled, both variables pass through from the shell unchanged. Password login is unaffected. See [sign-in](../oauth-signin.md#inferlab).

## Consumer Workers

`scripts/consumer/extensions.ts` reads an explicit v1 manifest only while custom code is enabled. It validates names, directory containment, canonical configs/entrypoints and duplicate destinations, then uses `renderWorkerConfig` to generate per-Worker local configs. All configs validate before writes; generated-file symlinks are rejected. No Worker packages are discovered by name. The canonical config is executable trusted deployer code; path validation is not a JavaScript sandbox.

`run-dev-server.ts --consumer-root` adds those configs to the existing Wrangler invocation and injects only HTTP service bindings into the router. `CUSTOM_CLOUDFLARE_CODE` is a deployer-controlled string switch, separate from AdminConfig and rollout flags. The router requires it plus a matching `CONSUMER_*` binding. Reserved `/extensions` routes run before SPA asset fallback in both canonical and local router configs. Disabled routes return 404 without calling a service. Requests retain their method/body/path; endpoint authentication belongs to the Worker.

With custom code enabled, the wrapper's `gatekeepers/gatekeeper-<slug>/` directories are candidate gatekeepers (`scripts/consumer/gatekeepers.ts`, through the optional consumer root of `scripts/worker-dirs.ts`). Each has a `cloudflare.config.ts` naming the Worker after its directory, the `wrangler.jsonc` generated from it in the wrapper, and a `connection.json` package contract; a child without a Worker config is a library and never runs. Symbolic links, escaping paths and names the pinned checkout already uses are rejected (thrown, as before). A directory is not an authority: `readConsumerGatekeepers` loads one only when `inferos.config.json` lists its slug under `gatekeepers` with `enabled: true`, its `connection.json` validates against `scripts/connection-package.schema.json` (`scripts/connection-package.ts`) and names the same `id`, and its `compatibility.inferos.gatekeeperApi` lists the pin's `GATEKEEPER_API_LEVEL`. Every other candidate is refused with a reason and never imported: unlisted and disabled ones as `notice`, a missing, invalid, mismatched or incompatible contract as `error`, and so is a listed and enabled slug with no directory. `run-dev-server.ts --consumer-root` regenerates the accepted gatekeepers' configs, binds them to the backend and router as `GATEKEEPER_<SLUG>` exactly like pinned gatekeepers (so their callbacks are served at `/gatekeeper/<slug>` on the wrapper's own origin), and warns once per refused one. Bootstrap adds `gatekeepers:check` (prints `gatekeepers` with each one's `status`, `refused` and `stale`; exit 1 on a stale config or an `error` refusal), `gatekeepers:generate` (`node .inferos/runtime.ts gatekeepers [--write]`, which runs the pinned `scripts/consumer/gatekeepers.ts`) and `gatekeepers:scaffold <slug>` (`node .inferos/runtime.ts scaffold`, the pinned `scripts/scaffold-gatekeeper.ts --consumer-root`). Doctor reports a `gatekeepers` check from the same reader without importing any config: `pass`, `warning` when something is unlisted or disabled, `error` for an `error` refusal; a pin without `readConsumerGatekeepers` gets a warning that it binds by directory alone. They are local only; the release manifest does not package them. See [wrapper topology](local-development.md#wrapper-topology) and [connection extensions](connection-extensions.md).

`gatekeepers` is optional in both schema versions, at most 32 entries of exactly `{ slug, enabled }`, slugs unique. Omitted means no wrapper gatekeeper loads, so a wrapper that used one before this field existed must add it, and a `connection.json`, when it moves its pin forward; until then the gatekeeper is reported, not bound. A pin older than the field rejects a file that has it (closed keys), which also fails closed. `migrateConsumerConfig` keeps the listing as written. Listing a gatekeeper grants nothing: it allows a reviewed directory to load, and resources are still granted per account and binding.

A custom Worker under `workers/` is never a gatekeeper: no discovery path reads `workers/` for gatekeepers, its binding is the router-only `CONSUMER_<ID>`, and `extensions.ts` refuses a listed Worker directory that holds a `connection.json`, since a connection package belongs in `gatekeepers/`.

Bootstrap creates a disabled public hello example, manifest, validation command and generated-file ignore. The wrapper runtime accepts the custom code flag only on a supporting pin; doctor validates the manifest without importing custom config modules. `extensions:check` additionally renders canonical configs. Remote InferOps remains blocked; view features require a supporting pin. Cloud consumer manifest composition and deployment remain unimplemented; no feature flag grants resource access or triggers deployment.

## Durable-view server boundary

The native Overseer capability now offers workspace-scoped definition storage behind exact-string `COMPOSABLE_VIEWS` and `DURABLE_VIEWS` deployment bindings. Owner/build sessions can use it; use-only sessions cannot. The consumer launcher maps view flags to these bindings. Public server configuration advertises the effective flags to the builder Canvas page. Starter definitions are imported explicitly; no automatic installation or board data access occurs. See [canvas architecture](inferops-canvas.md) for transaction, sharing and resource-authorization boundaries. An integration test proves, for one view with a live `inferops://demo.local/project/board/DEMO` reference, persistence across a Worker restart, stale-revision conflicts, single-winner concurrent edits, use-role and other-account denial, and that the Operate session still opens it after the restart.

## Profile resolution and provenance

The v1 parser accepts partial `features` and `styling` objects, while keeping those objects and all other top-level fields required. Unknown keys, explicit null/undefined and invalid values fail validation. Each field resolves base default → selected profile → own explicit override; false is an override. Dependency validation runs after resolution, so disabling only composableViews in the operations profile fails while inherited durableViews remains enabled. No dependent flag is silently changed.

The personal profile inherits disabled features, InferOS branding, comfortable density and system theme. Operations overrides both view flags to true and density to compact, and inherits the InferOS name. The custom Worker flag and theme remain base defaults. `inferos:check` reports resolved features/style and per-field default/profile/override provenance. Bootstrap writes a fully explicit snapshot of the operations profile so switching the profile name alone does not reset choices. Existing fully explicit wrappers retain their values. To opt back into inheritance, remove only the selected nested fields after reviewing the pinned parser support. All native launch/profile/extension consumers use the same parser. This resolution does not overwrite initialized AdminConfig or alter authentication, grants or rollout flags.

## Capability flags and schema version 2

`inferos.config.json` has two accepted versions. Version 1 is unchanged: the same keys, the same resolution and the same resolved object, with no `capabilities` field in the configuration or its provenance. Version 2 adds one required `capabilities` object whose keys are the eight names of [ADR 0001](../adr/0001-customer-capability-flag-vocabulary.md): `INFEROPS_ENABLED`, `INFEROPS_CANVAS_STATE_MACHINE`, `HARNESS_HG_ENABLED`, `INFEROPS_AUTH`, `PUBLISH_CLOUDFLAREOS_WIDGET`, `PUBLISH_CLOUDFLAREOS_APP`, `AGENT_DEPLOYMENTS` and `CODING_WORKBENCH_ENABLED`. It resolves like `features`: base default (off), then profile (none sets one), then explicit override, with per-field provenance. A `capabilities` key in a version 1 file, any other version, an unknown capability key and a non-boolean value all fail. Errors name the field and never include the rejected value.

Version 2 keeps `features` and its `durableViews` requires `composableViews` rule. `CAPABILITY_REQUIREMENTS` adds two rules: `INFEROPS_CANVAS_STATE_MACHINE` and `CODING_WORKBENCH_ENABLED` each require `INFEROPS_ENABLED`. Version 2 also accepts an optional `codingWorkbench` object (see [Coding dispatch](#coding-dispatch-coding_workbench_enabled)); a version 1 file with one fails. A missing requirement is an error; the parser never turns another flag on. A capability is a configuration value only. It grants no resource, credential or deployment authority.

`migrateConsumerConfig` validates a version 1 file and returns the same file as version 2. Every written setting is kept as written, omitted `features` and `styling` fields still inherit, and all eight capabilities are written explicitly: `false`, except `INFEROPS_ENABLED`, which carries over whether the caller says the gatekeeper ran (`migrateConsumerConfig(input, { inferOpsGatekeeperSelected })`; omitted, it is `false`). `LEGACY_FLAG_COMPATIBILITY` is the compatibility mapping: the four legacy flags are retained with their meaning; three map to no capability, so a durable layout does not become state-machine execution and custom code activation does not become an agent permission, and `inferlabLogin` maps to `INFEROPS_AUTH`, which means the same thing (see [InferOps-backed sign-in](#inferops-backed-sign-in)). The function does not write files. `pnpm inferos config migrate` (`migrateWrapperConfig` in `runtime.ts`) writes its result in place, after checking that the pin honours every carried-over capability and parses version 2, and `pnpm inferos intake apply` migrates first the same way. Bootstrap's `--capability` writes the same explicit shape for a new wrapper.

`runtime.ts` holds `capabilitySources`, the pinned source path that makes an installation honour each capability. Five entries are `null` at this revision: nothing reads those flags. `INFEROPS_AUTH` names the gatekeeper's sign-in module, which the launcher honours, `INFEROPS_ENABLED` names the gatekeeper's switch, `custom-gatekeepers/gatekeeper-inferops/src/enablement.ts`, and `CODING_WORKBENCH_ENABLED` its coding switch, `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts`, so a pin without that enforcement reports it `unsupported`. The wrapper `dev` command passes `--consumer-root` for every version 2 file, so the launcher sees the capabilities even when no `features` flag is on. `inferos:check` prints `schemaVersion` and a `capabilities` report with, per name, `state` (`enabled`: on and installed; `supported`: installed and off; `unsupported`: code absent), `requested` and `source` (default, profile or override). A version 1 wrapper gets the same report with every capability unrequested.

Switching on an unsupported capability fails instead of doing nothing. `inferos:check` still prints the report, with `ok: false`, and exits nonzero; `doctor` reports a runtime error; `dev` refuses to start; and `run-dev-server.ts --consumer-root` throws before any Worker is prepared. The same three commands also refuse a version 2 file when the pinned revision's own `scripts/consumer/config.ts` is missing or rejects it, because the pinned launcher parses that file itself.

## InferOps integration (`INFEROPS_ENABLED`)

| Property | Value |
| --- | --- |
| Owner | Deployer: the wrapper's `capabilities.INFEROPS_ENABLED` (version 2). Not an administrator or rollout setting. |
| Default | Off in version 2; no profile turns it on and no other flag implies it. Version 1 wrappers, the plain checkout and cloud installs behave as before (on). |
| Dependencies | `INFEROPS_CANVAS_STATE_MACHINE` requires it (validated, never auto-enabled). `INFEROPS_AUTH` does not require it. Turning it on while `inferos.canvas.json` leaves `gatekeeper-inferops` out is a startup error. |
| Supported when | The pin contains `custom-gatekeepers/gatekeeper-inferops/src/enablement.ts` (`capabilitySources`). |
| Server enforcement | The gatekeeper (`enablement.ts`): no new binding, `DISABLED` on every call through an existing binding or session, queued moves not applied. See [InferOps gatekeeper](inferops-gatekeeper.md#integration-switch). |
| CLI | `inferos:check` reports it `enabled`/`supported` with provenance; `doctor` and `dev` accept it on supporting pins. |
| UI | Board cards show *InferOps is turned off* for `DISABLED` ([canvas](inferops-canvas.md#board-data-adapter)). |
| Declared tools | No separate gate: agent and gadget calls reach the same gatekeeper and get `DISABLED`. |
| Disable | Refuses at once; deletes nothing (bindings, queued moves, accounts, credentials kept). Rejecting a queued move still works. |
| Re-enable | Existing bindings and queued moves work again; nothing new is created or granted. |

`run-dev-server.ts --consumer-root` resolves the gatekeeper's `INFEROPS_ENABLED` var with `resolveInferOpsEnabled` (`scripts/dev-server-config.ts`) and always sets it. A version 2 wrapper's capability wins over the shell. Without a version 2 wrapper the gatekeeper keeps being installed by `inferos.canvas.json` and stays on, unless the shell sets `INFEROPS_ENABLED=false` (any other value fails startup). The gatekeeper treats an unset var as on, which only matters for deployments the dev server did not configure: the release manifest does not set it, so cloud installs are always on (a recorded gap in the [gatekeeper doc](inferops-gatekeeper.md#divergences-from-design)).

## Coding dispatch (`CODING_WORKBENCH_ENABLED`)

| Property | Value |
| --- | --- |
| Owner | Deployer: the wrapper's `capabilities.CODING_WORKBENCH_ENABLED` and `codingWorkbench.repos` (version 2). |
| Default | Off everywhere: version 2 default, version 1 wrappers, the plain checkout, cloud installs, and the gatekeeper with the var unset. |
| Dependencies | Requires `INFEROPS_ENABLED` (validated by the parser, and again by `resolveCodingWorkbenchEnabled` for the shell). |
| Supported when | The pin contains `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts`. |
| Server enforcement | The gatekeeper: the dispatch resource kind is neither offered nor bound, and every call of an existing dispatch binding or session, and every apply of a queued dispatch or cancel, fails `DISABLED`. See [local coding workflows](local-coding-workflows.md). |
| Allowlist | `codingWorkbench.repos[]`: `repoId` (lowercase UUID, unique), `path` (absolute), `testCommands` (1 to 20 one-line commands), `baseRef?` (git ref name); at most 50. `codingRepoIds` passes only the ids to the gatekeeper as `CODING_WORKBENCH_REPOS`; a dispatch of any other repository is refused before a request. Errors name the field, never the value. |
| Disable | Refuses at once; deletes nothing (bindings, queued dispatches and runs kept). Re-enable restores exactly those. |

`run-dev-server.ts --consumer-root` resolves the gatekeeper's `CODING_WORKBENCH_ENABLED` with `resolveCodingWorkbenchEnabled` and always sets it and `CODING_WORKBENCH_REPOS`. A version 2 wrapper's capability and allowlist win over the shell. Without one, the shell's `CODING_WORKBENCH_ENABLED=true` and `CODING_WORKBENCH_REPOS` try it locally (any other value of the switch fails startup), and on while `INFEROPS_ENABLED` resolves off is a startup error.

## Canonical fixture validation

`generate-board-schema.ts` exports the canonical InferOps board DTO through Zod JSON Schema from a clean reviewed checkout. `project-board.schema.json` records repository/revision/path/export provenance. `fixtures.ts` loads that generated contract through Zod and applies local sample bounds and relationship checks. The small relationship projection selects only keys needed for referential checks after canonical validation; it is not another complete board DTO. No gatekeeper protocol or data authorization is implemented by this module.

Generated wrappers expose fixtures:check; doctor and dev invoke the pinned validator. Missing support or dependencies fails explicitly. Fixture mode checks a regular bounded JSON file and rejects symlinked fixture directory/files, duplicate IDs, project-reference mismatch and inconsistent column membership/workflow. It reports only counts and schema revision. Remote mode avoids the fixture entirely and remains startup-blocked. The schema is generated from InferOps 29b01a024c377b9c37b8754e7001b290e15d1509; drift checks against a different revision require explicit regeneration and review.

## Design authority

The `obsidian_designs` front matter identifies intended design in the `authored` vault.
Read the owning notes through the [Obsidian CLI workflow](_brain.md); references do not
imply complete implementation.
