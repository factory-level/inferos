---
title: Provider-neutral external-agent contract preparation
status: draft
updated: 2026-10-04
---

# Provider-neutral external-agent contract preparation

Review artifact for [#79](https://github.com/factory-level/inferos/issues/79) and [#80](https://github.com/factory-level/inferos/issues/80), companion to [inferops#2326](https://github.com/factory-level/inferops/issues/2326). **No runtime bridge, SDK or new authentication endpoint is shipped.** Harness HG and all #81 work are completely deferred; this preparation contains no platform-specific adapter or configuration.

## Reuse before adding an interface

| Existing surface | Useful capability | Missing provider-neutral boundary |
| --- | --- | --- |
| InferOps board binding | Scoped reads and approved create/edit/transition with revisions | Verified individual external-agent delegation and discovery |
| Wiki binding | Observed text/section reads and approved section edits | Complete source knowledge authorization/provenance and stable cross-client contract |
| Dispatch binding | Separate dispatch/status/result/cancel capability with explicit feature gate | External principal binding; provider revision/configuration evidence |
| Native action journal | Proposal, approval, execution and result correlation | External session/result projection without a parallel journal |
| Connection package | Versioned manifests, conformance and reviewed upgrades | An approved independent external client and provider contract |

Knowledge remains distinct from Operate chat's deliberate Wiki exclusion. An external contract must not obtain knowledge by bypassing that exclusion through the Operate session. It requires its own explicitly authorized knowledge capability.

## Proposed v1 review vocabulary

This is descriptive draft vocabulary, not `workshop-shared` exports or a transport specification. Freeze exact wire schemas only after provider review; do not mirror an existing RPC API by hand.

- **Session:** opaque server-issued session identifier, negotiated contract version, verified principal and installation binding, expiry, delegation/policy revision. Client-supplied actor names or URIs are not authority. Discovery may return a redacted projection, never credentials.
- **Discovery:** operations available under current grants, with resource scope and supported optional runtime controls. A scope/version change invalidates cached discovery. Missing dispatch authority means dispatch is absent and direct calls are still refused.
- **Read:** an authorized resource and operation under that session; return typed data plus observed source revision and observation correlation. Use existing observation semantics.
- **Propose:** normalized operation/arguments, expected source revision and retry identity within original scope; return the existing pending-action identity and review status. The client cannot attest that approval occurred.
- **Result:** query the existing action/run record under current authority. Distinguish pending, rejected, applied, failed and outcome-unknown; a network timeout is not proof that a mutation did not happen.
- **Errors:** distinguish unsupported contract/control, authentication/expiry, forbidden scope, stale revision/policy, retry conflict and unavailable provider. Use the established error taxonomy where possible; disclosure must not reveal out-of-scope existence.

Thin client responsibility is version negotiation, typed serialization and error/result decoding. Authentication verification, grant resolution, approval and transactions stay server-side. Adapters may select a supported transport; no mandatory transport, generic SQL, broad backend token, second task store or runtime management is introduced.

## Required authorization and retry behavior

Authenticate the agent and bind tenant/workspace/resources, installation identity, action ceiling, expiry/revocation and policy revision on the server. Derive types from reviewed schemas. The source still validates current grants, workflow guards and expected object revision in its transaction. Retry identity is bound to normalized arguments and scope; reuse with changed input is a conflict. Repeating a successful operation returns its prior logical result without promising exactly-once external side effects.

Discovery and cached results must include effective scope/revision in their cache identity and be invalidated on revocation/reconnect. Authentication alone does not authorize observation or knowledge sharing. Sensitive context export needs an explicit destination policy from the separately reviewed [policy design](operate-policy.md); an external host has no native sandbox containment. Unknown export permission is refusal.

Optional runtime controls are a separate contract capability. Unsupported start/resume/cancel/deploy must return an explicit unsupported result before any dispatch; do not advertise controls because an adapter has a similarly named method.

## Fixture and provider review

[Review fixtures](fixtures/wave-5-review.json) cover two principals with different discovery, forged actor/URI substitution, expired delegation, revocation, stale approval, duplicate versus changed-input retry, forbidden dispatch, scoped knowledge and unsupported runtime control. They are expected scenarios with synthetic identifiers, not executable security claims.

Provider decisions required in inferops#2326: verified delegation issuer and installation binding; exact versioned schemas/error taxonomy; transactional revision/policy checks; idempotency storage/result recovery; scope-aware knowledge/discovery and revocation. No provider changes are part of this wave. Record the proposed contract there and await owner review before implementing a bridge. #79/#80 remain open for the reviewed contract, real client and authorization tests.

## Review and delivery after decisions

1. Agree provider fixtures and the smallest read/propose/result contract; choose the trusted authentication topology and expiry/revocation behavior.
2. Add a small shared client derived from the actual schemas, keeping optional runtime control separate.
3. Implement server-issued principal/grant binding through native gatekeeper policy; prove authorization directly, not only through discovery.
4. Choose an independent conformance client in a separately resumed issue. #81 and Harness HG remain parked; no runtime-control preparation is included now.

See [platform integration design](agent-platform-integrations.md), [distinct capabilities](../adr/0003-distinct-agent-capabilities.md) and [gatekeeper architecture](../architecture/inferops-gatekeeper.md).
