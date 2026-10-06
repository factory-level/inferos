---
title: Reusable native agent authoring
covers:
  - packages/workshop-shared/src/api.ts
  - packages/workshop-shared/src/agent-artifact.ts
  - packages/workshop-backend/src/agent-spawner-binding.d.ts
  - packages/workshop-backend/src/blueprint-archive.ts
  - packages/workshop-backend/src/artifact-store.ts
  - packages/gatekeeper-scheduler
  - packages/gatekeeper-context/src/agent-skill.ts
  - docs/blueprints.md
updated: 2026-10-06
---

# Reusable native agent authoring

## Overview

Current state after the revision-storage slice of [#16](https://github.com/factory-level/inferos/issues/16), built on the inventory of [#15](https://github.com/factory-level/inferos/issues/15) (InferOS `c340758`, AI Trader `c1301c8`). The six authoring methods of the [design](../design/agent-authoring.md) are members of `Overseer` and are implemented by each workspace's Overseer: `validateArtifact`, `diffArtifactRevisions`, `publishArtifactRevision`, `listArtifactRevisions`, `getArtifactRevision` and `bindArtifactRevision`. Revisions are stored per workspace. `.gadget` format version 2 (#17), an agent-facing publish request through the approval queue, and Context Library skill revisions are not implemented yet (see [Divergences from Design](#divergences-from-design)).

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/api.ts` | Native Gadget, Blueprint, binding and agent APIs. |
| `packages/workshop-shared/src/agent-artifact.ts` | Artifact contract: types, canonical JSON digest, qualification predicate, exact reference parsing, refusal codes. |
| `packages/workshop-backend/src/artifact-store.ts` | Revision storage and every publish rule: manifest building, pin resolution, qualification and secret findings, manifest diff, immutable publish. |
| `packages/workshop-backend/src/overseer.ts` | The six `Overseer` methods (build sessions only; use and operate sessions deny them) and the `artifactRevisions` collection. |
| `packages/workshop-backend/src/agent-spawner-binding.d.ts` | Callable agents and completion callback contract. |
| `packages/workshop-backend/src/blueprint-archive.ts` | `.gadget` archive format v1 encode and decode. |
| `packages/gatekeeper-scheduler` | Persistent workspace callbacks. |
| `packages/gatekeeper-context/src/agent-skill.ts` | Context Library skills advertised to agents. |
| `docs/blueprints.md` | Portable code and binding requirements. |

### Native operations available today

| Operation | Existing API | What it does not do |
| --- | --- | --- |
| Create | `Overseer.createGadget()`, `GadgetClient.createBlueprint()` | No artifact kind, name or author-chosen number. |
| Read | `Overseer.listTree()`, `Overseer.readFilesAtCommit()` for drafts; `Overseer.getArtifactRevision(ref)` and `listArtifactRevisions(kind, name)` for published revisions | Revisions are readable only in the workspace that published them until `.gadget` v2 carries them elsewhere. |
| Edit | Chat code changes (`CodeChange`, `ChatCodeBase`) committed to the gadget's git history | None for drafts; edits are already per-chat and reviewable. |
| Validate | `Overseer.validateArtifact(gadgetId, kind, pins, model)` | Model compatibility is checked at bind, not at validate. |
| Diff | `Overseer.diffArtifactRevisions(from, to)` over two published revisions of one name; chat and commit diffs for drafts | No diff of a draft against a revision; validate the draft and compare manifests. |
| Publish | `Overseer.publishArtifactRevision()`; Blueprint publishing is unchanged | Callable only from a person's build session. No agent-facing request route yet. |
| Export | `PublicApi.downloadBlueprint()` (`.gadget` v1) | Carries no digest; content is a gzip-compressed Yjs snapshot, whose bytes are not canonical. |
| Import | `AuthenticatedApi.importBlueprint()` | Accepts any well-formed v1 archive; nothing to verify integrity against. |
| Rebind | `Overseer.bindArtifactRevision(ref, bindings)` in the publishing workspace; `AuthenticatedApi.newGadgetFromBlueprint()` for Blueprints | Cross-workspace rebind needs `.gadget` v2 import (#17). |
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

### Artifact revisions

- A draft is a permanent gadget's committed code. `#artifactDraft` in the Overseer reads the gadget's head commit (`assertPublishableCommit`, the Blueprint check), its files (`GitStore.readCommitFiles`) and its binding metadata (`collectBindingMetadata`, the Blueprint path), and `WorkspaceArtifactStore.draft()` builds the `ArtifactManifest`. Each file is hashed as the UTF-8 bytes of its committed text, the only form gadget files take. Binding requirements keep only `type`, `gatekeeperName` and `typeUrlPattern`. Pins must arrive sorted and unique; any other order throws rather than being sorted.
- Refusal findings are computed in one order and the first is the publish result: `secret_present` (files), `pin_unresolved` / `pin_digest_mismatch`, then the qualification's `secret_present` (harness, check names and details), `qualification_stale` and `qualification_incomplete`, then the store's `revision_exists_different_digest` and `number_not_increasing`. `validateArtifact` returns the distinct codes from the draft. Malformed input (unknown kind, bad name or number, over-long check detail) throws a `TypeError` instead of being a refusal. Methods without a refusal slot throw an `Error` whose message starts with the code; `artifactRefusalOf()` reads it back.
- `secret_present` matches only well-known credential formats with a distinctive prefix or frame: PEM, OpenSSH and PGP private-key blocks, AWS access key ids, GitHub, GitLab and Slack tokens, OpenAI and Anthropic `sk-` keys of 32 or more characters, Google `AIza` keys, Stripe live keys and signed JWTs. It reports the file path or qualification field, never the matched text. Generic high-entropy strings and `password = ...` assignments are not matched, so a credential in that form is a false negative. The list is fixed in code and is not configurable per deployment (owner decision, 2026-10-06).
- The qualification is evidence from the author's harness. Publish checks only that it names the recomputed digest and has at least one deterministic check with every deterministic check passing; `liveModel` checks are stored and never consulted.
- `publishArtifactRevision` records the calling person as `publishedBy`. Every call on `OverseerClientInterface` belongs to a signed-in person's build session; agents never hold an `Overseer`, and use and operate sessions deny all six methods.
- Storage is the Overseer's `artifactRevisions` collection, keyed `<kind>/<name>@<keyString(number)>` so one name lists in number order. A record is the wire `ArtifactRevision` plus `commitId` (the commit its files were read from; git objects are never collected, so the record keeps them) and `bindingTemplates` (titles, `spawnerOnly` and spawner env, with source `resourceUrl` and `suggestedModel` dropped). Neither extra field crosses RPC. Revisions are never edited or deleted. The author-chosen number plays the part of the canvas and console stores' expected revision: `WorkspaceArtifactStore.publish()` checks it against the stored name and number and writes in one `transactionSync`, so two racing publishes cannot both land. An identical republish returns the stored revision with `created: false`.
- `bindArtifactRevision` runs every compatibility check before it creates anything, so a refusal leaves nothing behind. The assignments must name exactly the revision's binding requirements with matching types. Each chosen account is resolved through `getGatekeeperClassFor` (the admin-policy chokepoint, which creates no state) and must be of the requirement's `gatekeeperName` vendor. Every assigned model must meet an `exact` model requirement, checked through the person's model configuration, and every spawner env entry must name an assigned connection. Only then does it create a permanent gadget at the revision's commit and bind in `newGadgetFromBlueprint()`'s two phases. Connections are created from the already-resolved accounts (`newGatekeeper`'s second half), and through `newAiModelGatekeeper` and `newAgentSpawnerGatekeeper`. Rolling back is binding an earlier exact revision. Blueprint install behaviour is unchanged.


## Configuration

Model and gatekeeper bindings are installed in the destination workspace. Scheduler hooks must be enabled through Connections. `BUNDLED_BLUEPRINTS_DIR` selects deployment bundles, and does not establish artifact qualification.

## Divergences from Design

- The design has an agent's publish request queued in the approval queue. No agent-facing surface reaches the authoring methods yet: they are `Overseer` methods, and agents never hold an `Overseer`. Agents can draft, and run qualification fixtures as gadget code or `executeCode`; a person publishes from a build session.
- Revisions live in the publishing workspace's Overseer, with content in its git store, rather than beside Blueprint records in the owner's User DO, KV and R2 (the design's open question on where records live). `bindArtifactRevision` therefore instantiates only within that workspace until `.gadget` v2 export and import exist.
- The design lands each method in its own kernel PR. The owner's implementation plan for #16 delivered all six in one PR, together with their storage.
- Still unimplemented: `.gadget` format version 2 and its import verification, skill revisions served from the Context Library, and server-run qualification.

## Open Questions

- See the [design's open questions](../design/agent-authoring.md#open-questions). The two baseline questions were decided by the owner on 2026-10-05: the design's contract and [ADR 0006](../adr/0006-agent-artifact-revisions.md) are accepted as proposed.
- An agent's publish request will reach the approval queue through a built-in gatekeeper binding, modelled on the agent spawner (owner decision, 2026-10-06). That is a separate PR.

## Evidence

See the [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
