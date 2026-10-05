---
title: InferOps gatekeeper acts with each person's own authority
status: proposed
date: 2026-10-02
---

# 0004. InferOps gatekeeper acts with each person's own authority

## Context

The InferOps gatekeeper reads project boards and applies approved issue transitions through the InferOps HTTP API ([design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20IAM.md%23InferOps%20project%20gatekeeper), [#21](https://github.com/factory-level/inferos/issues/21)). That API authenticates a bearer token, either a person's access token or a service-account key, and authorizes it against the workspace named by `X-Workspace-Id`. The design left "service versus user authority" as an open question.

Three facts bear on the choice:

- InferOps is the authority for permissions and row-level rules. The gatekeeper narrows what a Gadget may do; it must not widen what the person behind it may do.
- Sharing a Gadget admits a collaborator only if their own InferOps account can open the bound project. That check has no meaning unless each account carries a distinct identity.
- InferOps already has a PKCE sign-in, and the InferOps identity integration for InferOS is planned as [#66](https://github.com/factory-level/inferos/issues/66), whose acceptance requires the gatekeeper account to be "connected with their own authority, not a shared credential".

## Decision

Each person connects the InferOps gatekeeper through InferOps' PKCE sign-in, and every request the gatekeeper makes for that person carries that person's own token and workspace. The gatekeeper holds no credential shared between people.

The decision was made by the operator on 2026-10-02. This record is `proposed` until a human accepts it.

## Consequences

- InferOps permissions, row-level rules and revocation apply per person with no mapping layer in InferOS. Removing someone's access in InferOps takes effect on their next request.
- Observer verification for shared Gadgets can ask InferOps, with the collaborator's own token, whether they can open the project.
- InferOps attributes each read and transition to the person who connected, not to a shared principal.
- The live path depends on [#66](https://github.com/factory-level/inferos/issues/66). Until it lands, a live connection can exist only as a local-development stopgap, which is not this decision and must not be deployed as if it were.
- The gatekeeper has to store, refresh and revoke a token per account, and handle a rejected token by asking the person to reconnect.
- Background work that runs without a signed-in person is not covered. It needs its own decision.

## Alternatives Considered

- A shared service-account key for the deployment: every person and every shared Gadget would act with the key's permissions, so InferOps could not distinguish them, per-person revocation would not exist, and observer verification would have nothing to check. It also makes one secret the authority for a whole deployment.
- A service-account key pasted by each person: keeps identities distinct, but each person has to mint, paste and rotate a long-lived key by hand, and InferOps would attribute their actions to a service account rather than to them.
- Project-bound agent assumption tokens: InferOps can bind an agent assumption to one workspace and one project, which matches a board binding. But a caller under an assumption acts as an agent rather than as the person, and InferOps reports a transition made under one with its status hooks skipped (`impersonation_test`), so an approved move would land without its normal effects. Whether a binding should additionally narrow a person's token this way is an open question.

## Open Questions

- Access-token lifetime, refresh and the reconnect flow are not specified here; [#66](https://github.com/factory-level/inferos/issues/66) owns them.
- Whether a project-bound assumption should be layered on top of the person's token, so InferOps also enforces the binding's project.
- What authority scheduled or other unattended work uses.
- InferOps has not yet confirmed the contract this decision is part of ([factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326)).

## Related

- Design: [inferops gatekeeper](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20IAM.md%23InferOps%20project%20gatekeeper)
- Design: [feature capabilities](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Feature%20Flags.md%23Capability%20contract%20and%20migration%20review) (`INFEROPS_AUTH`)
