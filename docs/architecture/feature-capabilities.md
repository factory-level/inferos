---
title: Customer feature capabilities
covers:
  - scripts/consumer/config.ts
  - scripts/consumer/runtime.ts
  - scripts/dev-server-config.ts
  - custom-gatekeepers/gatekeeper-inferops/src/enablement.ts
  - custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts
  - custom-gatekeepers/gatekeeper-inferops/src/table.ts
  - custom-gatekeepers/gatekeeper-inferops/src/host-board.ts
  - custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts
  - packages/workshop-backend/src/publication.ts
  - packages/workshop-backend/__tests__/publication.test.ts
  - packages/integration-tests/__tests__/workshop-publication.test.ts
  - packages/integration-tests/__tests__/workshop-blueprints.test.ts
  - packages/workshop-frontend/src/features/publication
  - packages/workshop-frontend/src/BlueprintModal.tsx
  - packages/workshop-frontend/src/BlueprintLandingPage.tsx
  - packages/workshop-frontend/src/AdminPage.tsx
  - packages/workshop-frontend/src/hooks/useBlueprintScreenshotSrc.ts
  - packages/workshop-frontend/src/components/BlueprintPreviewImage.tsx
  - packages/workshop-frontend/src/BlueprintsPage.tsx
updated: 2026-10-08
---

# Customer feature capabilities

## Overview

The eight-name capability vocabulary of [ADR 0001](../adr/0001-customer-capability-flag-vocabulary.md), plus `INFEROPS_TABLES_ENABLED` (read-only custom tables, MVP-20), is accepted by `inferos.config.json` schema version 2 ([#84](https://github.com/factory-level/inferos/pull/84), closing [#67](https://github.com/factory-level/inferos/issues/67)). Six capabilities have runtime code: `INFEROPS_ENABLED` ([#103](https://github.com/factory-level/inferos/pull/103)), `INFEROPS_AUTH` ([#94](https://github.com/factory-level/inferos/pull/94)), `CODING_WORKBENCH_ENABLED` (coding dispatch through the InferOps gatekeeper, [#69](https://github.com/factory-level/inferos/issues/69)/[#70](https://github.com/factory-level/inferos/issues/70)), `PUBLISH_CLOUDFLAREOS_WIDGET` and `PUBLISH_CLOUDFLAREOS_APP` (publication records, [#68](https://github.com/factory-level/inferos/issues/68)), and `INFEROPS_TABLES_ENABLED` (read-only custom-table bindings through the InferOps gatekeeper, see [custom tables](inferops-gatekeeper.md#custom-tables)). The other three are accepted as configuration, reported `unsupported`, and refused when switched on. Resolution across the CLI, deployment, server, tools and UI ([#33](https://github.com/factory-level/inferos/issues/33)) is unfinished.

`INFEROPS_HOST_BOARDS` (the kernel-only host-board read, see [host boards](inferops-gatekeeper.md#host-boards)) is a **proposed** extension of ADR 0001's vocabulary, recorded here as `INFEROPS_TABLES_ENABLED` was. Unlike it, the name is not yet accepted by `inferos.config.json`: only the InferOps gatekeeper reads it, as a worker var, so nothing a wrapper or the dev server writes can turn it on yet (see [the enforcement inventory](#host-boards-enforcement-inventory)).

The detailed current state lives in [consumer configuration](consumer-configuration.md), which owns the same files; this page is the capability-shaped view of it.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/consumer/config.ts` | `CAPABILITY_NAMES`, the version 2 parser, `CAPABILITY_REQUIREMENTS`, `LEGACY_FLAG_COMPATIBILITY`, `migrateConsumerConfig` and `inferOpsAuthRequested`. |
| `scripts/consumer/runtime.ts` | `capabilitySources` (the pinned file that makes an installation honour each capability), `unsupportedCapabilities`, the `inferos:check` capability report and `migrateWrapperConfig` (`pnpm inferos config migrate`). |
| `scripts/dev-server-config.ts` | `resolveInferOpsEnabled`, `resolveCodingWorkbenchEnabled`, `resolveInferOpsTablesEnabled`, `resolvePublicationFlag` and the InferLab sign-in variables, used by `run-dev-server.ts`. |
| `packages/workshop-frontend/src/features/publication` | The publication UI: `PublicationReview` (Build's request step), `AdminPublicationsPanel` (the admin review list), and the shared record summary and withdraw form. See [publication records](#publication-records). |
| `packages/workshop-backend/src/publication.ts` | Server enforcement of both publication flags: the flag checks, each record's derived status, the reach check and the KV snapshot it reads. See [publication records](#publication-records). |
| `custom-gatekeepers/gatekeeper-inferops/src/enablement.ts` | Server enforcement of `INFEROPS_ENABLED`: every data-source call is refused with `DISABLED` while it is off. |
| `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts` | Server enforcement of `CODING_WORKBENCH_ENABLED` and the wrapper's repository allowlist: the dispatch resource kind is refused, and every call of a dispatch binding fails `DISABLED`, while it is off. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts` | The InferLab sign-in and per-person connect flows that `INFEROPS_AUTH` turns on. |
| `custom-gatekeepers/gatekeeper-inferops/src/host-board.ts` | Server enforcement of the proposed `INFEROPS_HOST_BOARDS`: `hostBoardsEnabled` is checked on every call of the board facet's kernel-only `readHostBoardSnapshot` (answering `unavailable` / `disabled` with no request) and `connectionIdentity` (null), and needs `INFEROPS_ENABLED` on. |
| `custom-gatekeepers/gatekeeper-inferops/src/table.ts` | Server enforcement of `INFEROPS_TABLES_ENABLED`: the custom-table resource kind is withheld and refused, and every call of a table binding fails `DISABLED`, while it is off. |

## Data and Control Flow

A version 2 file resolves each capability from its default (off), then its profile (none sets one), then an explicit override, with per-field provenance. The parser validates that `INFEROPS_CANVAS_STATE_MACHINE`, `CODING_WORKBENCH_ENABLED` and `INFEROPS_TABLES_ENABLED` each require `INFEROPS_ENABLED`, and never turns a flag on by itself. `inferos:check`, `doctor`, the wrapper `dev` command and `run-dev-server.ts --consumer-root` all refuse a switched-on capability whose `capabilitySources` file is absent from the pin. See [capability flags and schema version 2](consumer-configuration.md#capability-flags-and-schema-version-2).

| Capability | State at `main` | Where it is enforced |
| --- | --- | --- |
| `INFEROPS_ENABLED` | Supported | The gatekeeper refuses new bindings and every call through existing ones; see [InferOps integration](consumer-configuration.md#inferops-integration-inferops_enabled). |
| `INFEROPS_AUTH` | Supported | The dev server adds `inferops` to `AUTH_GATEKEEPERS` and checks the InferLab origin before startup; see [InferOps-backed sign-in](consumer-configuration.md#inferops-backed-sign-in). |
| `INFEROPS_CANVAS_STATE_MACHINE` | Unsupported | None. |
| `HARNESS_HG_ENABLED` | Unsupported | None. |
| `PUBLISH_CLOUDFLAREOS_WIDGET` | Supported | The Workshop backend refuses every publication operation for widget-kind blueprints and suspends their publications; see [publication records](#publication-records). |
| `PUBLISH_CLOUDFLAREOS_APP` | Supported | The same, for app- and workflow-kind blueprints. |
| `AGENT_DEPLOYMENTS` | Unsupported | None. |
| `CODING_WORKBENCH_ENABLED` | Supported | The gatekeeper refuses dispatch bindings and every call through existing ones, and dispatches only allowlisted repositories; see [local coding workflows](local-coding-workflows.md). |
| `INFEROPS_TABLES_ENABLED` | Supported | The gatekeeper withholds the custom-table resource kind and its picker, refuses table bindings and every call through existing ones; see [custom tables](inferops-gatekeeper.md#custom-tables). |
| `INFEROPS_HOST_BOARDS` | Proposed; not in the schema | The gatekeeper's kernel-only host-board read refuses every call while it is off (or `INFEROPS_ENABLED` is); see [host boards](inferops-gatekeeper.md#host-boards). No kernel caller exists yet. |

### Host boards enforcement inventory

Where `INFEROPS_TABLES_ENABLED` is resolved, and what this change does with `INFEROPS_HOST_BOARDS` at each place:

| Place | `INFEROPS_TABLES_ENABLED` | `INFEROPS_HOST_BOARDS` |
| --- | --- | --- |
| Gatekeeper worker env type (`src/env.d.ts`) | Declared | Declared |
| Gatekeeper enforcement | `table.ts`, on every call | `host-board.ts`, on every call of both kernel-only methods |
| Connection metadata (`connection.json` `credentials`, `enabledBy`) | Listed, and the `object/table` kind's switch | Listed as a var; no resource kind names it, since the read adds none |
| Generated env types (`worker-configuration.d.ts`) and committed `wrangler.jsonc` vars | Neither (left unset, like every InferOps var) | Neither |
| Workshop backend Worker | Not read | Not read |
| Wrapper vocabulary (`scripts/consumer/config.ts` `CAPABILITY_NAMES`, `CAPABILITY_REQUIREMENTS`) | Accepted, requires `INFEROPS_ENABLED` | Not wired |
| Capability sources (`scripts/consumer/runtime.ts`) | `table.ts` | Not wired |
| Settings and doctor (`scripts/consumer/settings.ts`) | Reported, checked for contradiction | Not wired |
| Dev server (`dev-server-config.ts` `resolveInferOpsTablesEnabled`, `run-dev-server.ts`, `env-passthrough.test.ts`) | Resolved and always set on the gatekeeper | Not wired: always unset, so off |
| Release manifest | Not set (cloud installs off) | Not set (off) |
| Effective frontend capability (`ServerConfig`) | None | None |

Deliberately not wired yet, because each belongs to a later change: the wrapper vocabulary and its settings, doctor and capability-source entries; dev-server resolution; a kernel caller (the overseer reaching the facet), its registry and selection of a board; and any browser exposure. Until the dev server resolves it, the lane is reachable only from tests.

## Publication records

Option A of the [publication destinations design](../design/feature-capabilities.md#publication-destinations) ([ADR 0008](../adr/0008-publication-destinations.md), decided by the owner on 2026-10-05 in [#68](https://github.com/factory-level/inferos/issues/68)): a blueprint is reachable beyond its owner and the installs made inside the deployment only while it has an active, approved publication record pinning its current version.

**Records.** `PublicationRecord` (`workshop-shared/src/api.ts`) holds the artifact (`blueprintId`, `version`, `digest` as `sha256:` of the version's code snapshot, `kind`, and the title the reviewer saw), the destination (`deployment` or `export`), the audience in words, `publishedBy`, `requestedAt`, `approvedBy`, `selfApproved`, `at`, re-confirmations, and `withdrawnBy`/`withdrawnAt`/`reason`. Each field is written once and a record is never deleted. The owner's User DO holds the authoritative copy (`publications` collection, `decidePublication` writes each decision). `AdminSettings` mirrors every record for review (`mirrorPublication`) and writes the approved, unwithdrawn ones, with the flag history, to the reserved BLUEPRINTS KV key `.publications`, which the reach checks read. `status` is derived on read and never stored: `requested`, `active`, `suspended` (flag off), `unconfirmed` (flag seen off since the last approval or re-confirmation) or `withdrawn`.

**Operations.** The owner calls `AuthenticatedApi.requestPublication` (only for a blueprint in their own published list; asking again for a standing version and destination returns that record), `listOwnPublications` and `withdrawPublication`. A deployment admin uses `AdminApi.listPublications`, `approvePublication`, `confirmPublication` and `withdrawPublication` (withdrawing a request refuses it). Approval is refused when the blueprint has moved past the pinned version (`artifactChanged`), and when the approver is the requester unless the env var `PUBLICATION_SELF_APPROVAL=true` (read in `auth/config.ts`, never `AdminConfig`); a self-approval sets `selfApproved`. Approving withdraws the blueprint's earlier active record for the same destination, and a `deployment` approval also features the blueprint. Failures carry `PUBLICATION_ERROR_CODES`.

**Reach.** `PublicApi.getBlueprint` returns null and `downloadBlueprint` refuses with `notPublished` unless the blueprint is bundled or its current version has an active `export` record. The featured listing (`listFeaturedBlueprintsFromKv`, which serves Explore and the agent's `listBlueprints`) keeps bundled blueprints and featured ones whose current version has an active `deployment` record; the featured bit itself is kept. `AdminApi.setBlueprintFeatured(id, true)` is refused without that record. Republishing (a new version) leaves every record pinned to the old one, so reach stops until a new record is approved. Signed-in people read any blueprint by id through `AuthenticatedApi.getBlueprintInfo` and install it through `newGadgetFromBlueprint`, as Operate installs need. The screenshot route `/blueprint-screenshot/<id>` follows `PublicApi`'s rule (bundled, or an active `export` record for the current version), plus any request carrying a valid Cloudflare Access assertion (`verifyCfAccessJwt`, when `CF_ACCESS_AUD` is set), and answers 404 otherwise; a non-bundled screenshot is sent `private, no-store` so no shared cache outlives a withdrawal. The route has no other session (the session token travels in-band over RPC), so signed-in surfaces read screenshots through `AuthenticatedApi.getBlueprintScreenshot`, with the same audience as `getBlueprintInfo`.

**Flags.** `PUBLISH_CLOUDFLAREOS_WIDGET` covers `widget`; `PUBLISH_CLOUDFLAREOS_APP` covers `app` and `workflow` (`publicationFlagFor`). Each is off unless exactly `"true"`. While a kind's flag is off, request, approve, confirm and withdraw are refused with `widgetFlagOff`/`appFlagOff`, and its records are `suspended`, so nothing of that kind reaches anyone. `AdminSettings` records the time it last saw each flag off when it starts (a deploy restarts it, and every isolate's first `/api` request wakes it); a record approved or re-confirmed before that time is `unconfirmed` once the flag is on again, and reaches nothing until an admin re-confirms it. `ServerConfig.publication` reports both flags and the self-approval setting to clients.

**UI.** The UI is offered only while a flag is on (`ServerConfig.publication`), and the server refuses whatever it hides. In Build, each blueprint row in the blueprints dialog (`BlueprintModal`) has **Publish…**, which opens `PublicationReview` in place of the list. It shows what would go out (the current version, kind, description, the connections an installer makes, and a note that chats, data, credentials and accounts never go), asks for a destination with its audience, and requests it. Below that it lists the blueprint's own records, with **Cancel request** or **Withdraw**. A kind whose flag is off shows a notice and no request. Admin has a **Publications** tab (`AdminPublicationsPanel`): every record with its artifact, digest, audience and history, and **Approve**, **Re-confirm**, **Refuse** or **Withdraw** as its status allows. A refusal from the server (self-approval, a changed blueprint, a flag off) is shown on that row. Withdrawing asks for a reason and says what it cannot undo; the form takes focus, Escape returns focus to the button that opened it, and after a withdrawal focus moves to the changed row or the step's heading. The blueprint landing page reads through `getBlueprintInfo` when someone is signed in, so owners still see their unpublished blueprints, and explains a refused download or feature toggle. Every signed-in image site (Explore cards, the blueprint lists and Library, the landing page and the Build edit preview) shows the screenshot through `useBlueprintScreenshotSrc`, which reads it with `getBlueprintScreenshot` into a blob URL revoked on change or unmount, and uses the public URL only when signed out.

**Migration effect.** There is no grandfathering. Once this ships, every existing blueprint link (`/blueprint/<id>` read or `.gadget` download without signing in) stops working until its owner requests an `export` publication and an admin approves it, and every featured user blueprint leaves the featured listing until it has an active `deployment` record. Bundled blueprints and output formats are deployment configuration and keep working.

`workshop-publication.test.ts` covers, against one deployment reloaded with different env: flags off refuse an existing link and its screenshot while bundled blueprints, installs and the signed-in screenshot read work; request, approval (self-approval refused), reach, withdrawal and refusal; deployment listing and featuring; self-approval with the setting on; suspension, then re-confirmation after the flag returns; and the screenshot route (404 unpublished, `deployment`-published or withdrawn; 200 exported or with a valid Access assertion).

## Configuration

`inferos.config.json` `schemaVersion: 2` with a required `capabilities` object. New wrappers are written as version 1 unless bootstrapped with `--capability`. `pnpm inferos config migrate` migrates an existing wrapper, and `pnpm inferos intake apply` migrates before it switches on the capabilities a reviewed intake asks for that the pin supports ([customer onboarding](customer-onboarding.md)). In-repo, without a wrapper, the shell's `INFEROPS_ENABLED` (`"true"` or `"false"`, default on), `CODING_WORKBENCH_ENABLED` (default off) with `CODING_WORKBENCH_REPOS`, `PUBLISH_CLOUDFLAREOS_WIDGET` and `PUBLISH_CLOUDFLAREOS_APP` (default off), and `AUTH_GATEKEEPERS`/`INFERLAB_AUTH_ORIGIN` stand in. `run-dev-server.ts` always sets both publication vars on the Workshop backend, from a version 2 wrapper's capabilities or else the shell, and passes `PUBLICATION_SELF_APPROVAL` through from the shell. None of the three is in the release manifest, so cloud deployments have publication off.

## Divergences from Design

- The [design](../design/feature-capabilities.md) still says current code accepts only the legacy flags. Since #84 the eight names are accepted in version 2; that sentence describes the state before #84.
- The design requires each capability to be enforced at server operations, declared tools, the CLI and the UI, with a named owner, default and disable policy. Only `INFEROPS_ENABLED` has all of these recorded. `INFEROPS_AUTH` has startup and sign-in enforcement only. `CODING_WORKBENCH_ENABLED` is enforced by the gatekeeper and has a default (off), but no declared-tool, CLI or UI surface yet. The publication flags are enforced by the server and default off; there is no publication CLI command or agent tool (the agent never publishes); the UI hides what a flag turns off. None has a cloud deployment path: the release manifest sets neither `INFEROPS_ENABLED` (so cloud installs are always on) nor `CODING_WORKBENCH_ENABLED` nor the publication flags (always off).
- Publication: the proposal says a blueprint reaches beyond its owner and its Operate installs only with an active record. Inside the deployment, any signed-in person holding a blueprint id can still read it (`getBlueprintInfo`) and install it (`newGadgetFromBlueprint`), published or not, because there is no operate space to tell an Operate install from any other; so the `deployment` destination gates the featured listing, not installs by id.
- Publication: a flag seen off is recorded only when `AdminSettings` starts while it is off. A deployment switched off and on again with no `/api` traffic in between resumes its records without re-confirmation.
- Publication: on deployments without Cloudflare Access, a screenshot link loads for nobody outside the export audience, signed in or not; only the RPC read serves signed-in people.
- Publication: withdrawal and suspension reach the hot path through the KV snapshot, so another location can serve a withdrawn record until its KV cache expires (the featured listing already behaves this way).
- Publication: a blueprint imported from an archive cannot be published by its importer; only blueprints published from the owner's own workspaces can.

## Open Questions

- `INFEROPS_HOST_BOARDS` is proposed only: whether it joins the version 2 vocabulary under that name (the others end in `_ENABLED`), who owns it and when the dev server and wrappers resolve it are undecided.
- The owner and default of each capability other than `INFEROPS_ENABLED`, and when bootstrap should write version 2. These are listed under the [consumer configuration open questions](consumer-configuration.md#open-questions).
