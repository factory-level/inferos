---
title: InferOS repository setup skills
covers:
  - scripts/run-dev-server.ts
  - scripts/generate-worker-configs.ts
  - scripts/release/manifest-lib.ts
  - .agents/skills
updated: 2026-10-01
---

# InferOS repository setup skills

## Overview

InferOS supplies a bootstrap skill and deterministic consumer scripts. They create a pinned wrapper, validate its configuration and synthetic board, and run native local development. The remaining maintenance and cloud workflows are tracked in the [design](../design/repo-setup-skills.md).

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/run-dev-server.ts` | Existing local startup orchestration. |
| `scripts/generate-worker-configs.ts` | Generated config synchronization. |
| `scripts/release/manifest-lib.ts` | Deployable discovery and inputs. |
| `.agents/skills/bootstrap-inferos` | Consumer setup, configuration and evidence guidance. |
| `scripts/consumer` | Atomic scaffolding, profile resolution, preflight and fixture/view/extension validation. |

## Data and Control Flow

Bootstrap generates an exact submodule gitlink, copied command helpers and skill, explicit profile settings, synthetic data, starter views and editable extension directories. Generated commands delegate to the pinned native implementation. Checks report configuration provenance, dirty upstream state and pending runtime adapters; setup uses frozen dependencies. See [consumer configuration](consumer-configuration.md) for current implementation details. The external cloudflare-os-starter remains a research reference, not a dependency of this scaffolder.

## Configuration

Use the repo-pinned pnpm and lockfile. Do not edit generated wrangler.jsonc. Installable gatekeepers default to OAuth credential inputs unless manifest policy overrides them.

## Divergences from Design

Bootstrap, local startup, profile/style initialization, fixture validation and guarded canvas layouts have local evidence. General lifecycle/health verification, reviewed upgrade/recovery automation, authorized InferOps data loading and consumer cloud deployment remain backlog work. Native fixture/schema checks must not be described as a completed board read/approve/refresh flow.

## Open Questions

- How much of the upstream starter operator skill can be reused verbatim under its license and version contract?
- Which machine-readable configuration schema best prevents divergence between explanations and executable defaults?

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
