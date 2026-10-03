---
title: InferOps gatekeeper
status: draft
updated: 2026-10-03
---

# InferOps gatekeeper

Tracking epic: [#6](https://github.com/factory-level/inferos/issues/6); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Expose scoped InferOps project/board/issue reads and approved issue creates, updates and transitions as native capabilities, and, as separate grants, approved coding dispatch of a project's issues to the local coding runner ([local coding workflows](local-coding-workflows.md#dispatch-grant)) and one workspace's InferMind Wiki: page reads and approved section edits ([InferMind Wiki](#infermind-wiki), [#87](https://github.com/factory-level/inferos/issues/87)).

## Requirements

- Define and review the agent-facing capability API before implementation, following write-gatekeeper.
- Bind tenant, workspace and project scope to the issued capability; never accept broader authority from a URI or widget parameter.
- Record reads as observations and every write (create, update, transition) as a proposed action with simulation/approval before dispatch.
- Recheck authorization, project scope and expected revision when executing; stale approval must not silently apply to changed data.
- Bind each approval to the normalized request it will send; an idempotency key is only ever sent with that one request, and a retried or replayed execution never writes twice.
- Keep InferOps domain storage authoritative and preserve its permission/business rules; no direct database bypass.
- Optionally sign Workshop users in with their InferLab account, as an opt-in deployment setting that is off by default and leaves password login available.

## Behavior

The user connects an InferOps account, selects a project and receives a scoped session. The session reads a board or issue through validated InferOps APIs. A transition proposal names the issue, target state and expected revision; an update proposal names the issue, the changed title, description or priority and the expected revision; a create proposal names the new issue's fields and the state it lands in. Preview reports the intended change without writing. Approval executes using the original scope, a deduplication key and current domain checks. Conflicts return structured reload/review instructions. Revocation and reconnect clear affected caches. Shared Gadgets cannot gain the owner’s wider scope by changing a target URI. Installation alone never asserts ambience; provisioning follows admin policy.

### Sign in and connect with InferLab

When a deployment enables it (`INFEROPS_AUTH`, [#66](https://github.com/factory-level/inferos/issues/66)), the login page offers InferLab next to its other sign-in options. InferOS is a public PKCE client of InferLab central-auth (client id `inferos`, redirect URI `<PUBLIC_BASE_URL>/gatekeeper/inferops/oauth`). The gatekeeper exchanges the code server-side. For a sign-in it hands the Workshop only the verified email, which keys the Workshop account like every gatekeeper sign-in, and ends the InferLab session: signing in grants no board, tenant or resource.

The same sign-in connects the InferOps gatekeeper account. A connected account holds that person's InferLab session, refreshes and revokes it, and makes every InferOps request with their own token and one of their own workspaces, so InferOps permissions, row-level rules and revocation apply per person ([ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md)). The deployment holds no credential shared between people. When the integration is off, another supported sign-in mode is required and the gatekeeper serves demo accounts; there is no anonymous bypass. Asking for the integration without the gatekeeper or an InferLab origin fails at startup with a clear message.

## InferOps contract

The external contract the gatekeeper is written against, agreed on 2026-10-02 from the InferOps API as it stands at `factory-level/inferops` `develop` (`fbf9f81`: `domains/project/shared/capabilities.ts`, `board.dto.ts`, `issue.dto.ts`, `errors.ts`). InferOS consumes existing endpoints; it adds none. The InferOps-side changes it still wants are listed under [Companion InferOps changes](#companion-inferops-changes) and tracked in [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326).

### Authority

Each person connects InferOps with their own authority, through InferOps' PKCE sign-in ([ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md); built by [#66](https://github.com/factory-level/inferos/issues/66)). The gatekeeper never holds a credential shared between people. Every request carries:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <token>`: the connected person's InferOps access token. |
| `X-Workspace-Id` | The InferOps workspace UUID of the binding: the connected person's own workspace that the resource URL's workspace slug resolved to. |
| `X-Idempotency-Key` | On every write (create, update, transition); see [Idempotency](#idempotency). |

InferOps also accepts a service-account key (`iex_…`, as the bearer or as `X-API-Key`). The gatekeeper does not use one for a connected person. InferOps permission and row-level rules apply to every call as they do for any other client: `project:read` for the project list, the board and the repository list, `issue:read` for an issue, `issue:write` for a create, an update or a transition, `run:read` for runs, and `issue:delegate` for a dispatch or a run cancel. InferOps' configured workflow policy can also refuse a write (`403 FORBIDDEN` with `details.decision`); InferOS reports it as `FORBIDDEN` and never retries it.

### Resource grammar

`inferops://<tenant>.<workspace>/project/board/<KEY>`

`inferops://<tenant>.<workspace>/project/dispatch/<KEY>`

`inferops://<tenant>.<workspace>/knowledge/wiki`

Two project-scoped kinds share the authority and key rules below. `board` grants the board session; `dispatch` grants the coding-dispatch session of the same project ([#70](https://github.com/factory-level/inferos/issues/70)). They are separate grants: neither carries the other, so an agent granted only a board cannot dispatch. `dispatch` is offered and bound only while the deployment has `CODING_WORKBENCH_ENABLED` on.

The third kind, `knowledge/wiki`, grants one person's read of the workspace's InferMind Wiki and proposed section edits ([InferMind Wiki](#infermind-wiki)). It has no key: the binding is the whole Wiki of one workspace, and the authority rules below apply to it unchanged, except that `<workspace>` resolves only among the person's InferMind workspaces (an InferLab workspace belongs to one product, InferOps or InferMind, and only InferMind workspaces have a Wiki). A page of it is referenced as `inferops://<tenant>.<workspace>/knowledge/document/<slug>`. A page reference identifies a page and is never bound or granted: the page is readable only through a Wiki binding of the same workspace, with the person's own InferOps `knowledge:*` permissions. This grammar was proposed to InferOps on [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326) (owner decision, 2026-10-02).

This is InferOps' own deep-link grammar (`_libs/widgets/shared/inferops-uri.ts` on InferOps `develop`), so a board URL from an InferOps document and one bound in InferOS are the same string. For example, against the local InferOps seeds (tenant `acme`, workspaces `operations` and `knowledge`), `inferops://acme.operations/project/board/ENG` names the ENG board of the Operations workspace ([ADR 0005](../adr/0005-inferops-uri-authority.md)).

- The authority is exactly two labels, `<tenant>.<workspace>`, each an InferOps slug: lowercase letters and digits with interior hyphens, at most 63 characters. Anything else (one or three labels, uppercase, a port, user info) is not a board URL.
- `<workspace>` is resolved against the signed-in person's own InferOps workspaces, by slug, as InferOps' widgets resolve it against the reader's workspace list. The resolved workspace id is fixed into the binding and its requests use the person's own credentials for it. A slug the person does not hold is refused with the same message as a project that does not exist, so a URL cannot probe for workspaces or projects elsewhere.
- `<tenant>` is checked for syntax and kept in the URL, but authorizes nothing. The identity InferLab reports names the tenant by id, not slug, so there is nothing to compare the label with; InferOps' widgets do not check it either. When the account's identity carries the tenant slug, the label must match it.
- The URL never names a deployment. The API base URL comes from the deployment's configuration and the credentials from the connected account; nothing in the URL is used as an address.
- `demo.local` names the built-in demo data and nothing else. It is never resolved against InferOps.
- `<KEY>` is the project's short identifier within the resolved workspace. InferOS resolves it to the project UUID through the project list on each use; the UUID is never taken from the caller.
- Discovery is the connected person's workspaces and each workspace's project list, shown in the resource picker. There is no runtime catalog in a session.

A URI names a target and grants nothing. Changing the tenant, workspace or key of a URI yields either a binding the person's own account is allowed to open or a refusal.

### Endpoints

All paths are relative to the deployment's API base URL.

| Use | Request | Response used |
| --- | --- | --- |
| Workspace slugs, at connect | `GET /workspaces` (no `X-Workspace-Id`) | `[]`: `id`, `slug`, for the memberships InferLab reported only. |
| Discovery, key to UUID | `GET /project/projects` | `projects[]`: `id`, `identifier`, `name`. |
| Board | `GET /project/board?projectId=<uuid>` | `projectId`, `columns[]` of `state` and `issues[]`. |
| Issue | `GET /project/issues/<issueId>` | `issue`, including its `projectId`. |
| Transition | `POST /project/issues/<issueId>/transition`, body `{ "toStateId", "expectedRevision" }` | `issue`: the moved card. |
| Create | `POST /project/issues`, body `{ "projectId", "title", "description"?, "priority"?, "stateId", "workflow"? }` | `issue`: the new card. |
| Update | `PATCH /project/issues/<issueId>`, body `{ "title"?, "description"?, "priority"?, "expectedRevision" }` | `issue`: the updated card; `deliveries` is dropped. |
| Repositories (dispatch) | `GET /project/repos` | `repos[]`: `id`, `slug`, `defaultBaseRef`, `enabled`; `gitUrl` is dropped. |
| Runs (dispatch) | `GET /project/runs?limit=200[&issueId=<uuid>]` | `runs[]`, newest first; kept only when the run's issue is in the bound project. |
| One run (dispatch) | `GET /project/runs/<runId>` | `run`, kept only when its issue is in the bound project. |
| Dispatch | `POST /project/issues/<issueId>/dispatch`, body `{ "action": "code", "repoId", "baseRef"?, "expectedRevision" }` | `run`: the queued run. |
| Cancel (dispatch) | `POST /project/runs/<runId>/cancel` | `run`: the cancelled (queued) or unknown (running) run. |
| Wiki pages | `GET /knowledge/documents` | Bare array: `id`, `slug`, `title`, `parentId`, `siblingOrder`; `summary`, `pathway` and the rest are dropped. |
| Wiki page | `GET /knowledge/documents/<id>` | `id`, `slug`, `title`; the read-only page `body` is dropped. `null` (or an empty body) for a page the workspace lacks. |
| Wiki sections | `GET /knowledge/sections?documentId=<id>` | Bare array of `id`, `documentId`, `tag`, `body`, `version` (an integer), in page order. |
| Wiki section | `GET /knowledge/sections/<id>` | The section, or `null` for one the workspace lacks. |
| Section edit | `PATCH /knowledge/sections/<id>`, body `{ "body" }` | The section at its new `version`. |

Writes send only the fields of the agent-facing declaration. A create always names the bound project's UUID (resolved from its key) and the state it lands in, resolved by InferOS from the board when the proposal is made: the caller's `stateId`, which must be one of the board's states, or else the first state of the `software` workflow (of the `content` workflow on a board that has no `software` states). `workflow` is sent only when that state's workflow is `content`; otherwise InferOps' default (`software`) applies. So the issue lands in the column the approver saw. `parentId`, `acceptanceCriteria`, `assigneeId`, dates, refs, `blockedReason` and `leaseGeneration` are not exposed. An update with no changed field is not proposed; a `null` description clears it.

Every response is validated before any of it is used; a response that does not match is a provider failure, not partial data. The board response also carries every project of the workspace (`projects[]`) and each card's lease and run; the issue response also carries the description, acceptance criteria, refs and comments. InferOS drops all of these, so a session returns only the bound project and the `Issue` fields of the [declaration](inferops-gatekeeper-api.d.ts).

There is no pagination in v1: the board endpoint returns the whole board and InferOS does not invent a cursor over it.

A run keeps `id`, `issueId`, `repoId`, `status`, `baseRef`, `externalRunId`, `result`, `error` and its timestamps; `requestedBy`, `action` and `leaseGeneration` are dropped. A result keeps its required `summary` and, when well formed, `testSummary`, `patch` (`path`, `sha256`, `files`, `insertions`, `deletions`), `tests` (`directory`, `passed`, `failed`, and per command `index`, `argv`, `exitCode`, `timedOut`, `durationMs`, `truncated` and the `stdout`, `stderr` and `record` artifact paths), `reasonCode` (`AUTH_BLOCKED`, `QUOTA_BLOCKED` or `TESTS_FAILED`), `branch`, `commitSha` and `prUrl`; `patch`, `testSummary`, `tests` and `reasonCode` are new in InferOps ([factory-level/inferops#2327](https://github.com/factory-level/inferops/issues/2327)) and a shape that does not match (any malformed test command, or an unknown reason) is left out whole rather than failing the read.

### Project scope is checked by InferOS

InferOps' issue read, transition and update authorize against the workspace, not a project, so the binding's project scope is enforced by InferOS:

- Before an issue is read, moved or updated, at proposal and again at execution, InferOS reads it and compares its `projectId` with the UUID of the bound project.
- A create names only the bound project's UUID, resolved from its key at execution; its state must belong to that project, which InferOps checks.
- An issue of another project is answered exactly as an unknown issue: `NOT_FOUND: No such issue in this project.`
- The board is requested for the bound project's UUID only, and the response's `projectId` must match it.
- A run carries an issue, not a project. A run is read, listed or cancelled only when its issue is in the bound project (checked the same way), and one of another project is answered exactly as an unknown run: `NOT_FOUND: No such run in this project.` A dispatch makes the issue's scope check first, and names the issue by its key, resolved from the bound project's board.
- Repositories are workspace-wide in InferOps. A dispatch names only a repository on the deployment's coding allowlist (the wrapper's `codingWorkbench.repos`, passed to the gatekeeper as ids), checked before any request at proposal and again at apply.

### Revision

An issue's `revision` is InferOps' `head_seq`: a position in a ledger shared by all issues, serialized as a decimal string. It is not a per-issue counter and a transition does not advance it by one. InferOS treats it as opaque: it compares revisions for equality only, never increments or orders them, and sends the revision the caller read as `expectedRevision` on every transition and every update. InferOps makes it optional on both (an omitted `expectedRevision` is last-write-wins); the agent-facing API requires it and the gatekeeper never omits it.

Because the revision a change will produce cannot be known in advance, a pending move or update is simulated by showing the issue with its new state or fields at its unchanged revision, marked `pending`, and a second move or update of an issue whose earlier change is still undecided is refused with `CONFLICT`. A pending create is shown as a provisional card in its target column, marked `pending: "create"`, with a provisional id that `openIssue` does not accept and revision `"0"`.

### Idempotency

The idempotency key of an approved write (create, update or transition) is `<instanceId>:<actionId>`, and of its revert `<instanceId>:<actionId>:revert`. `instanceId` is a random id generated once per binding and `actionId` is the binding's action number, so a key is never shared between bindings, actions, or an action and its revert. A retried apply sends the same key and the same body.

InferOps replays a known key per operation (its claim correlation id is namespaced by operation) by returning the original result without writing or firing hooks again. A create whose response was lost is therefore retried with the same key and returns the issue it created; no second issue is made. InferOps does not compare the body of a replayed request, so a key reused for a different issue, target or field values would silently return the first result; see [Companion InferOps changes](#companion-inferops-changes). InferOS never reuses a key, and does not rely on InferOps to catch that: each proposed action is stored with the exact request it will send and a SHA-256 fingerprint of that request and the bound project, and execution recomputes the fingerprint and refuses to send a request that does not match.

### Reverting

- A transition is reverted by moving the issue back, only while it is still in the state the move left it in.
- An update of the title or priority is reverted by sending the previous values with the then-current revision, only while the issue is still at the revision the update produced and still shows the values it set.
- An update that changed the description is not revertible: InferOS never reads an issue's description, so it cannot restore one.
- A create is not revertible: InferOps has no issue delete in this contract. The approver cancels or deletes it in InferOps.

### Errors

InferOps reports errors as `{ "error": { "code", "message", "details"? } }`. InferOS branches on the status and code, never on the message, and does not pass InferOps' message text on.

| InferOps response | Gatekeeper code | Meaning for the caller |
| --- | --- | --- |
| 404 `NOT_FOUND` on a read | `NOT_FOUND` | No such issue (or project) in this binding. |
| 404 `NOT_FOUND` on a transition | `NOT_FOUND` | The issue is gone, or the target state is not in its project; InferOps does not say which. |
| 404 `NOT_FOUND` on a create | `NOT_FOUND` | The project or the target state is gone. |
| 409 `STALE_REVISION` | `STALE_REVISION` | The issue changed; read it again. |
| 409 `WORKFLOW_MISMATCH` | `WORKFLOW_MISMATCH` | The target state belongs to the other workflow. |
| 409 `RUN_ACTIVE` | `RUN_ACTIVE` | The issue already has a queued or running coding run. |
| 409 `LEASE_HELD`, `LEASE_LOST`, `LEASE_QUARANTINED`, `CONFLICT` | `CONFLICT` | InferOps refused the change in the issue's current condition (for a cancel: the run has already stopped). |
| 400 `VALIDATION_ERROR` (and other 400s) | `INVALID_REQUEST` | The request was malformed. |
| 401 | `UNAUTHORIZED` | The credential was rejected or revoked; reconnect. |
| 403 `FORBIDDEN` (and other 403s) | `FORBIDDEN` | The connected person may not do this in InferOps (for a dispatch or cancel: they lack `issue:delegate`), or (with `details.decision`) the project's workflow policy refused the change. |
| 5xx, any other status, a network failure, or a response that fails validation | `UNAVAILABLE` | Provider failure; nothing is assumed about the outcome. |

`INVALID_STATE` (the target state is not part of the bound project) is decided by InferOS from the board when a move is proposed. InferOps has no distinct code for it.

### Denied cross-scope requests

With a binding for `inferops://acme.operations/project/board/DEMO`:

| Request | Result |
| --- | --- |
| `openIssue(<UUID of an issue in project ENG>)` | `NOT_FOUND: No such issue in this project.`, identical to an unknown UUID. InferOps would have returned the issue; InferOS refuses on its `projectId`. |
| `openIssue(<issue>).transition(<UUID of a state of ENG>, revision)` | `INVALID_STATE`; nothing is proposed. |
| A gadget's binding URL edited to `…/project/board/ENG` | A different resource: it is granted only if the person's own account can open ENG, through the normal connection flow. The existing binding's scope does not change. |
| A URL naming another workspace, `inferops://acme.knowledge/project/board/DEMO` | Granted only if `knowledge` is one of the person's own workspaces; otherwise refused like a missing project, before any request. |
| A URL naming another tenant, `inferops://globex.operations/project/board/DEMO` | The tenant label grants nothing: `operations` still resolves only among the person's own workspaces. |
| A URL naming a deployment, `inferops://ops.example:8443/project/board/DEMO` | Not a board URL. No request is ever sent to an address taken from the URI. |
| A collaborator opening a shared gadget without access to DEMO | Refused: their own InferOps account must be able to open the project. |
| A person whose InferOps permission was removed, or whose token was revoked | `FORBIDDEN` or `UNAUTHORIZED` from InferOps; a pending move is not applied. |
| A second workspace's project with the same key | Reachable only through a URL naming that workspace, and only if the person belongs to it. |

### Coding dispatch

The dispatch session (`InferOpsDispatchSession` in the [declaration](inferops-gatekeeper-api.d.ts)) has three observations and two actions:

- `listRepos()` lists the workspace's repositories, each marked `allowed` when it is on the deployment's allowlist.
- `listRuns()` and `getRun(runId)` read the bound project's runs. A dispatch waiting for approval is shown as a provisional run (`pending: "dispatch"`, id `pending-<n>`), and a run with a cancel waiting as `pending: "cancel"`.
- `dispatch(issueKey, {repoId, baseRef?}, expectedRevision)` proposes handing a software issue to the runner. Before proposing, InferOS checks the switch, the arguments (`baseRef` by InferOps' git ref rule) and the allowlist without a request, then the issue's workflow, state and revision, the repository, and any active or pending run, so a dispatch InferOps would refuse is not proposed. The approval shows the issue, its title, the repository, the base ref and the expected revision. Its action kind is `inferops.code-dispatch`; it is never auto-approvable and not revertible (a run is stopped by a cancel).
- `cancel(runId)` proposes stopping a queued or running run of the project. Its action kind is `inferops.run-cancel`. A cancel whose approval finds the run already stopped counts as applied.

Applying either rechecks the switch, the allowlist (dispatch) and the fingerprint before sending, under the action's idempotency key. InferOps replays a known dispatch key for the same issue and refuses one reused for another issue, and its own guards (workflow, state, lease, active run, repository, revision, `issue:delegate`) apply at apply time.

### InferMind Wiki

The Wiki session (`InferOpsWikiSession` in the [declaration](inferops-gatekeeper-api.d.ts)) has three observations and one action:

- `listDocuments()` lists the workspace's pages with their place in the page tree (`parentId`, `siblingOrder`), in InferOps' order.
- `readDocument(slugOrId)` reads one page and its sections, each with its `version` and its `[[target#tag]]` wikilinks (InferOps' v1 grammar, parsed from the body), plus the page's embedded references: the `inferops://` links that stand alone as a paragraph, the rule InferOps' own text resolver uses.
- `readDocumentText(slugOrId)` is the agent text of the same sections, in the format of InferOps' `renderDocumentAsText`: `# <title>`, then each section's body, separated by blank lines. InferOps replaces each embedded reference with the live state of what it names; InferOS leaves the reference as written and never reads another resource through a Wiki binding. A page with no readable section is `NOT_FOUND`, as InferOps answers it.
- `updateSection(sectionId, body, expectedVersion)` proposes replacing one section's markdown. Its action kind is `inferops.wiki-section-update`; it is never auto-approvable. Until it is decided, reads show the new body at the unchanged version, marked `pending: "update"`, and a second edit of the section is refused with `CONFLICT`. It is revertible while the section still shows the edit at the version it produced.

Access is InferOps': the product gate (`requiresProduct: 'infermind'`), `knowledge:read` for reads and `knowledge:write` for an edit, row-level security on the workspace, and the InferMind lens on sections, all applied to the person's own token. InferOps answers both a missing product and a missing permission with 403 `FORBIDDEN` and says which only in its message text, which InferOS does not read, so the caller gets one `FORBIDDEN` message naming both causes. A Wiki URL naming one of the person's InferOps workspaces is refused before any request, saying that workspace has no Wiki.

InferOps' section `PATCH` takes no expected version and does not replay an idempotency key. InferOS therefore checks the version itself: applying an edit reads the section first and sends the body only while the section is still at the version the edit was proposed at. A section already showing exactly the approved body at a later version counts as applied without a second write (a retried apply whose first response was lost); any other change refuses the edit as stale. The fingerprint and the idempotency key are as for every other action, and the key is sent although InferOps ignores it today. The page's own `body` is read-only in InferOps and is not part of this contract; root, pillar and Master pages and coverage states are InferOps' to build ([factory-level/inferops#2324](https://github.com/factory-level/inferops/issues/2324), [#2325](https://github.com/factory-level/inferops/issues/2325)).

### Companion InferOps changes

Wanted from InferOps, tracked in [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326). None blocks the first live path; each removes a check InferOS otherwise has to make alone.

1. **Reject a replayed idempotency key that names a different request.** A replay should fail (a distinct conflict code) when the key was first used for another issue, target state or field values, on transition, create and update alike, instead of returning the first result.
2. **A distinct error code for a target state outside the issue's project.** Today it is `NOT_FOUND`, the same as a missing issue.
3. **An optional project constraint on issue read and transition.** A caller-supplied project id that InferOps enforces, answering an issue of another project as `NOT_FOUND`, so the scope check is made in the same transaction as the write.
4. **An expected version and idempotency on section edits.** `PATCH /knowledge/sections/<id>` accepting `expectedVersion` (refused with a conflict code when it no longer matches) and replaying `X-Idempotency-Key`, so the version check is made in the same transaction as the write.
5. **Distinct codes for the knowledge refusals.** A product gate refusal distinguishable from a missing permission, and a 404 instead of a 500 for a section `PATCH` naming a section the workspace lacks.

## Non-Goals

No arbitrary SQL, generic entity schema builder, all-domain write access or replication of the InferOps database.

## Acceptance and delivery

### Define InferOps account auth and scoped project capability API

Tracking issue: [#21](https://github.com/factory-level/inferos/issues/21) (`gatekeeper-contract`).

- Review proposed agent-facing methods and TypeScript contract using write-gatekeeper before coding.
- Specify tenant/workspace/project resource grammar, discovery, auth/reconnect and permission mapping.
- Agree external API validation, pagination/revision/error behavior and idempotency needs with InferOps.
- Produce examples of denied cross-scope requests and identify required companion upstream changes.

### Implement observed board reads and approved issue transitions

Tracking issue: [#22](https://github.com/factory-level/inferos/issues/22) (`gatekeeper-actions`). Its MVP scope (2026-10-02) expands this to governed issue create, read, update and transition within one project: every write keeps approval and rechecks scope and current grants, updates and transitions require a delegated `expectedRevision`, approval binds the normalized fields and scope, an idempotency key is never sent with a different payload, and a create whose response was lost is reconciled through its key rather than duplicated.

- Implement the gatekeeper using kit handoff/reconnect and existing approval mechanisms.
- Validate responses; record all reads; simulate transitions without side effects.
- Execute approved transitions with fixed scope, expected revision, deduplication and domain checks.
- Test denied approval, stale board, duplicate execution, revoked connection and provider failure.

### Verify sharing, deployment and tenant isolation for InferOps capabilities

Tracking issue: [#23](https://github.com/factory-level/inferos/issues/23) (`gatekeeper-isolation`).

- Test cross-tenant/workspace/project URI tampering, shared gadget bindings and reconnect scope changes.
- Invalidate cached data on account/scope change and prevent credential or content leakage in diagnostics.
- Wire canonical configs, router/backend bindings and correct install inputs.
- Prove the complete local connect/read/propose/approve/refresh flow and a scoped cloud smoke recipe.

## Open Questions

### Proposed API for operator review

The concrete [agent-facing declaration](inferops-gatekeeper-api.d.ts) proposes two capabilities:

- `InferOpsProjectSession.readBoard()` returns only the connected project's metadata and board. `openIssue(issueId)` narrows to an issue in that project.
- `InferOpsIssueSession.read()` reads that fixed issue. `transition(toStateId, expectedRevision)` changes its state with mandatory revision checking and same-project/workflow validation. `update({title?, description?, priority?}, expectedRevision)` changes those fields with mandatory revision checking.
- `InferOpsProjectSession.createIssue({title, description?, priority?, stateId?})` proposes a new issue in the bound project.
- `Issue.pending` marks a card whose shown values include a change that has not taken effect yet, including the provisional card of an issue being created.

The first installation exposes project-bound resources. Direct issue-only grants can use the same issue session contract after resource-picker support is added; a workspace-wide catalog is deliberately absent from the runtime session. A resource URI identifies a target and never supplies permission.

The declaration contains only caller-facing types and behavior; approval queue, caching, authentication and simulation implementation details remain here in the design. Internally every returned read is an authorized observation, transitions are submitted to the native action queue, pending changes are simulated, and execution rechecks current scope and revision. The action's stable ID maps to InferOps claim idempotency ([Idempotency](#idempotency)). A replay must never dispatch state-change hooks twice.

The scoped board projection omits other workspace projects and initial lease/run details. It does not invent a cursor API over the existing full-board endpoint. Cross-project resources, unknown issue UUIDs and revoked credentials fail closed. Sharing uses project access verification for each observer; it must not use the low-stakes no-op observer strategy.

**Review status (2026-10-02):** the operator approved this API; the create/update methods and `Issue.pending` were added under [#22](https://github.com/factory-level/inferos/issues/22)'s MVP scope, and `custom-gatekeepers/gatekeeper-inferops` ships the declaration over demo data. The external contract is stated under [InferOps contract](#inferops-contract); the current implementation and its gaps are in the [current architecture](../architecture/inferops-gatekeeper.md#divergences-from-design).

Resolved on 2026-10-02:

- Service versus user authority: each person connects with their own authority ([ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md), proposed).
- Idempotency: the existing transition endpoint's claim replay is sufficient for retries of an approved action. Detecting a key reused for a different move is a wanted companion change, not a prerequisite.
- Wiki resource grammar: `inferops://<tenant>.<workspace>/knowledge/wiki` binds one workspace's Wiki and `…/knowledge/document/<slug>` references a page (owner decision, 2026-10-02, [#87](https://github.com/factory-level/inferos/issues/87); proposed on [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326)).
- Resource grammar and workspace: board URLs use InferOps' own `inferops://<tenant>.<workspace>/…` grammar, the workspace slug resolved against the person's own workspaces and the deployment taken from configuration ([ADR 0005](../adr/0005-inferops-uri-authority.md), proposed; owner decision, [#24](https://github.com/factory-level/inferos/issues/24), [#25](https://github.com/factory-level/inferos/issues/25)).

Still open:

- The contract was derived by InferOS from the InferOps source and posted to [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326). InferOps has not yet confirmed it, or accepted the companion changes.
- Token lifetime, refresh and the reconnect flow for a PKCE-connected account are defined by [#66](https://github.com/factory-level/inferos/issues/66), not here.
- Whether the tenant label should be verified. InferLab's identity carries the tenant id only; InferLab's public `GET /auth/tenant?slug=` could map a label to an id for comparison, at the cost of a request per binding. Until then it is checked for syntax only, as in InferOps.
- Workspace slugs are read once per connect or reconnect; a workspace joined or renamed later is reachable by URL only after the person reconnects. Whether to refresh them with the access token is undecided.
- One account per deployment: the deployment is configuration, not part of the URI, so an InferOS deployment talks to one InferOps API.
- InferOps accepts mixed-case project identifiers of up to 10 characters (`[A-Za-z][A-Za-z0-9]{0,9}`); the resource grammar accepts uppercase keys only (up to 16). Whether to widen the grammar or to leave such projects unbindable is undecided; adopting the URI authority left the key grammar unchanged.
- The scope check and the transition or update are two requests, so an issue moved to another project between them would still be changed. Companion change 3 closes this; whether InferOps allows an issue to change project at all has not been confirmed.
- The issue read fetches the description and comment thread only to discard them. A narrower InferOps read would avoid that.
- InferOps enforces configured workflow policy on content issues only; a software issue's create or update is governed by InferOS's approval alone until InferOps' software policy ships. Live acceptance of a policy refusal therefore needs a content issue.
- No issue delete is in the contract, so an approved create cannot be undone from InferOS.
- Whether InferOps registers `knowledge/document` as a widget kind, and whether a page reference names the slug or the page UUID. Slugs look stable (a page's `PATCH` changes only its title), but InferOps has not confirmed it.
- A section edit's version check and its write are two requests, so an edit made in InferMind between them is overwritten. Companion change 4 closes this.

## Related

- [Current architecture](../architecture/inferops-gatekeeper.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)
