---
title: Approval roles and restricted-data policy
status: draft
updated: 2026-10-04
---

# Approval roles and restricted-data policy

Review artifact for [#65](https://github.com/factory-level/inferos/issues/65). Wave 5 delivers a design and acceptance fixtures only. Company roles, an IAM administration page and deployment-wide provider restrictions are not implemented by this document.

## Authority model proposed for review

Keep four layers separate: company-specific role assignments, workspace Build/Use capabilities, company IAM administration, and source-system membership/denies. Current capabilities continue to be an upper bound; company policy may narrow them, never mint capabilities or override source policy. A console assignment is presentation. An agent, gadget, skill or provider cannot grant itself an approval role or allowlist a model destination.

The authenticated approver and current server-verified role assignments determine which action classes they may approve. An action's class must come from reviewed operation registration, not a caller-provided label. Unclassified operations on a policy-controlled workspace are denied until classified. The precise role issuer, role schema and IAM-administrator mapping need owner review; do not substitute the deployment ADMINS email list or Build role without that decision.

## Policy ownership and enforcement

Propose deployment-owned, versioned configuration administered outside agent/gadget write access. Select its trusted storage/update path during review; do not casually add authorization to soft `AdminConfig`, whose current boundary deliberately separates auth configuration. There is no new approval database: use the existing action journal and current gatekeeper/provider checks.

| Boundary | Proposed check |
| --- | --- |
| Proposal | Record normalized action, resource, expected revision and policy revision; do not imply permission to apply |
| Manual apply | Resolve the authenticated approver, current role and policy, then check existing capability and source authority before mutation |
| Automatic apply | Consult the same policy; never evade a role requirement through an auto-approval path |
| Policy/role change | Re-evaluate pending actions; a changed policy revision requires fresh review, not silent approval replay |
| Model request | Check effective data restrictions and destination before sending any prompt, tool result or resumed history |
| Revocation | Deny subsequent access/apply; invalidate affected sessions/caches and make blocked pending work visible; already exported data cannot be recalled |

## Restricted data

The current `containsRestrictedData` latch forces manual approval and restricts sharing; it is not proof of provider allowlisting. Propose an administrator-owned workspace restriction in addition to observed restrictions, with effective restrictions only becoming stricter through combination. Do not allow ordinary agents or builders to clear the observed latch. The trusted administrator workflow for clearing a configured restriction, and disposition of existing history, need explicit review.

For an explicitly restricted scope, an absent/empty provider allowlist denies model requests. Match configured provider identity and endpoint, not a model's display name. Switching models, opt-in fallback, background turns, quick helpers, retries and context sourced from another space must pass the same check. Unknown provenance in a restricted turn fails closed. Unrestricted deployments retain existing behavior until they opt into the reviewed policy.

A shared personal session can accumulate context from multiple spaces: changing the visible screen must not remove restrictions attached to its history. Proposed rule is to retain the union of restrictions for that conversation until a separately reviewed history-isolation mechanism exists. Never certify regulatory suitability from an allowlist or from synthetic fixtures.

## Access review surface (later UI)

Show verified principal, effective scopes and denies, recent authorized observations and pending writes. Revocation names a specific binding/connection, reports partial failures and distinguishes independent grants. Viewing the administration page does not grant access to private content. This page is a follow-up implementation, not part of the current design delivery.

## Acceptance scenarios and open decisions

[Machine-readable review fixtures](fixtures/wave-5-review.json) describe wrong-role direct calls, stale policy, revocation, restricted fallback and cross-space history. They are test specifications, not enforcement tests.

Review in #65 must select: role issuer and delegation rules; IAM administrator authority/configuration storage; trusted action-class registration; history restriction lifecycle; actual allowed providers/jurisdictions. Use synthetic data until these decisions and implementation are verified. After review, split policy storage/types, apply enforcement, inference enforcement and UI into small PRs with architecture updates. Tests must exercise direct API calls as well as UI and prove zero external sends when denied.

## Current evidence

`overseer.ts` owns the existing action journal, manual/automatic apply paths and restricted-data latch; `ai-models.ts` constructs model requests, with other inference call sites in `overseer.ts`. These are audit starting points, not a completed inventory of future enforcement sites. [Operate architecture](../architecture/operate-mode.md) describes what runs today. Product boundaries come from the 2026-10-04 Obsidian `InferOS IAM Surface` and `Draft Roles and authority contract` notes.
