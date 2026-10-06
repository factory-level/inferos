---
title: Customer feature capabilities
covers:
  - scripts/consumer/config.ts
  - scripts/consumer/runtime.ts
  - scripts/dev-server-config.ts
  - custom-gatekeepers/gatekeeper-inferops/src/enablement.ts
  - custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts
  - custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts
updated: 2026-10-05
---

# Customer feature capabilities

## Overview

The eight-name capability vocabulary of [ADR 0001](../adr/0001-customer-capability-flag-vocabulary.md) is accepted by `inferos.config.json` schema version 2 ([#84](https://github.com/factory-level/inferos/pull/84), closing [#67](https://github.com/factory-level/inferos/issues/67)). Three capabilities have runtime code: `INFEROPS_ENABLED` ([#103](https://github.com/factory-level/inferos/pull/103)), `INFEROPS_AUTH` ([#94](https://github.com/factory-level/inferos/pull/94)) and `CODING_WORKBENCH_ENABLED` (coding dispatch through the InferOps gatekeeper, [#69](https://github.com/factory-level/inferos/issues/69)/[#70](https://github.com/factory-level/inferos/issues/70)). The other five are accepted as configuration, reported `unsupported`, and refused when switched on. Resolution across the CLI, deployment, server, tools and UI ([#33](https://github.com/factory-level/inferos/issues/33)) is unfinished.

The detailed current state lives in [consumer configuration](consumer-configuration.md), which owns the same files; this page is the capability-shaped view of it.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/consumer/config.ts` | `CAPABILITY_NAMES`, the version 2 parser, `CAPABILITY_REQUIREMENTS`, `LEGACY_FLAG_COMPATIBILITY`, `migrateConsumerConfig` and `inferOpsAuthRequested`. |
| `scripts/consumer/runtime.ts` | `capabilitySources` (the pinned file that makes an installation honour each capability), `unsupportedCapabilities`, the `inferos:check` capability report and `migrateWrapperConfig` (`pnpm inferos config migrate`). |
| `scripts/dev-server-config.ts` | `resolveInferOpsEnabled`, `resolveCodingWorkbenchEnabled` and the InferLab sign-in variables, used by `run-dev-server.ts`. |
| `custom-gatekeepers/gatekeeper-inferops/src/enablement.ts` | Server enforcement of `INFEROPS_ENABLED`: every data-source call is refused with `DISABLED` while it is off. |
| `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts` | Server enforcement of `CODING_WORKBENCH_ENABLED` and the wrapper's repository allowlist: the dispatch resource kind is refused, and every call of a dispatch binding fails `DISABLED`, while it is off. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts` | The InferLab sign-in and per-person connect flows that `INFEROPS_AUTH` turns on. |

## Data and Control Flow

A version 2 file resolves each capability from its default (off), then its profile (none sets one), then an explicit override, with per-field provenance. The parser validates that `INFEROPS_CANVAS_STATE_MACHINE` and `CODING_WORKBENCH_ENABLED` each require `INFEROPS_ENABLED`, and never turns a flag on by itself. `inferos:check`, `doctor`, the wrapper `dev` command and `run-dev-server.ts --consumer-root` all refuse a switched-on capability whose `capabilitySources` file is absent from the pin. See [capability flags and schema version 2](consumer-configuration.md#capability-flags-and-schema-version-2).

| Capability | State at `main` | Where it is enforced |
| --- | --- | --- |
| `INFEROPS_ENABLED` | Supported | The gatekeeper refuses new bindings and every call through existing ones; see [InferOps integration](consumer-configuration.md#inferops-integration-inferops_enabled). |
| `INFEROPS_AUTH` | Supported | The dev server adds `inferops` to `AUTH_GATEKEEPERS` and checks the InferLab origin before startup; see [InferOps-backed sign-in](consumer-configuration.md#inferops-backed-sign-in). |
| `INFEROPS_CANVAS_STATE_MACHINE` | Unsupported | None. |
| `HARNESS_HG_ENABLED` | Unsupported | None. |
| `PUBLISH_CLOUDFLAREOS_WIDGET` | Unsupported | None. |
| `PUBLISH_CLOUDFLAREOS_APP` | Unsupported | None. |
| `AGENT_DEPLOYMENTS` | Unsupported | None. |
| `CODING_WORKBENCH_ENABLED` | Supported | The gatekeeper refuses dispatch bindings and every call through existing ones, and dispatches only allowlisted repositories; see [local coding workflows](local-coding-workflows.md). |

## Configuration

`inferos.config.json` `schemaVersion: 2` with a required `capabilities` object. New wrappers are written as version 1 unless bootstrapped with `--capability`. `pnpm inferos config migrate` migrates an existing wrapper, and `pnpm inferos intake apply` migrates before it switches on the capabilities a reviewed intake asks for that the pin supports ([customer onboarding](customer-onboarding.md)). In-repo, without a wrapper, the shell's `INFEROPS_ENABLED` (`"true"` or `"false"`, default on), `CODING_WORKBENCH_ENABLED` (default off) with `CODING_WORKBENCH_REPOS`, and `AUTH_GATEKEEPERS`/`INFERLAB_AUTH_ORIGIN` stand in.

## Divergences from Design

- The [design](../design/feature-capabilities.md) still says current code accepts only the legacy flags. Since #84 the eight names are accepted in version 2; that sentence describes the state before #84.
- The design requires each capability to be enforced at server operations, declared tools, the CLI and the UI, with a named owner, default and disable policy. Only `INFEROPS_ENABLED` has all of these recorded. `INFEROPS_AUTH` has startup and sign-in enforcement only. `CODING_WORKBENCH_ENABLED` is enforced by the gatekeeper and has a default (off), but no declared-tool, CLI or UI surface yet. None has a cloud deployment path: the release manifest sets neither `INFEROPS_ENABLED` (so cloud installs are always on) nor `CODING_WORKBENCH_ENABLED` (always off).
- The design requires a publication operation to be denied while its flag is off. Neither publication flag has code, but the upstream blueprint paths publish anyway, whatever the flags say: `PublicApi.getBlueprint` and `downloadBlueprint` serve any blueprint's metadata and `.gadget` archive to whoever holds its id, without sign-in, and an admin can feature any gadget-backed blueprint. The [publication destinations](../design/feature-capabilities.md#publication-destinations) ([ADR 0008](../adr/0008-publication-destinations.md), accepted by the owner 2026-10-05) address this and are not implemented yet. When implemented, existing blueprint links become unpublished (no grandfathering), and self-approval needs the `PUBLICATION_SELF_APPROVAL` env setting, which does not exist in code yet.

## Open Questions

- The owner and default of each capability other than `INFEROPS_ENABLED`, and when bootstrap should write version 2. These are listed under the [consumer configuration open questions](consumer-configuration.md#open-questions).
