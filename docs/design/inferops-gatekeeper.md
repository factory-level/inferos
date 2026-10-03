---
title: InferOps gatekeeper
status: draft
updated: 2026-10-02
---

# InferOps gatekeeper

Tracking epic: [#6](https://github.com/factory-level/inferos/issues/6); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Expose scoped InferOps project/board/issue reads and approved issue transitions as native capabilities.

## Requirements

- Define and review the agent-facing capability API before implementation, following write-gatekeeper.
- Bind tenant, workspace and project scope to the issued capability; never accept broader authority from a URI or widget parameter.
- Record reads as observations and transitions as proposed actions with simulation/approval before dispatch.
- Recheck authorization and expected revision when executing; stale approval must not silently apply to changed data.
- Keep InferOps domain storage authoritative and preserve its permission/business rules; no direct database bypass.
- Optionally sign Workshop users in with their InferLab account, as an opt-in deployment setting that is off by default and leaves password login available.

## Behavior

The user connects an InferOps account, selects a project and receives a scoped session. The session reads a board or issue through validated InferOps APIs. A transition proposal names the issue, target state and expected revision; preview reports the intended change without writing. Approval executes using the original scope, a deduplication key and current domain checks. Conflicts return structured reload/review instructions. Revocation and reconnect clear affected caches. Shared Gadgets cannot gain the owner’s wider scope by changing a target URI. Installation alone never asserts ambience; provisioning follows admin policy.

### Sign in with InferLab

When a deployment enables it, the login page offers InferLab next to its other sign-in options. InferOS is a public PKCE client of InferLab central-auth (client id `inferos`, redirect URI `<PUBLIC_BASE_URL>/gatekeeper/inferops/oauth`). The gatekeeper exchanges the code server-side and hands the Workshop only the verified email, which keys the Workshop account like every gatekeeper sign-in. Signing in grants no board access. Board authority stays with the account and scope contract below (#21), so the sign-in tokens are not kept.

## InferOps contract

The external contract the gatekeeper is written against, agreed on 2026-10-02 from the InferOps API as it stands at `factory-level/inferops` `develop` (`fbf9f81`: `domains/project/shared/capabilities.ts`, `board.dto.ts`, `issue.dto.ts`, `errors.ts`). InferOS consumes existing endpoints; it adds none. The InferOps-side changes it still wants are listed under [Companion InferOps changes](#companion-inferops-changes) and tracked in [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326).

### Authority

Each person connects InferOps with their own authority, through InferOps' PKCE sign-in ([ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md); built by [#66](https://github.com/factory-level/inferos/issues/66)). The gatekeeper never holds a credential shared between people. Every request carries:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <token>`: the connected person's InferOps access token. |
| `X-Workspace-Id` | The InferOps workspace UUID of the connected account. |
| `X-Idempotency-Key` | On the transition write only; see [Idempotency](#idempotency). |

InferOps also accepts a service-account key (`iex_…`, as the bearer or as `X-API-Key`). The gatekeeper does not use one for a connected person. InferOps permission and row-level rules apply to every call as they do for any other client: `project:read` for the project list and board, `issue:read` for an issue, `issue:write` for a transition.

### Resource grammar

`inferops://<host>/project/board/<KEY>`

- `<host>` identifies an InferOps deployment by the host (and port, when not the default) of its API. It selects which configured connection a binding uses. It is an identifier, not an address: the base URL, the workspace id and the credentials come from the connected account and the deployment's configuration, never from the URI. A host with no configured connection is refused. `demo.local` names the built-in demo data.
- `<KEY>` is the project's short identifier within the connected account's workspace. InferOS resolves it to the project UUID through the project list on each use; the UUID is never taken from the caller.
- The tenant and workspace are properties of the connected account, so they do not appear in the URI and cannot be changed through it.
- Discovery is the connected account's project list, shown in the resource picker. There is no runtime catalog in a session.

A URI names a target and grants nothing. Changing the host or key of a URI yields either a binding the person's own account is allowed to open or a refusal.

### Endpoints

All paths are relative to the deployment's API base URL.

| Use | Request | Response used |
| --- | --- | --- |
| Discovery, key to UUID | `GET /project/projects` | `projects[]`: `id`, `identifier`, `name`. |
| Board | `GET /project/board?projectId=<uuid>` | `projectId`, `columns[]` of `state` and `issues[]`. |
| Issue | `GET /project/issues/<issueId>` | `issue`, including its `projectId`. |
| Transition | `POST /project/issues/<issueId>/transition`, body `{ "toStateId", "expectedRevision" }` | `issue`: the moved card. |

Every response is validated before any of it is used; a response that does not match is a provider failure, not partial data. The board response also carries every project of the workspace (`projects[]`) and each card's lease and run; the issue response also carries the description, acceptance criteria, refs and comments. InferOS drops all of these, so a session returns only the bound project and the `Issue` fields of the [declaration](inferops-gatekeeper-api.d.ts).

There is no pagination in v1: the board endpoint returns the whole board and InferOS does not invent a cursor over it.

### Project scope is checked by InferOS

InferOps' issue read and issue transition authorize against the workspace, not a project, so the binding's project scope is enforced by InferOS:

- Before an issue is read or moved, InferOS reads it and compares its `projectId` with the UUID of the bound project.
- An issue of another project is answered exactly as an unknown issue: `NOT_FOUND: No such issue in this project.`
- The board is requested for the bound project's UUID only, and the response's `projectId` must match it.

### Revision

An issue's `revision` is InferOps' `head_seq`: a position in a ledger shared by all issues, serialized as a decimal string. It is not a per-issue counter and a transition does not advance it by one. InferOS treats it as opaque: it compares revisions for equality only, never increments or orders them, and sends the revision the caller read as `expectedRevision` on every transition (InferOps treats an omitted `expectedRevision` as last-write-wins, which the gatekeeper never uses).

Because the revision a move will produce cannot be known in advance, a pending move is simulated by showing the issue in its target state at its unchanged revision, and a second move of an issue whose earlier move is still undecided is refused with `CONFLICT`.

### Idempotency

The idempotency key of an approved transition is `<instanceId>:<actionId>`, and of its revert `<instanceId>:<actionId>:revert`. `instanceId` is a random id generated once per binding and `actionId` is the binding's action number, so a key is never shared between bindings, actions, or an action and its revert. A retried apply sends the same key.

InferOps replays a known key by returning the issue's current card without applying the move or firing its hooks again. It does not detect a key reused for a different issue or target state; see [Companion InferOps changes](#companion-inferops-changes). InferOS never reuses a key for a different move, and does not rely on InferOps to catch that.

### Errors

InferOps reports errors as `{ "error": { "code", "message", "details"? } }`. InferOS branches on the status and code, never on the message, and does not pass InferOps' message text on.

| InferOps response | Gatekeeper code | Meaning for the caller |
| --- | --- | --- |
| 404 `NOT_FOUND` on a read | `NOT_FOUND` | No such issue (or project) in this binding. |
| 404 `NOT_FOUND` on a transition | `NOT_FOUND` | The issue is gone, or the target state is not in its project; InferOps does not say which. |
| 409 `STALE_REVISION` | `STALE_REVISION` | The issue changed; read it again. |
| 409 `WORKFLOW_MISMATCH` | `WORKFLOW_MISMATCH` | The target state belongs to the other workflow. |
| 409 `LEASE_HELD`, `LEASE_LOST`, `LEASE_QUARANTINED`, `RUN_ACTIVE`, `CONFLICT` | `CONFLICT` | InferOps refused the move in the issue's current condition. |
| 400 `VALIDATION_ERROR` (and other 400s) | `INVALID_REQUEST` | The request was malformed. |
| 401 | `UNAUTHORIZED` | The credential was rejected or revoked; reconnect. |
| 403 `FORBIDDEN` (and other 403s) | `FORBIDDEN` | The connected person may not do this in InferOps. |
| 5xx, any other status, a network failure, or a response that fails validation | `UNAVAILABLE` | Provider failure; nothing is assumed about the outcome. |

`INVALID_STATE` (the target state is not part of the bound project) is decided by InferOS from the board when a move is proposed. InferOps has no distinct code for it.

### Denied cross-scope requests

With a binding for `inferops://ops.example/project/board/DEMO`:

| Request | Result |
| --- | --- |
| `openIssue(<UUID of an issue in project ENG>)` | `NOT_FOUND: No such issue in this project.`, identical to an unknown UUID. InferOps would have returned the issue; InferOS refuses on its `projectId`. |
| `openIssue(<issue>).transition(<UUID of a state of ENG>, revision)` | `INVALID_STATE`; nothing is proposed. |
| A gadget's binding URL edited to `…/project/board/ENG` | A different resource: it is granted only if the person's own account can open ENG, through the normal connection flow. The existing binding's scope does not change. |
| A URL naming another host, `inferops://other.example/project/board/DEMO` | Refused unless the account has a connection for that host. No request is sent to a host taken from the URI. |
| A collaborator opening a shared gadget without access to DEMO | Refused: their own InferOps account must be able to open the project. |
| A person whose InferOps permission was removed, or whose token was revoked | `FORBIDDEN` or `UNAUTHORIZED` from InferOps; a pending move is not applied. |
| A second workspace's project with the same key | Not reachable: the workspace comes from the connected account, not the URI. |

### Companion InferOps changes

Wanted from InferOps, tracked in [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326). None blocks the first live path; each removes a check InferOS otherwise has to make alone.

1. **Reject a replayed idempotency key that names a different move.** A replay should fail (a distinct conflict code) when the key was first used for another issue or another target state, instead of returning the current card.
2. **A distinct error code for a target state outside the issue's project.** Today it is `NOT_FOUND`, the same as a missing issue.
3. **An optional project constraint on issue read and transition.** A caller-supplied project id that InferOps enforces, answering an issue of another project as `NOT_FOUND`, so the scope check is made in the same transaction as the write.

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

Tracking issue: [#22](https://github.com/factory-level/inferos/issues/22) (`gatekeeper-actions`).

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
- `InferOpsIssueSession.read()` reads that fixed issue. `transition(toStateId, expectedRevision)` changes its state with mandatory revision checking and same-project/workflow validation.

The first installation exposes project-bound resources. Direct issue-only grants can use the same issue session contract after resource-picker support is added; a workspace-wide catalog is deliberately absent from the runtime session. A resource URI identifies a target and never supplies permission.

The declaration contains only caller-facing types and behavior; approval queue, caching, authentication and simulation implementation details remain here in the design. Internally every returned read is an authorized observation, transitions are submitted to the native action queue, pending changes are simulated, and execution rechecks current scope and revision. The action's stable ID maps to InferOps claim idempotency ([Idempotency](#idempotency)). A replay must never dispatch state-change hooks twice.

The scoped board projection omits other workspace projects and initial lease/run details. It does not invent a cursor API over the existing full-board endpoint. Cross-project resources, unknown issue UUIDs and revoked credentials fail closed. Sharing uses project access verification for each observer; it must not use the low-stakes no-op observer strategy.

**Review status (2026-10-02):** the operator approved this API, and `custom-gatekeepers/gatekeeper-inferops` ships the declaration over demo data. The external contract is stated under [InferOps contract](#inferops-contract); the current implementation and its gaps are in the [current architecture](../architecture/inferops-gatekeeper.md#divergences-from-design).

Resolved on 2026-10-02:

- Service versus user authority: each person connects with their own authority ([ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md), proposed).
- Idempotency: the existing transition endpoint's claim replay is sufficient for retries of an approved action. Detecting a key reused for a different move is a wanted companion change, not a prerequisite.

Still open:

- The contract was derived by InferOS from the InferOps source and posted to [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326). InferOps has not yet confirmed it, or accepted the companion changes.
- Token lifetime, refresh and the reconnect flow for a PKCE-connected account are defined by [#66](https://github.com/factory-level/inferos/issues/66), not here.
- How a connected account learns its workspace id, and whether one account may hold connections to several workspaces or hosts.
- InferOps accepts mixed-case project identifiers of up to 10 characters (`[A-Za-z][A-Za-z0-9]{0,9}`); the resource grammar accepts uppercase keys only. Whether to widen the grammar or to leave such projects unbindable is undecided.
- The scope check and the transition are two requests, so an issue moved to another project between them would still be transitioned. Companion change 3 closes this; whether InferOps allows an issue to change project at all has not been confirmed.
- The issue read fetches the description and comment thread only to discard them. A narrower InferOps read would avoid that.

## Related

- [Current architecture](../architecture/inferops-gatekeeper.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)
