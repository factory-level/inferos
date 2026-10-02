---
title: Customer OS onboarding
status: draft
updated: 2026-10-02
---

# Customer OS onboarding

Tracking roadmap: [#1](https://github.com/factory-level/inferos/issues/1). Cross-repo baseline: [factory-level/inferops#2323](https://github.com/factory-level/inferops/issues/2323); operational intake: [factory-level/inferops#2324](https://github.com/factory-level/inferops/issues/2324); Master-page coverage: [factory-level/inferops#2325](https://github.com/factory-level/inferops/issues/2325).

## Purpose

Deliver privately customized customer operating environments through a repeatable process driven by one CLI and its skills. Operations are modeled in InferOps first, documented in InferMind with pillar Master-page coverage, and only then is the customer's InferOS configured and customized.

This document covers the InferOS share of that process. The InferOps and InferMind steps are specified in the InferOps repository. It is a draft target, not a claim that these capabilities have shipped.

## Requirements

- One CLI, configuration and feature contract is used by humans, coding agents and CI. There is no split user and developer implementation.
- The process reuses the merged consumer foundation (PR #37, merged 2026-10-02, commit `f90ca223b99239095f159e44f99ed109150d59c1`) described in [consumer configuration](consumer-configuration.md).
- The private downstream repository may contain real custom components, connectors, IAM adapters and application code. Configuration is the starting point, not a limit on customization.
- A customer requirement that supported configuration cannot meet becomes a scoped implementation issue.
- A private consumer starts from supported configuration, preserves its customizations, and clearly reports unsupported features.
- Deployment is explicit. No generated config, issue edit, model summary or merged PR substitutes for deployed and accepted evidence.

### Product and authority boundaries

- InferOS owns the customer experience, native execution, configuration and delivery tooling.
- InferOps owns authoritative domain transactions, workflow rules and work/dispatch correlation. Existing shared platform and portal identity and tenancy are reused.
- InferMind owns company knowledge, documentation coverage and supporting graph projections.
- Live wiki and Operate widgets reference domain truth; they do not copy it.
- Canvas definition, flow definition, native execution and domain transaction have distinct owners. A saved layout is not a running state machine.
- Gatekeepers constrain delegated authority and preserve native observation and approval semantics. InferOps rechecks current grants, policy and revisions at execution.
- The native runtime is not replaced with a separate generic workflow engine.

## Behavior

The sequence is:

1. Research the customer.
2. Produce a reviewed intake.
3. Model operations in InferOps.
4. Document them in InferMind, with pillar Master-page coverage.
5. Bootstrap the private InferOS.
6. Configure the supported [feature capabilities](feature-capabilities.md).
7. Create issues for gaps.
8. Customize locally.
9. Verify.
10. Deploy explicitly.

Steps 5 through 10 are InferOS work. The private repository pins the foundation, resolves its configuration through the contract in [feature capabilities](feature-capabilities.md), and adds customer-owned code through [connection extensions](connection-extensions.md). Setup, configure, verify, upgrade and recovery run through the [repository setup skills](repo-setup-skills.md).

Independent tracks may proceed in parallel once their contracts are settled. The first build target is the [local coding workflow](local-coding-workflows.md) proof, which does not wait for the full onboarding sequence.

## Non-Goals

- Automatic copying of a live InferOps tenant, or automatic tenant provisioning.
- Implementing every vertical. Vertical research and recipes follow client demand.
- Treating configuration as the ceiling on what a customer repository may contain.
- An implicit production deploy.

## Acceptance and delivery

From the roadmap's completion evidence:

- A reviewed intake yields a modeled tenant, requirement dispositions and a readable pillar Master with meaningful coverage.
- A private consumer starts from supported configuration, preserves customizations and clearly reports unsupported features.
- Selected release scope is explicitly met or deferred.

## Open Questions

- The format of the reviewed intake and how InferOS configuration is derived from it.
- Which CLI commands cover each of steps 5 through 10, and which exist today in the wrapper tooling.
- How unmet requirements are turned into scoped issues, and in which repository they are filed.

## Related

- [Pillars](platform-pillars.md)
- [Consumer configuration](consumer-configuration.md)
- [Repository setup skills](repo-setup-skills.md)
- [Feature capabilities](feature-capabilities.md)
- [Connection extensions](connection-extensions.md)
- [Local coding workflows](local-coding-workflows.md)
- [Consumer bootstrap usage](../wiki/consumer-bootstrap.md)
