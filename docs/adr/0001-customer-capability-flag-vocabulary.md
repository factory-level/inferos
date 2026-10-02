---
title: Customer capability flag vocabulary
status: proposed
date: 2026-10-02
---

# 0001. Customer capability flag vocabulary

## Context

The consumer foundation (PR #37, merged 2026-10-02) gives a wrapper three structural flags in `inferos.config.json`: `composableViews`, `durableViews` and `customCloudflareCode`. They describe canvas and extension mechanics.

The 2026-10-02 roadmap consolidation ([#1](https://github.com/factory-level/inferos/issues/1), [#33](https://github.com/factory-level/inferos/issues/33)) adds capabilities those three cannot express: the InferOps integration and its identity mode, stateful Operate flows, the Harness HG integration, widget and application publication, native agent deployments and local coding workflows. Each needs to be offered or withheld per customer and enforced consistently by the server, tools, the CLI and the UI.

Two risks shape the decision. A flag can be mistaken for authority, so that turning a feature on appears to grant access. And a legacy flag can be mapped to a new one that means more, so that a saved durable layout appears to be a running state machine.

## Decision

Adopt eight customer capability flags as the target vocabulary:

`INFEROPS_ENABLED`, `INFEROPS_CANVAS_STATE_MACHINE`, `HARNESS_HG_ENABLED`, `INFEROPS_AUTH`, `PUBLISH_CLOUDFLAREOS_WIDGET`, `PUBLISH_CLOUDFLAREOS_APP`, `AGENT_DEPLOYMENTS`, `CODING_WORKBENCH_ENABLED`.

Move to it through an explicit, versioned migration and compatibility mapping from the three legacy flags that preserves existing customer configuration. A legacy flag is retained where its meaning differs.

A flag states availability only. It is never a credential, grant, activation, deployment or publication. Dependencies between flags are validated explicitly and are never satisfied by silently enabling another flag.

Provider and adapter versions, resource references, policies, publication destinations and secret references remain separate configuration fields.

## Consequences

- One resolved configuration serves code generation, development and deployment, with per-field provenance.
- Every flag needs a named owner, default, dependencies, enforcement path at each surface, and disable and retention semantics before it is implemented.
- Current code does not accept these names. Until the migration ships, the legacy flags are the working contract and the installation must report its supported flags truthfully.
- Each runtime feature needs a drain or cancel policy for disablement, and re-enabling does not restore revoked grants.

## Alternatives Considered

- Keep only the three legacy flags: they cannot express the integration, identity, publication, deployment or coding capabilities.
- Rename the legacy flags in place without a versioned migration: existing customer configuration would break or change meaning silently, and `durableViews` could be read as state-machine execution.
- One boolean per provider: provider and adapter choice is configuration data with versions and references, not an on/off capability.

## Related

- Design: [`../design/feature-capabilities.md`](../design/feature-capabilities.md)
- Design: [`../design/consumer-configuration.md`](../design/consumer-configuration.md)
