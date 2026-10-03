---
title: InferOS repository setup skills
covers:
  - scripts/run-dev-server.ts
  - scripts/generate-worker-configs.ts
  - scripts/release/manifest-lib.ts
  - .agents/skills
  - packages/workshop-backend/scripts/upload-consumer-skills.ts
updated: 2026-10-03
---

# InferOS repository setup skills

## Overview

InferOS supplies a bootstrap skill and deterministic consumer scripts. They create a pinned wrapper, validate its configuration and synthetic board, and run native local development. The remaining maintenance and cloud workflows are tracked in the [design](../design/repo-setup-skills.md).

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/run-dev-server.ts` | Existing local startup orchestration. |
| `scripts/generate-worker-configs.ts` | Generated config synchronization. `--consumer-root <wrapper>` also covers the wrapper's own gatekeepers, and `syncWorkerConfigs` generates or checks any given set of Worker directories ([wrapper topology](local-development.md#wrapper-topology)). |
| `scripts/release/manifest-lib.ts` | Deployable discovery and inputs. |
| `.agents/skills/bootstrap-inferos` | Consumer setup, configuration (including applying a reviewed intake) and evidence guidance. |
| `.agents/skills/skill-upload` | Installing, authoring (with skill-creator) and publishing wrapper skills. |
| `scripts/consumer` | Atomic scaffolding, profile resolution, preflight, fixture/view/extension/skill-pack validation and intake application ([customer onboarding](customer-onboarding.md)). |
| `scripts/consumer/settings.ts` | The executable settings table for the selected private customer, validated by wrapper `doctor` and generating the [configuration reference](../wiki/configuration-reference.md#selected-customer-settings) section; `settings.test.ts` fails on drift ([details](consumer-configuration.md#data-and-control-flow)). |
| `scripts/consumer/skill-packs` | Starter `operate`, `build` and `shared` runtime skills that bootstrap copies to `skills/`. |
| `scripts/consumer/skills.ts`, `skill-manifest.ts` | Read `inferos.skills.json`, collect pack files (excludes, includes, limits, no links) and validate `SKILL.md` frontmatter. |
| `packages/workshop-backend/scripts/upload-consumer-skills.ts` | Local administrator upload of packs into public Context Library collections. |

## Data and Control Flow

Bootstrap generates an exact submodule gitlink, copied command helpers and skill, explicit profile settings, synthetic data, starter views and editable extension directories. Generated commands delegate to the pinned native implementation. Checks report configuration provenance, dirty upstream state and pending runtime adapters; setup uses frozen dependencies. See [consumer configuration](consumer-configuration.md) for current implementation details. The external cloudflare-os-starter remains a research reference, not a dependency of this scaffolder. The [starter inventory](../wiki/starter-inventory.md) maps each step of its operator flow to an InferOS command, says what was adapted and what was not adopted, and records its licence review.

### Skill packs

Bootstrap copies `scripts/consumer/skill-packs` to the wrapper's `skills/`, writes the default `inferos.skills.json` and copies the `skill-upload` skill. The wrapper's commands map as follows:
- `skills:check` runs the pinned `scripts/consumer/skills.ts` and needs `pnpm run setup` for its `yaml`/`zod` dependencies. `doctor` runs the same check.
- `skills:install` runs `pnpm dlx skills@1.7.0 add … --yes` in the wrapper.
- `skills:upload` runs the pinned uploader.

The uploader opens the same capnweb session as `profile:init` (`authenticate` → `getGatekeeperApp("context").ui`) and requires `getViewerInfo().isAdmin`. The Context Library is opt-in by default, so if the administrator has no Context account yet, it first calls `provisionAmbientAccount("context")`, the same as adding it on the Connectors page. A dry run only reports `provisionContextAccount`. Per pack it then:
1. Matches a public collection by title, or creates one.
2. Compares each file's body and content type with `getContextDocument`.
3. Writes new and changed files, six at a time.
4. Lists remote-only files as `stale`, and deletes them only with `--prune`.
5. Re-lists the collection to confirm each `SKILL.md` carries its `skillName`.

Server errors are not echoed. `skill-manifest.ts` restates `parseSkillManifest`, because the gatekeeper module cannot run under plain Node. `packages/gatekeeper-context/__tests__/consumer-skill-manifest.test.ts` asserts that both give identical results.

## Configuration

Use the repo-pinned pnpm and lockfile. Do not edit generated wrangler.jsonc. Installable gatekeepers default to OAuth credential inputs unless manifest policy overrides them.

## Divergences from Design

Bootstrap, local startup, profile/style initialization, fixture validation and guarded canvas layouts have local evidence. General lifecycle/health verification, reviewed upgrade/recovery automation, authorized InferOps data loading and consumer cloud deployment remain backlog work. Native fixture/schema checks must not be described as a completed board read/approve/refresh flow. Settings validation covers only the selected private local customer (#19's MVP scope), not the design's full identity, admin, model, gatekeeper, storage, router and observability schema. Skill upload reaches only the local Workshop. Packs are not uploaded automatically when `pnpm dev` starts.

## Open Questions

- How much of the upstream starter operator skill can be reused verbatim under its license and version contract?
- The selected customer's settings are now one executable table with a generated reference. Whether the remaining explanatory rows (admin, model, storage, router, observability) move into it is post-release.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
