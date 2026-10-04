---
title: Customer OS onboarding
status: draft
updated: 2026-10-03
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

### Reviewed intake

InferOS consumes the reviewed intake as one JSON file, `scripts/consumer/intake.schema.json` (schema version 1). The intake is the InferOS-facing summary of steps 1 to 4, not the InferOps model itself. It holds:

- `synthetic`: whether the intake describes invented sample data. Reports and drafted issues carry the label.
- `review`: status (`reviewed` or `draft`), reviewer and date. Only a reviewed intake is applied.
- `customer`: the customer's name.
- `inferops`: one tenant and workspace slug, and one or more projects, each with a key, name and workflow kind (`software` or `content`). Each project is referenced as `inferops://<tenant>.<workspace>/project/board/<KEY>` ([ADR 0005](../adr/0005-inferops-uri-authority.md)). A reference identifies a target and never authorizes it.
- `capabilities`: the requested product capabilities (`kanban`, `wiki`, `local-coding`, `state-machine`, `harness`, `publish-widget`, `publish-app`, `agent-deployments`).
- `wiki.pillars`: the onboarding-selected Wiki pillars.
- `operations`: the operational inventory. Each operation has an id, name, owner, project, optional pillar and optional SOP reference.
- `requirements`: each with an id, text and category. The category decides the disposition.

The validator is strict, versioned and bounded. Unknown fields, an unknown version, values over their limits and broken cross-references are rejected. Errors name the field and the rule, never the rejected value.

Applying an intake derives only supported configuration. It switches on a configuration capability only when the pin implements it, never an unsupported one. It also sets the `inferops-operations` profile and writes a starter view and screen template that reference the customer's boards. Every requirement is reported as `supported`, `unsupported` or `custom-work`, with a reason and the capability or issue it maps to. No requirement is dropped. Wiki pillars stay pending [#87](https://github.com/factory-level/inferos/issues/87) until the Wiki host ships.

The fields the intake manages are recorded, so a rerun updates only values the intake wrote and the customer has not changed since. A customer edit is kept. When the customer's value and the intake's value have both changed, the conflict is reported and the field is not overwritten. A gap issue is drafted for every `unsupported` and `custom-work` requirement. Issues are filed only on an explicit request, in the repository the operator names.

### Commands for steps 5 to 10

| Step | Command | Status |
| --- | --- | --- |
| 5. Bootstrap | `node scripts/consumer/bootstrap.ts <dest> <repo> <sha>`, then `pnpm inferos:check`, `pnpm run setup` and `pnpm run doctor` in the wrapper | Exists |
| 6. Configure | `pnpm inferos intake apply <file>`; `pnpm inferos config migrate` for a version 1 wrapper; `pnpm canvas` and `pnpm profile:init` | Exists |
| 7. Create issues for gaps | `pnpm inferos intake apply <file> --file-issues <owner/repo>` | Exists |
| 8. Customize locally | Edit `workers/`, `gatekeepers/`, `blueprints/`, `skills/` and `views/`. Validate with `pnpm extensions:check`, `pnpm blueprints:check`, `pnpm skills:check` and `pnpm views:check`. Run with `pnpm dev` or `pnpm local start` | Exists |
| 9. Verify | `pnpm inferos verify` (check, doctor, `pnpm local status` and, while the stack runs, `pnpm local verify` in one JSON report). Live acceptance is recorded per issue against a running InferOps | Local verify exists; a cloud-parity check does not ([#11](https://github.com/factory-level/inferos/issues/11)) |
| Upgrade | `pnpm inferos upgrade <sha>` (plan), then `--apply`; `pnpm inferos recover ports\|config\|fixtures\|state` for local repairs | Exists for one local wrapper ([#20](https://github.com/factory-level/inferos/issues/20)); multi-customer upgrade PRs and three-way template merges do not ([#75](https://github.com/factory-level/inferos/issues/75)) |
| 10. Deploy explicitly | `pnpm inferos deploy` | Does not exist yet ([#11](https://github.com/factory-level/inferos/issues/11)) |

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

- Whether unmet requirements should be filed in the customer's wrapper repository, in InferOS, or in both. The command files into the repository the operator names.
- How the intake is produced from the InferOps model (steps 3 and 4). Today it is written and reviewed by hand. The inventory companion is [factory-level/inferops#2324](https://github.com/factory-level/inferops/issues/2324).
- When `inferops.targetRef` and the synthetic fixture should follow the customer's first project, rather than stay on the synthetic board.

## Related

- [Pillars](platform-pillars.md)
- [Consumer configuration](consumer-configuration.md)
- [Repository setup skills](repo-setup-skills.md)
- [Feature capabilities](feature-capabilities.md)
- [Connection extensions](connection-extensions.md)
- [Local coding workflows](local-coding-workflows.md)
- [Consumer bootstrap usage](../wiki/consumer-bootstrap.md)
