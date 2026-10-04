---
title: Reusable native agent authoring
status: draft
updated: 2026-10-03
---

# Reusable native agent authoring

Tracking epic: [#4](https://github.com/factory-level/inferos/issues/4); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Bring AI Trader’s reusable authoring discipline into InferOS while keeping execution on native Gadgets, bindings, callbacks and schedules.

## Requirements

- Expose common create/read/edit/validate/diff/publish operations to UI and agents through native contracts.
- Represent instructions, immutable skill references, model requirements and binding requirements without embedding credentials.
- Qualify a revision with reproducible proof evidence bound to the exact artifact and dependency revisions.
- Export/import portable native artifacts and explicitly rebind destination capabilities.
- Keep deployment configuration authority distinct from ordinary user/workspace authoring.

## Behavior

An author edits a draft, validates its native contract, inspects the diff, runs deterministic fixture proofs and publishes a named immutable revision. Changes to instructions, skills, model constraints or bindings invalidate the prior qualification. Import verifies the artifact, presents required bindings and obtains destination authority; it never imports source credentials or live execution state. Native callable agents and scheduler callbacks supply execution. Proofs cover enqueue-versus-completion semantics and idempotent retries before they are advertised as reliable workflow building blocks.

## Proposed contract

Added 2026-10-03. The owner asked for contract PRs for #15, #16 and #17 in this wave. Everything in this section is a **proposal pending owner review**. It is not implemented. The types are in `packages/workshop-shared/src/agent-artifact.ts`, and the rationale is in [ADR 0006](../adr/0006-agent-artifact-revisions.md) (proposed).

### Operation mapping

Each authoring operation, mapped onto what exists today (see the [architecture inventory](../architecture/agent-authoring.md#native-operations-available-today)):

| Operation | Reuse | Missing |
| --- | --- | --- |
| Create a draft | `Overseer.createGadget()`; the draft is a gadget's committed files | None |
| Read | `Overseer.listTree()`, `readFilesAtCommit()` for drafts | `getArtifactRevision(ref)` and `listArtifactRevisions(kind, name)` for published revisions |
| Edit | Chat code changes and commits | None |
| Validate | — | `validateArtifact()`: builds the manifest, computes the digest and returns every refusal publishing would meet, without storing anything |
| Diff | Chat and commit diffs for files | `diffArtifactRevisions(from, to)`: file, pin, model and binding changes between revisions |
| Qualify | Fixtures run as ordinary gadget code or `executeCode`, with `spawnCallable` and Scheduler paths exercised there | None in the kernel. A harness produces an `ArtifactQualification`, which publish verifies |
| Publish | Blueprint storage, which keeps every version in R2 | `publishArtifactRevision()`: author-chosen number, receiver-side digest, qualification and pin checks, refusals |
| Export | `PublicApi.downloadBlueprint()` | Format version 2 carrying the revision block (below) |
| Import | `AuthenticatedApi.importBlueprint()` | Verification of a version 2 archive. No new method |
| Rebind | `newGadgetFromBlueprint()` with `BlueprintBindingAssignment` | `bindArtifactRevision(ref, bindings)`, the same call keyed by exact revision |

The smallest authoring API is therefore six methods on `Overseer`, requiring workspace build access: `validateArtifact`, `diffArtifactRevisions`, `publishArtifactRevision`, `listArtifactRevisions`, `getArtifactRevision` and `bindArtifactRevision`. Their signatures are `ArtifactAuthoringProposal` in the shared module. Export and import keep their existing methods and gain format version 2. Each method lands in its own kernel PR after review. This resolves the first open question.

### Identity, digest and canonicalisation

- A revision is named `<kind>/<name>@<N>` (`ArtifactRef`). The kinds are `skill`, `agent` and `gadget`. `N` is chosen by the author and only increases. The name is for people, and the digest is the identity.
- The digest is `sha256:<hex>` over the canonical JSON of an `ArtifactManifest`: format, kind, each file path with the SHA-256 of its exact bytes, sorted pins (each with its digest), the model requirement and the binding requirements. Name, number, title, description, author, timestamps, qualification and every environment value are outside it.
- Canonical JSON is the integer subset of RFC 8785. Keys are sorted by UTF-16 code unit, members whose value is `undefined` are omitted, there is no whitespace, strings are escaped as `JSON.stringify` escapes them, and there is no Unicode normalisation. Any value two implementations could encode differently throws: fractional or unsafe numbers, `Date`, `bigint`, and `undefined` inside an array. `canonicalArtifactJson()` is the tested reference.
- The digest covers decoded file bytes, never archive bytes. A Blueprint's content is a gzip-compressed Yjs snapshot, which is not a canonical encoding.
- Binding requirements are derived from `BlueprintBinding` with every suggestion dropped (`resourceUrl`, `suggestedModel`, titles, spawner `env`), so a source environment never reaches the digest.

### Compatibility

This resolves the second open question.

- `ArtifactManifest.format` is `inferos-artifact/1`. A reader refuses a format it does not know with `unsupported_format` and never guesses. Any change to what the digest covers is a new format, and revisions under the old format keep their digests.
- `.gadget` archives move to format version 2: the same 24-byte prefix with version `2`, and the metadata JSON gains a revision block (name, number, digest, manifest, qualification). Version 1 readers already refuse version 2, so an old Workshop rejects a revision archive instead of importing it without verification. Import of version 1 stays unchanged.
- On import, the receiver decodes the snapshot, hashes every file, rebuilds the manifest, recomputes the digest and refuses a mismatch (`digest_mismatch`). It checks the qualification against the digest and resolves pins in the destination. Credentials, history and runtime state are never in the archive. Destination bindings are chosen fresh with `bindArtifactRevision`.

### Qualification

- An `ArtifactQualification` names one digest, the harness, an optional fixture-set digest and sanitised checks. Because the manifest includes pin digests, the artifact digest also binds the exact dependency revisions. Any change to instructions, files, skills, model requirement or bindings yields a new digest, and the old qualification is refused as `qualification_stale`.
- Each check is `deterministic` or `liveModel`. A revision is qualified only when it has at least one deterministic check and every deterministic check passed (`isQualified()`). Live-model checks are recorded and shown, and never gate publication, because their outcome is not reproducible.
- A check records a name, mode, pass or fail, at most 1,024 characters of detail and, for a live-model check, the model. It never records prompts, model responses, tool data, tokens or headers.
- Qualification is evidence produced by the author's harness, which the receiver checks for binding and completeness. It is not server-executed proof. Server-run qualification is listed below as an open question.

### Authority

- Workspace build access may create, edit, validate, diff and qualify. An agent may do all of these.
- Publish requires a signed-in person. An agent's publish request is queued as an action in the existing approval queue for that person to approve. No agent publishes, binds or activates on its own.
- Deploying a published `agent` revision is a separate authority under `AGENT_DEPLOYMENTS` ([agent deployments](agent-deployments.md)). Publishing never activates anything, registers any trigger or grants any binding.

## Non-Goals

No trading strategy, brokerage, market-data or financial-policy code in the reusable layer. No separate general workflow engine or replacement agent runtime.

## Acceptance and delivery

### Extract reusable AI Trader authoring contracts onto native InferOS primitives

Tracking issue: [#15](https://github.com/factory-level/inferos/issues/15) (`author-contract`).

- Inventory actual AI Trader registry code separately from issues #34/#42/#43/#80.
- Map create/read/edit/validate/diff to existing Gadget/Blueprint APIs and define only missing operations.
- Prove native deterministic Gadget, callable completion and scheduler paths with fixtures.
- Document user versus deployer authority and exclude trading domain/runtime dependencies.

### Add skill revision pinning and artifact qualification proofs

Tracking issue: [#16](https://github.com/factory-level/inferos/issues/16) (`author-proofs`).

- Pin skill dependencies and model/binding requirements in a validated artifact contract.
- Bind qualification to exact artifact/dependency digests and invalidate on any relevant change.
- Store sanitized proof results and distinguish deterministic fixtures from live model outcomes.
- Test stale qualification, altered dependency, incompatible versions and secret exclusion.

### Publish, import and rebind portable native agent artifacts

Tracking issue: [#17](https://github.com/factory-level/inferos/issues/17) (`author-publish`).

- Reuse native Blueprint serialization where possible; document any versioned extension.
- Import into a second clean workspace and explicitly bind destination models/resources.
- Reject tampered or incompatible artifacts; never transfer credentials, history or runtime data implicitly.
- Prove export/import round trip, revision selection and rollback to a known artifact.

## Open Questions

- Proposed (above, pending owner review): the smallest native authoring API, and digest canonicalisation and compatibility. These were the two baseline questions.
- Where revision records live. The proposal is a revision record beside the Blueprint record in the owner's User DO and KV, with content in the existing `<blueprintId>/<version>` R2 objects. Whether an `agent` or `skill` revision, which instantiates no gadget, should be a Blueprint at all is still open.
- How a `skill` revision is served. Context Library readers always get current content. A pinned skill needs its revision's exact bytes to stay readable, either kept by the Context Library or carried as files of the pinning artifact.
- Whether qualification should later run server-side, so that a deterministic result is reproduced rather than attested by the author's harness.
- Secret detection for `secret_present`: which patterns, and whether a refused file is reported by path only.

## Related

- [Current architecture](../architecture/agent-authoring.md)
- [ADR 0006: agent artifact revisions](../adr/0006-agent-artifact-revisions.md) (proposed)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)
