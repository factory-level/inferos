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

The declaration contains only caller-facing types and behavior; approval queue, caching, authentication and simulation implementation details remain here in the design. Internally every returned read is an authorized observation, transitions are submitted to the native action queue, pending changes are simulated, and execution rechecks current scope and revision. The action's stable ID maps to InferOps claim idempotency; the inspected domain already supports claim replay, but the external HTTP/auth contract exposing it still needs agreement. A replay must never dispatch state-change hooks twice.

The scoped board projection omits other workspace projects and initial lease/run details. It does not invent a cursor API over the existing full-board endpoint. Cross-project resources, unknown issue UUIDs and revoked credentials fail closed. Sharing uses project access verification for each observer; it must not use the low-stakes no-op observer strategy.

**Review status: proposed, not approved or implemented.** The repository's write-gatekeeper skill requires review of the concrete API before implementing a new gatekeeper. The existing high-level design approval did not specify these methods or projection trade-offs.

**Divergence (2026-10-02):** the operator approved this API for a first implementation over mock data. `custom-gatekeepers/gatekeeper-inferops` ships the declaration verbatim, backed by an auto-provisioned per-user demo data source instead of InferOps authentication and APIs; see [Current architecture](../architecture/inferops-gatekeeper.md#divergences-from-design). The open questions below still gate live data.

- Agree the external InferOps authentication and API contract, including service versus user authority.
- Does the existing transition endpoint provide sufficient idempotency for approved action retries, or is a companion InferOps change required?

## Related

- [Current architecture](../architecture/inferops-gatekeeper.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)
