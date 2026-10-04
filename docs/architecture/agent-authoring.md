---
title: Reusable native agent authoring
covers:
  - packages/workshop-shared/src/api.ts
  - packages/workshop-shared/src/agent-artifact.ts
  - packages/workshop-backend/src/agent-spawner-binding.d.ts
  - packages/workshop-backend/src/blueprint-archive.ts
  - packages/gatekeeper-scheduler
  - packages/gatekeeper-context/src/agent-skill.ts
  - docs/blueprints.md
updated: 2026-10-03
---

# Reusable native agent authoring

## Overview

Current-state inventory for [#15](https://github.com/factory-level/inferos/issues/15), inspected at InferOS `c340758` and AI Trader `c1301c8`. Nothing in the [design](../design/agent-authoring.md) is implemented. The one new file, `packages/workshop-shared/src/agent-artifact.ts`, holds the proposed contract as types plus three pure helpers (`canonicalArtifactJson`, `artifactDigest`, `isQualified`) and their tests. No backend code imports it, and no RPC interface exposes it.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/api.ts` | Native Gadget, Blueprint, binding and agent APIs. |
| `packages/workshop-shared/src/agent-artifact.ts` | Proposed artifact contract (types, canonical JSON digest, qualification predicate). Not wired. |
| `packages/workshop-backend/src/agent-spawner-binding.d.ts` | Callable agents and completion callback contract. |
| `packages/workshop-backend/src/blueprint-archive.ts` | `.gadget` archive format v1 encode and decode. |
| `packages/gatekeeper-scheduler` | Persistent workspace callbacks. |
| `packages/gatekeeper-context/src/agent-skill.ts` | Context Library skills advertised to agents. |
| `docs/blueprints.md` | Portable code and binding requirements. |

### Native operations available today

| Operation | Existing API | What it does not do |
| --- | --- | --- |
| Create | `Overseer.createGadget()`, `GadgetClient.createBlueprint()` | No artifact kind, name or author-chosen number. |
| Read | `Overseer.listTree()`, `Overseer.readFilesAtCommit()`, `PublicApi.getBlueprint()`, `AuthenticatedApi.listOwnBlueprints()` / `getOwnBlueprint()` | No read by exact revision of a named artifact. |
| Edit | Chat code changes (`CodeChange`, `ChatCodeBase`) committed to the gadget's git history | None for drafts; edits are already per-chat and reviewable. |
| Validate | Binding checks inside `newGadgetFromBlueprint()` (missing binding, invalid account or model) | No validation of pins, model requirement, qualification or secrets before publishing. |
| Diff | Per-chat diff against pinned commits; commit-to-commit by reading trees | No revision-to-revision diff covering pins, model and binding requirements. |
| Publish | `GadgetClient.createBlueprint()`, `Overseer.updateBlueprint({updateCode})` | `version` increments implicitly. No digest, no qualification, no refusal of a changed revision under an existing number. |
| Export | `PublicApi.downloadBlueprint()` (`.gadget` v1) | Carries no digest; content is a gzip-compressed Yjs snapshot, whose bytes are not canonical. |
| Import | `AuthenticatedApi.importBlueprint()` | Accepts any well-formed v1 archive; nothing to verify integrity against. |
| Rebind | `AuthenticatedApi.newGadgetFromBlueprint(id, Record<name, BlueprintBindingAssignment>)` | Nothing missing: destination accounts, resources and models are chosen fresh, and credentials never travel. |
| Run on call | `AgentSpawnerBinding.spawnCallable()` | Resolves when the call is durably queued. Completion arrives only if the gadget passes a persistent callback stub. |
| Run on schedule | Scheduler `every()`, `calendarAt()`, `runAt()` with a persistent `ScheduledTaskHook` | Registration creates a disabled hook the user enables in Connections, is not idempotent, and retries reuse `runId`. |
| Skills | Context Library collections; `buildAgentSkillCatalogEntries()` advertises skill documents by `collectionId/path` | No revision or digest. A git-sourced collection records the last refreshed `commit`, but readers always get current content. |

### AI Trader registry inventory

Read-only reference: `/libs/backend/registry` and `apps/cli/src/user.ts` in factory-level/ai-trader at `c1301c8`. This is the code itself, separate from the planned work in ai-trader #42 and #43 (open) and #34 and #80 (closed).

| AI Trader code | Reusable here | Notes |
| --- | --- | --- |
| `Kind` enum | Partly | `skill` and `agent` carry over, and `workflow` maps to `gadget`. `strategy`, `study`, `view` and `brand` are trading or product kinds. |
| `Pin {kind, name, number, content_hash}` | Yes | Becomes `ArtifactPin`, with `content_hash` renamed `digest`. |
| `Qualification {content_hash, tool, checks[]}` | Yes, extended | Has no deterministic versus live-model distinction, and requires every check to pass. |
| `PublishRequest`, `createRegistry().publish` | Yes, the rules | Receiver recomputes the hash, checks qualification and pins, keeps name+number to hash one-to-one, numbers only increase, and records refusals. Storage is Postgres or memory. Here it would be Blueprint storage. |
| Refusal codes | Yes | `content_hash_mismatch`, `qualification_incomplete`, `pin_unresolved`, `pin_hash_mismatch`, `revision_exists_different_hash` and `number_not_increasing`. |
| `canonicalJson` | The rule, not the code | Sorts keys and drops `undefined` members. It encodes a `Date` as `{}` without complaint, and an `undefined` array element as nothing, so `[1, undefined]` becomes the invalid `[1,]`. |
| `sha256` → `sha256:<hex>` | Yes | Uses Node `Buffer`; Workers needs a `crypto.subtle` form. |
| `gadget-files-v1` (`artifact()` in the CLI) | The idea | Canonical JSON of path to base64 bytes, hashed as one blob and limited to 1 MiB. |
| `StudyRequest`, `createStudy`, studies | No | Trading A/B studies with starting capital. |
| `connections.ts` | No | AI Trader lab service connections. InferOS gatekeepers already own connections. |
| CLI `qualify` (`suite()`) | No | Runs a Docker-hosted vitest suite against a mounted Gadget, and is specific to that repository. |

## Data and Control Flow

InferOS already provides native Gadgets, Blueprint import/export, bindings and callable agents. `spawnCallable` persists an enqueue, and completion uses callbacks rather than synchronous task completion. Scheduler callbacks are persistent but not exactly-once. Blueprint export does not contain live SQLite state, history or credentials. Blueprint code versions are retained in R2 under `<blueprintId>/<version>`, so earlier versions stay readable. `.gadget` v1 is a 24-byte prefix (magic, format version `1`, metadata length, content length), then JSON `BlueprintMetadata`, then the content bytes. It carries no digest, and the reader refuses any other format version.

## Configuration

Model and gatekeeper bindings are installed in the destination workspace. Scheduler hooks must be enabled through Connections. `BUNDLED_BLUEPRINTS_DIR` selects deployment bundles, and does not establish artifact qualification.

## Divergences from Design

Everything the design specifies is unimplemented except the shared types and helpers: validate, diff, publish and list/get revision; `.gadget` v2; skill revisions in the Context Library; and qualification harnesses.

## Open Questions

- See the [design's open questions](../design/agent-authoring.md#open-questions). The two baseline questions now have proposals pending owner review in the design and [ADR 0006](../adr/0006-agent-artifact-revisions.md).

## Evidence

See the [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
