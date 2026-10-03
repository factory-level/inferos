---
title: Connection packages and reviewed fork updates
status: draft
updated: 2026-10-02
---

# Connection packages and reviewed fork updates

Tracking epic: [#51](https://github.com/factory-level/inferos/issues/51); roadmap: [#1](https://github.com/factory-level/inferos/issues/1); companion provider contract: [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326).

## Purpose

Add new business-system connections through a repeatable native Gatekeeper code pattern, then deliver reviewed upgrades to privately customized customer repositories without overwriting their code, configuration or SOPs, copying runtime credentials, or silently expanding agent authority.

This is a draft target. No implementation, deployment or live connection exists for it yet.

## Requirements

### Package pattern

A connection package contains:

- the native Gatekeeper entrypoints, account and resource sessions;
- a typed provider API client and the agent-facing contract;
- an explicit configuration and compatibility manifest;
- credential references (not credentials);
- fixtures and conformance tests;
- setup and troubleshooting skills;
- operate and recovery SOPs.

Reuse `gatekeeper-kit` and the native observation, approval and session machinery. Standardize a reference implementation and scaffolder before inventing a large base class or a JSON business-rule language.

Generated custom API clients and endpoints are scaffolds, not trusted unrestricted proxies. Each one explicitly classifies read versus write, resource scopes, approval behavior, provider errors, simulation limits and reconciliation. The agent-facing contract is reviewed before implementation. Customer IAM adapters are built as concrete client requirements appear; the shared boundary is stable, and there is no speculative provider catalog.

### Customer extensions

- Distinguish Gatekeeper entries from ordinary trusted custom Workers. Validate actual binding and discovery requirements; a public `/extensions/...` route is not an agent capability.
- Extend canonical configuration and manifest loading and the local and cloud topology with compatibility versions, path containment, collision checks and explicit migrations. Generated Worker config stays derived.
- Manifest loading fails closed on disabled, unlisted or incompatible entries.

### Releases and upgrades

- Shared code is pinned to a reviewed foundation revision initially. Independent package releases are optional later.
- Customer config, policy, components and private Gatekeepers stay customer-owned.
- Every file is classified as shared, customer-owned, generated or copied-template.
- Copied skills, SOPs and blueprints are reconciled using the original, customer and new versions, and conflicts are surfaced. Arbitrary private core patches are never promised to merge automatically.
- Upgrades are planned and opened as reviewed PRs that show code, config and migration changes and capability, OAuth, data and approval changes.
- Existing allowed authority does not expand because an API method was added.
- Plan, apply, verify, upgrade and recover are available through one CLI contract used by humans and skills.

## Behavior

Installation, enabling a feature, account connection, resource grant and agent activation are separate operations. Scaffolding a connector does not mark it production-ready.

Code synchronization never distributes runtime tokens, customer data, live grants, pending approvals or agent memory. Storage identity is preserved when compatible. Incompatible pending actions are explicitly migrated or require reapproval.

A changed connection is registered in the customer's operational inventory, and InferMind Master coverage is reconciled. The existence of a generic SOP file is not customer-reviewed coverage.

The InferOps Gatekeeper is the reference implementation. A second small synthetic or customer connector is scaffolded through the same pattern to prove it.

## Non-Goals

- A large Gatekeeper base class or a JSON business-rule language ahead of a proven reference.
- A speculative provider or IAM adapter catalog.
- Automatic merging of arbitrary private core patches.
- Independent package releases in the first iteration.
- Cloud deployment proof. It is kept separate from local proof, and the initial [local coding workflow](local-coding-workflows.md) does not wait for the connector catalog or a cloud publishing pipeline.

## Acceptance and delivery

- The InferOps Gatekeeper becomes a tested reference; a second small synthetic or customer connector is scaffolded through the same pattern.
- Resource scope, observation and sharing, approval, stale revision, retry, revocation and upgrade failures pass a shared real-contract fixture suite.
- Two differently customized customer fixtures accept the same reviewed update while preserving local configuration, custom code and SOP edits.
- Adding a new write operation does not grant it to existing agents; secrets, grants and state are absent from portable output.
- Manifest loading distinguishes custom Worker routes from Gatekeeper discovery and fails closed on disabled, unlisted or incompatible entries.
- Plan, apply, verify, upgrade and recover are available through one CLI contract used by humans and skills; scaffolding alone does not mark a connector production-ready.

## Open Questions

- The manifest schema and its compatibility versioning.
- How file classification is recorded so that an upgrade can tell shared from copied-template files.
- The three-way reconciliation mechanism for copied skills, SOPs and blueprints.
- How a connection package relates to this fork's `custom-gatekeepers/` root and to a wrapper's `gatekeepers/` and `workers/` directories.

## Related

- [InferOps gatekeeper](inferops-gatekeeper.md)
- [Consumer configuration](consumer-configuration.md) (custom Cloudflare code and the extension manifest)
- [Repository setup skills](repo-setup-skills.md)
- [Feature capabilities](feature-capabilities.md)
- [Agent platform integrations](agent-platform-integrations.md)
- [Customer onboarding](customer-onboarding.md)
- [Pillars](platform-pillars.md)
