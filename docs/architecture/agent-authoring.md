---
title: Reusable native agent authoring
design: https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/agent-authoring.md
covers:
  - packages/workshop-shared/src/api.ts
  - packages/workshop-shared/src/agent-artifact.ts
  - packages/workshop-backend/src/agent-spawner-binding.d.ts
  - packages/workshop-backend/src/overseer.ts
  - packages/workshop-backend/src/blueprint-archive.ts
  - packages/workshop-backend/src/artifact-store.ts
  - packages/workshop-backend/src/artifact-publisher.ts
  - packages/workshop-backend/src/artifact-publisher-binding.d.ts
  - packages/gatekeeper-scheduler
  - packages/gatekeeper-context/src/agent-skill.ts
  - docs/blueprints.md
updated: 2026-11-02
---

# Reusable native agent authoring

## Overview

Current state after the revision-storage slice of [#16](https://github.com/factory-level/inferos/issues/16), built on the inventory of [#15](https://github.com/factory-level/inferos/issues/15) (InferOS `c340758`, AI Trader `c1301c8`). The six authoring methods of the [design](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/agent-authoring.md) are members of `Overseer` and are implemented by each workspace's Overseer: `validateArtifact`, `diffArtifactRevisions`, `publishArtifactRevision`, `listArtifactRevisions`, `getArtifactRevision` and `bindArtifactRevision`. Revisions are stored per workspace. An agent asks for a publish through a built-in artifact publisher gatekeeper, and a person approves it in the approval queue. `.gadget` format version 2 (#17) and Context Library skill revisions are not implemented yet (see [Divergences from Design](#divergences-from-design)).

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/api.ts` | Native Gadget, Blueprint, binding and agent APIs. |
| `packages/workshop-shared/src/agent-artifact.ts` | Artifact contract: types, canonical JSON digest, qualification predicate, exact reference parsing, refusal codes. |
| `packages/workshop-backend/src/artifact-store.ts` | Revision storage and every publish rule: manifest building, pin resolution, qualification and secret findings, manifest diff, immutable publish. |
| `packages/workshop-backend/src/artifact-publisher.ts` | `ArtifactPublisherGatekeeper`, the built-in gatekeeper behind an agent's `ArtifactPublisherBinding` (agent-facing types in `artifact-publisher-binding.d.ts`): `validate()` and `requestPublish()`, which queues an approval. |
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

### Agent spawner scope

`Overseer.bindWorkpiece()` validates an agent spawner's complete nested `config.env` against the gadget and its currently visible bindings. `Overseer.openGatekeeperSession()` returns a caller-bound spawner session; every `spawn()` and `spawnCallable()` rechecks the current bindings. Spawner sessions require a gadget caller or a spawned agent with recorded gadget lineage; direct user and ordinary chat sessions have no such scope and are refused. Spawned chats retain the originating gadget ID. Before each gadget or gatekeeper call, their frozen seed bindings are intersected with that gadget's live bindings, so unbinding or rebinding a resource revokes an existing child's access. Recursive spawner envs use the same scope check. Legacy spawned chats have no recorded parent gadget ID, so they fail closed at their next gadget or gatekeeper call and must be re-spawned to restore access. `packages/workshop-backend/__tests__/git-binding.test.ts` covers bind-time refusal, legacy callers, missing scope, nested spawners, and revocation after unbind/rebind.

### Configured agents (FAC-90)

An agent spawner is the workspace's configured agent. Its `AgentSpawnerConfig` is stored in the Overseer's `gatekeepers` collection as the record's `creationSpec`, and it is read back with `GatekeeperClient.getCreationSpec()`. A workspace can hold many.

- **What it records:** a name, a model (from the creator's account, or none), optional `instructions` (at most 8,000 characters, the deployment-instructions limit), and `env`, the bindings its agents can reach.
- **Behaviour and capability are separate operations, both needing `build`** (FAC-44's `requireSharedConfiguration`, as creating one does):
  - `Overseer.updateAgentSpawner(id, expected, behaviour)` changes the name, model or instructions. It refuses an `env` key, or any other key, so an edit can't carry a capability change.
  - `Overseer.setAgentSpawnerEnv(id, expected, env)` is the only way to change `env`, validated as at creation.
- **Only the creator** may change the model, the instructions or `env`: spawned agents run on the creator's account, act with the creator's authority, and reach their bindings with it, and the instructions decide what that authority is used for. Another `build` holder may change only the name, and the creator stays the same. `Overseer.getAgentSpawner(id)` returns the configuration and whether the caller created it. Who last changed an agent isn't recorded yet.
- **No self-spawning:** `setAgentSpawnerEnv` refuses an `env` that names the agent itself, or another agent whose `env` reaches it through further agents. Before `env` became editable it was fixed at creation, when the agent's own id didn't exist and every agent it named was older, so stored configurations hold no such cycle and no spawn-depth cap is added. A gadget an agent can reach may still bind agents of its own: that is the gadget's code choosing to spawn, as before.
- **Create** refuses any key that isn't an `AgentSpawnerConfig` field, and a blank name.
- **Stale edits:** both take the configuration the editor read (`expected`) and refuse if it has changed since. The change is applied to the configuration read at the write, after any await.
- **How a change takes effect:** the spawner's stub is rebuilt from the new configuration, keeping its creator, as the storage migration rebuilds it, and the running facet restarts onto it.
  - New spawns get the change. Agents already spawned keep the configuration they started with.
  - A widened `env` restarts the "use" sessions it reaches through a binding gadget, as binding does. Whether `env` stays within each calling gadget's bindings is still checked on every call (above).
- **In the prompt:** a spawned agent's instructions are added to its system prompt as configured behaviour that grants nothing (`formatAgentInstructions`), with any `</agent_instructions>` in the text escaped so it can't end the frame early. The bindings listed after them are all it can reach.
- **Tests:** `packages/workshop-backend/__tests__/agent-spawner-config.test.ts` covers reopening, behaviour edits leaving `env` alone, a refused capability change inside an edit, creator-only capability, model and instruction changes, refused self-reference and cycles, stale edits, bounds, and the call-time scope check after an `env` change.

### Artifact revisions

- A draft is a permanent gadget's committed code. `#artifactDraft` in the Overseer reads the gadget's head commit (`assertPublishableCommit`, the Blueprint check), its files (`GitStore.readCommitFiles`) and its binding metadata (`collectBindingMetadata`, the Blueprint path), and `WorkspaceArtifactStore.draft()` builds the `ArtifactManifest`. Each file is hashed as the UTF-8 bytes of its committed text, the only form gadget files take. Binding requirements keep only `type`, `gatekeeperName` and `typeUrlPattern`. Pins must arrive sorted and unique; any other order throws rather than being sorted.
- Refusal findings are computed in one order and the first is the publish result: `secret_present` (files), `pin_unresolved` / `pin_digest_mismatch`, then the qualification's `secret_present` (harness, check names and details), `qualification_stale` and `qualification_incomplete`, then the store's `revision_exists_different_digest` and `number_not_increasing`. `validateArtifact` returns the distinct codes from the draft. Malformed input (unknown kind, bad name or number, over-long check detail) throws a `TypeError` instead of being a refusal. Methods without a refusal slot throw an `Error` whose message starts with the code; `artifactRefusalOf()` reads it back.
- `secret_present` matches only well-known credential formats with a distinctive prefix or frame: PEM, OpenSSH and PGP private-key blocks, AWS access key ids, GitHub, GitLab and Slack tokens, OpenAI and Anthropic `sk-` keys of 32 or more characters, Google `AIza` keys, Stripe live keys and signed JWTs. It reports the file path or qualification field, never the matched text. Generic high-entropy strings and `password = ...` assignments are not matched, so a credential in that form is a false negative. The list is fixed in code and is not configurable per deployment (owner decision, 2026-10-06).
- The qualification is evidence from the author's harness. Publish checks only that it names the recomputed digest and has at least one deterministic check with every deterministic check passing; `liveModel` checks are stored and never consulted.
- `publishArtifactRevision` records the calling person as `publishedBy`. Every call on `OverseerClientInterface` belongs to a signed-in person's build session; agents never hold an `Overseer`, and use and operate sessions deny all six methods.
- Agents publish only through the approval queue. A person creates the workspace's publisher connection with `Overseer.newArtifactPublisherGatekeeper()` (creation spec `artifactPublisher`, build role only, excluded from blueprints) and binds it where an agent should reach it. The binding's `validate()` returns the draft digest and refusals. `requestPublish()` checks the request's shape, stores it in the gatekeeper's own storage under a new action number, and calls `ApprovalQueue.submitAction()` with `awaitDecision` and `autoApprovable: false`, so the agent's turn waits for the decision. The gatekeeper offers no auto-approvable action kind, so no rule can apply it.
- On manual approval, `OverseerImpl.applyPendingAction` records the approving person under `<gatekeeperId>:<action>` in an in-memory map for the duration of the gatekeeper's `applyAction()`, and only for an `artifactPublisher` connection that was not auto-approved. The gatekeeper calls `OverseerDurableObject.publishApprovedArtifact(action, request)`, which publishes through the same `publishArtifact` path as a build session, with that person as `publishedBy`. It refuses unless exactly one publisher is applying that action number. This keeps approver identity out of the `Gatekeeper` interface. The manifest and qualification are rebuilt at approval, so a gadget changed since qualification is refused. A refusal throws from `applyAction`, which leaves the action pending with the reason until a person rejects it. Rejection deletes the stored request. A published revision cannot be reverted.
- Storage is the Overseer's `artifactRevisions` collection, keyed `<kind>/<name>@<keyString(number)>` so one name lists in number order. A record is the wire `ArtifactRevision` plus `commitId` (the commit its files were read from; git objects are never collected, so the record keeps them) and `bindingTemplates` (titles, `spawnerOnly` and spawner env, with source `resourceUrl` and `suggestedModel` dropped). Neither extra field crosses RPC. Revisions are never edited or deleted. The author-chosen number plays the part of the canvas and console stores' expected revision: `WorkspaceArtifactStore.publish()` checks it against the stored name and number and writes in one `transactionSync`, so two racing publishes cannot both land. An identical republish returns the stored revision with `created: false`.
- `bindArtifactRevision` runs every compatibility check before it creates anything, so a refusal leaves nothing behind. The assignments must name exactly the revision's binding requirements with matching types. Each chosen account is resolved through `getGatekeeperClassFor` (the admin-policy chokepoint, which creates no state) and must be of the requirement's `gatekeeperName` vendor. Every assigned model must meet an `exact` model requirement, checked through the person's model configuration, and every spawner env entry must name an assigned connection. Only then does it create a permanent gadget at the revision's commit and bind in `newGadgetFromBlueprint()`'s two phases. Connections are created from the already-resolved accounts (`newGatekeeper`'s second half), and through `newAiModelGatekeeper` and `newAgentSpawnerGatekeeper`. Rolling back is binding an earlier exact revision. Blueprint install behaviour is unchanged.

## Configuration

Model and gatekeeper bindings are installed in the destination workspace. Scheduler hooks must be enabled through Connections. `BUNDLED_BLUEPRINTS_DIR` selects deployment bundles, and does not establish artifact qualification.

## Divergences from Design

- Revisions live in the publishing workspace's Overseer, with content in its git store, rather than beside Blueprint records in the owner's User DO, KV and R2 (the design's open question on where records live). `bindArtifactRevision` therefore instantiates only within that workspace until `.gadget` v2 export and import exist.
- The design lands each method in its own kernel PR. The owner's implementation plan for #16 delivered all six in one PR, together with their storage.
- Still unimplemented: `.gadget` format version 2 and its import verification, skill revisions served from the Context Library, and server-run qualification.

### Against the 2026-11-02 product design

Recorded on 2026-11-02 against `364deb91c`; the design is InferOps [`docs/human/architecture/agent-operations.md`](https://github.com/factory-level/inferops/tree/develop/docs/human/architecture/agent-operations.md).

- Agents are created from a Gadget, a model and resource bindings in the spawner form. Since FAC-90 they also carry instructions and can be reopened and edited, with capability changes kept to their own step (above). There are still no named, reusable capability bundles, and no assigned authority for system workflows (I08): an agent's authority is its creator's.
- No personal Dot: the OpenDots integration (identity and persistence isolation, gatekeeper capabilities, UI dispatch and approval callbacks, Intelligence hosting) is unstarted (I11).
- `spawn` and `spawnCallable` acknowledge a queued task; actual run progress and results to configured destinations are not tracked (I09).

## Open Questions

- See the [design's open questions](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/agent-authoring.md#open-questions). The two baseline questions were decided by the owner on 2026-10-05: the design's contract and [ADR 0006](../adr/0006-agent-artifact-revisions.md) are accepted as proposed.
- The agent route uses a built-in gatekeeper binding modelled on the agent spawner (owner decision, 2026-10-06). The Workshop has no UI yet for creating the publisher connection.

## Evidence

See the [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
