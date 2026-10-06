---
title: Customer feature capabilities
status: draft
updated: 2026-10-05
---

# Customer feature capabilities

Tracking: [capability flags #33](https://github.com/factory-level/inferos/issues/33); roadmap: [#1](https://github.com/factory-level/inferos/issues/1). Decision record: [ADR 0001](../adr/0001-customer-capability-flag-vocabulary.md).

## Purpose

Give every customer InferOS one versioned configuration contract that says which capabilities the installation offers, and have humans, coding agents, CI, the server, tools and the UI all read the same resolved result.

This is a draft target. Current code accepts only the legacy flags `composableViews`, `durableViews` and `customCloudflareCode` described in [consumer configuration](consumer-configuration.md). The eight names below are the intended vocabulary, not names the code accepts today.

## Requirements

### Vocabulary

| Flag | Responsibility |
| --- | --- |
| `INFEROPS_ENABLED` | Enable the tenant-scoped InferOps integration. It does not provision a tenant or grant resources. |
| `INFEROPS_CANVAS_STATE_MACHINE` | Enable stateful Operate flow behavior. A persisted canvas layout alone is not flow execution. InferOps owns business transitions; native CloudflareOS primitives own runtime execution. |
| `HARNESS_HG_ENABLED` | Enable the HG platform integration. Native deployments, other adapters and local coding stay independent of it. |
| `INFEROPS_AUTH` | Select the InferOps-backed identity integration. When it is off, another supported authentication mode is required; there is never an anonymous authorization bypass. |
| `PUBLISH_CLOUDFLAREOS_WIDGET` | Enable an explicit widget publication path with artifact, destination and audience review. Flag-on is not a public release. |
| `PUBLISH_CLOUDFLAREOS_APP` | Enable an explicit application publication path, separate from agent activation and from business data sharing. |
| `AGENT_DEPLOYMENTS` | Enable the reviewed native persona/skill [agent deployment](agent-deployments.md) lifecycle and scoped capability bindings. |
| `CODING_WORKBENCH_ENABLED` | Enable [local coding workflow](local-coding-workflows.md) invocation by authorized humans and agents using a supported signed-in coding tool, without an LLM API key. No hosted workbench and no required push or PR. |

Provider and runtime adapter versions, resource references, policies, publication destinations and secret references are separate configuration fields. Do not add a boolean for every provider.

### Migration and compatibility

- `inferos.config.json` stays versioned, with the exact foundation pin and nonsecret inputs.
- Implement an explicit migration and compatibility mapping from `composableViews`, `durableViews` and `customCloudflareCode`. The migration preserves existing customer configuration.
- Do not map a durable layout to state-machine execution, and do not treat custom code activation as an agent permission.
- Keep a low-level flag where its meaning differs from the new vocabulary.
- Unknown keys, invalid types, incompatible combinations and unsupported runtime capabilities fail clearly.
- Report truthfully which flags and schema versions the installation supports.

### Resolution

- Resolve baseline defaults, then the selected profile, then explicit customer overrides, and report provenance per field.
- Preserve existing explicit customer settings. No profile or rollout silently expands authority.
- Installation capability and feature rollout are independent. A rollout cannot enable code that is not present in the installation.
- Code generation, development and deployment consume the same resolved configuration. There is no undocumented second configuration path for users versus developers.

### Dependencies

- `INFEROPS_CANVAS_STATE_MACHINE` requires the InferOps integration and valid configured flow and runtime dependencies.
- Native deployments do not require HG.
- Local coding requires neither HG nor native ChatGPT subscription inference.
- `CODING_WORKBENCH_ENABLED` requires `INFEROPS_ENABLED`: coding dispatch reaches the runner only through the InferOps gatekeeper.
- Validate each dependency explicitly. Never turn on another flag silently.

### Enforcement

- Enforce feature availability at authoritative server operations, declared tools, the CLI and the UI.
- Conflicting flags, missing bindings, unsupported adapters, and direct or stale-client calls fail clearly without implicit activation or scope expansion.

## Behavior

### What a flag means

A flag states availability. Five states stay distinct: installed, enabled, account-connected, resource-granted, and activated or published. Turning a feature on does not create identities, copy data, bind credentials or start spend. Publication keeps its artifact, destination and audience explicit, and local coding does not require cloud publication.

### Disabling and re-enabling

Disabling a runtime feature follows an explicit admission, drain and cancel policy. Retained definitions, history and authorized diagnostics are preserved. Running work is not orphaned, and disabling does not imply deletion. Re-enabling does not restore revoked grants. Scope revocation stays effective after reload, after a feature is disabled and re-enabled, and after a copied view or artifact is imported.

## Publication destinations

Tracking: [#68](https://github.com/factory-level/inferos/issues/68). Decision record: [ADR 0008](../adr/0008-publication-destinations.md) (accepted). Proposed 2026-10-03; **decided by the owner on 2026-10-05** ([#68 decision](https://github.com/factory-level/inferos/issues/68)). The decisions are listed under [decisions](#publication-decisions) below. Nothing is implemented yet, and `PUBLISH_CLOUDFLAREOS_WIDGET` and `PUBLISH_CLOUDFLAREOS_APP` stay unsupported until an implementation lands. Publication is post-release; the MVP private shell does not need it.

### Existing mechanisms

The design reuses what the Workshop already has rather than adding a parallel system. See [blueprints](../blueprints.md) and [sharing](../sharing.md).

| Mechanism | What it does today | Who can reach it |
| --- | --- | --- |
| Blueprint (`GadgetClient.createBlueprint`, `Overseer.updateBlueprint`/`deleteBlueprint`) | A versioned snapshot of a gadget's committed code and binding annotations. It carries no chat history, storage or credentials. | Its owner. |
| Blueprint link (`/blueprint/<id>`, `PublicApi.getBlueprint`, `PublicApi.downloadBlueprint`) | Shows the metadata and downloads the `.gadget` archive. Creating a gadget from it requires sign-in. | **Anyone holding the 128-bit id, without signing in.** |
| Library (`addBlueprintToLibrary`, `setBlueprintPinned`, `importBlueprint`) | Saves a blueprint by reference, or imports an archive as a new local blueprint owned by the importer. | One user. |
| Featured blueprints (`AdminApi.setBlueprintFeatured`, `listFeaturedBlueprints`) | A deployment-wide listing on Explore and in the agent's `listBlueprints` tool. Only an admin can feature. | Signed-in users of the deployment. |
| Publish to Operate ([operate mode](operate-mode.md#publishing)) | Packages a workspace as a blueprint and installs it at a pinned version into an operate space. | People in that operate space. |
| Workspace collaborators and share links (`createShareLink`) | Share a live workspace, including its data and bindings. | Named collaborators or link holders. |

Today every blueprint is already a link-holder publication: whoever has its id can read its metadata and download its code without signing in, whatever the flags say. A design that only adds new destinations behind the flags would leave that path open with both flags off. Each option below has to say what it does about that.

### What is and is not publication

- **Artifact.** Each flag publishes exactly one pinned blueprint version: a `widget`-kind workspace's blueprint for `PUBLISH_CLOUDFLAREOS_WIDGET`, and an `app`-kind workspace's blueprint for `PUBLISH_CLOUDFLAREOS_APP`. A version is identified by blueprint id, version number and a digest of the stored snapshot bytes. An artifact never includes chat history, storage, credentials, connected accounts, bindings or InferOps data. Its binding annotations say what an installer must connect, and they grant nothing. Mapping an artifact to a flag needs the blueprint to record its workspace kind, which it does not do yet (see the [operate mode divergences](../architecture/operate-mode.md#divergences-from-design)).
- **Publication.** Making a pinned artifact version reachable by an audience beyond its author's own workspaces and the operate spaces it was installed into.
- **Not publication.** Publish to Operate (it stays inside the deployment and is governed by [operate mode](operate-mode.md)). Sharing a workspace with collaborators or a share link (that shares a live workspace and its data, and has its own controls in [sharing](../sharing.md)). The deployment's bundled blueprints and output formats (deployment configuration shipped by the deployer, not something a user publishes).

### Candidate destinations

| Destination | Mechanism it builds on | Audience | Review | Withdraw |
| --- | --- | --- | --- | --- |
| `deployment` | The featured listing: Explore, the agent's `listBlueprints`, and installation through `newGadgetFromBlueprint` | Signed-in users of this deployment | A deployment admin approves, as featuring already requires | The listing and new installs stop at once. Gadgets already created from it keep running: they are independent copies. |
| `export` | `downloadBlueprint` producing a `.gadget` archive for `importBlueprint` on another deployment | Whoever receives the file, and the receiving deployment's importer | A deployment admin approves before the archive can be downloaded | Further downloads are refused. A file already downloaded cannot be recalled, and an import elsewhere is that deployment's own copy. The record says so. |
| `link` | `/blueprint/<id>` with unauthenticated `PublicApi.getBlueprint`/`downloadBlueprint`, today's upstream behavior | Anyone with the link, including people outside the deployment | A deployment admin approves | Link reads are refused. Copies already downloaded cannot be recalled. |

Rejected or deferred:

- **Public hosting of a live app** (an app reachable on the open web without sign-in). No mechanism exists, and a live app runs against someone's bindings and data, so it would share business data. Rejected.
- **An external catalog or marketplace across deployments.** No mechanism exists. Deferred to a later ADR if it is ever wanted.

### Options

**Option A (chosen by the owner, 2026-10-05): publication records decide reachability.** A blueprint is reachable beyond its owner and its Operate installs only while it has an active publication record for a destination. With no record, a blueprint is unpublished: its owner can use it and Publish to Operate can install it, but `PublicApi.getBlueprint` and `downloadBlueprint` refuse it and an admin cannot feature it. The initial destinations are `deployment` and `export`. `link` is defined but not offered at first, because it is unauthenticated and reaches outside the deployment, and the MVP is a private shell.

- With both flags off, nothing leaves the deployment through a blueprint, which is what #68's acceptance requires.
- It changes upstream behavior in the kernel (`PublicApi` and featuring), so it is a fork divergence from `cloudflare/cloudflare-os` and is held to the [kernel bar](../../REVIEW.md). Existing blueprint links stop working: the owner decided against grandfathering (see [migration effect](#migration-effect-on-existing-blueprint-links)).

**Option B (not chosen): the flags gate only new destinations.** Blueprint links, archive downloads and featuring keep their upstream behavior, and the flags gate only a new `deployment`/`export` publish action. It is the smallest change and needs no kernel change. But with both flags off, any blueprint's code still leaves the deployment by link, so a flag-off deployment is not one that publishes nothing. Choose it only if the owner rules that a blueprint link is data sharing, not publication.

**Option C (not chosen): a flag gates blueprint creation for its kind.** It is coarse, and it breaks Publish to Operate and output formats, which are built on blueprints. Not recommended.

### Publication record

Each publication appends one record. A record is never edited except to add its withdrawal, and never deleted.

| Field | Meaning |
| --- | --- |
| `id` | Record id. |
| `artifact` | `{ blueprintId, version, digest, kind }`: the exact version published and its workspace kind. |
| `destination` | `deployment`, `export` or `link`. |
| `audience` | What the destination reaches, stated in words the reviewer saw: this deployment's users, an export's stated target, or link holders. |
| `publishedBy` | The person who requested it. |
| `approvedBy` | The admin who approved it. |
| `selfApproved` | `true` when `approvedBy` is `publishedBy`, which is possible only with `PUBLICATION_SELF_APPROVAL` set. |
| `at` | When it took effect. |
| `withdrawnBy`, `withdrawnAt`, `reason` | Set when it is withdrawn. |

- A record pins one version. `updateBlueprint({ updateCode: true })` does not move a publication. Publishing a newer version to the same destination appends a new record that replaces the earlier one at that destination.
- Withdrawing stops new reach at that destination immediately. It does not uninstall gadgets already created from the artifact, and it cannot recall archives already downloaded. The record and the UI say both.
- Storage (decided): the owner's User DO is authoritative, next to the blueprint record, as it is for the `featured` bit, and `AdminSettings` mirrors active `deployment` records for listing.

### Review step

1. The author requests a publication and sees exactly what will go out: the artifact version and digest, its kind, title, description, screenshot and binding annotations, the destination and the audience.
2. A deployment admin approves or refuses it in the admin panel, where featuring already lives. The request and the decision are both kept.
   - **Self-approval** (an admin approving their own request) is off by default. It is allowed only when the deployment sets the environment variable `PUBLICATION_SELF_APPROVAL`. That setting is authorization configuration, so it is deliberately **not** part of `AdminConfig`: like `AUTH_GATEKEEPERS` and `DISABLE_PASSWORD_AUTH`, it stays env-driven so a compromised admin session cannot turn it on (see `AGENTS.md`). A self-approved record says so: `approvedBy` equals `publishedBy`, and the record carries `selfApproved: true`, which the record view and admin panel show.
3. An agent may at most draft a request. It never approves one, and the operate chat never publishes, because Operate does not author.

### Enforcement with the flag off

| Surface | Operations | With the flag off |
| --- | --- | --- |
| Server (kernel) | Request, approve and withdraw publication, featuring a blueprint of that kind and, under Option A, `PublicApi` reads of an unpublished blueprint | Refused with a coded error that names the flag. A stale client or a direct RPC call gets the same refusal. |
| CLI | Any `pnpm inferos` publication command (none exists yet), plus the `inferos:check` capability report | The command refuses, and the report stays truthful. The flag reaches the backend the way `CODING_WORKBENCH_ENABLED` does, through the dev server and later the release manifest. Until a manifest path exists, cloud deployments are off. |
| Agent tools | Any publication tool | Not offered in the tool list, and refused at the server if called anyway. |
| UI | The publish action and the admin review queue | Hidden. The server still refuses a direct call. |

Turning a flag off makes its destinations unreachable without changing the records. Turning it back on does not resume them: each one needs to be confirmed again, because resuming automatically would be publication by a flag change.

### Flag-on is availability, not a release

- Turning a flag on makes the request action available, and nothing else. No blueprint, record, listing or archive is created by a deploy, a profile, `intake apply`, `config migrate`, or a flag change. No profile sets either flag.
- Publishing an app does not activate an agent: that is [`AGENT_DEPLOYMENTS`](agent-deployments.md). It does not share business data either: an installer reaches InferOps only through their own gatekeeper bindings and grants.

### Migration effect on existing blueprint links

The owner decided that existing unauthenticated blueprint links are **unpublished, with no grandfathering**. When Option A lands:

- No `link` record is created for any existing blueprint. Every blueprint that exists at migration has no publication record, so it is unpublished.
- `/blueprint/<id>`, `PublicApi.getBlueprint` and `PublicApi.downloadBlueprint` refuse every such blueprint for anyone but its owner. Links already handed out stop working, including in bookmarks, chats and documents, and a signed-out visitor gets the refusal instead of the metadata and archive.
- Featured blueprints are no longer listed until a `deployment` record is approved for them; the stored `featured` bit stays but no longer grants reach.
- Nothing is deleted. The owner keeps using the blueprint, Publish to Operate can still install it, and existing library references and gadgets already created from it keep working, because those are the owner's own use or independent copies.
- To make one reachable again, its owner requests a publication for `deployment` or `export` and an admin approves it. `link` is not offered yet, so there is no way to restore an unauthenticated link until it is.
- Archives already downloaded and imports already made elsewhere are unaffected and cannot be recalled.

### Publication decisions

Decided by the owner on 2026-10-05 ([#68 decision](https://github.com/factory-level/inferos/issues/68)):

- [x] **Option A.** Publication records decide reachability.
- [x] **Initial destinations** are `deployment` and `export`. `link` comes later. Public live hosting is rejected and an external marketplace is deferred.
- [x] **Existing unauthenticated blueprint links are unpublished**, with no grandfathering. See [migration effect](#migration-effect-on-existing-blueprint-links).
- [x] **A deployment admin approves.** Self-approval is allowed only with the explicit env setting `PUBLICATION_SELF_APPROVAL` (default off). It is authorization configuration, so it stays out of `AdminConfig`. A self-approved record says so.
- [x] **`workflow`-kind workspaces** fall under the app flag.
- [x] **Bundled blueprints and output formats** are deployment configuration, not publication.
- [x] **Turning a flag off suspends reach**; turning it on again requires each record to be confirmed again.
- [x] **Records live in the owner's User DO**, mirrored by `AdminSettings`.
- [x] **The kernel change in Option A is kept as a fork divergence** from `cloudflare/cloudflare-os`.
- [x] **Both flags default to off.**

## Non-Goals

- A claim that current code accepts the eight names.
- A boolean per provider.
- Flags that act as credentials, grants, activations, deployments or publications.
- Separate user and developer configuration systems.

## Acceptance and delivery

Tracking issue: [#33](https://github.com/factory-level/inferos/issues/33).

- A versioned migration preserves existing customer config and reports the desired flag and schema support accurately.
- Every flag has a named owner, default, dependencies, server/tool/CLI/UI enforcement path, disable and retention semantics, and an evidence fixture.
- Conflicting flags, missing bindings, unsupported adapters and direct or stale-client calls fail clearly without implicit activation or scope expansion.
- Two different customer fixtures preserve settings and custom code through an upgrade.
- Local coding works with HG disabled, with no native ChatGPT-inference requirement and no LLM API key; publication remains optional.
- Scope revocation remains effective after reload, disabled and re-enabled features, and copied view or artifact import.

## Open Questions

- The exact mapping from each legacy flag to the new vocabulary, and which legacy flags are retained because their semantics differ.
- The named owner and default for each flag.
- The drain or cancel policy for each runtime feature when it is disabled.
- Decided by the owner on 2026-10-05: the publication destinations, review and records for the two publication flags. See [publication destinations](#publication-destinations).

## Related

- [Consumer configuration](consumer-configuration.md) (current legacy flags, profiles and styling)
- [Pillars](platform-pillars.md)
- [Local coding workflows](local-coding-workflows.md)
- [Agent deployments](agent-deployments.md)
- [Agent platform integrations](agent-platform-integrations.md)
- [Connection extensions](connection-extensions.md)
- [Customer onboarding](customer-onboarding.md)
