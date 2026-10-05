---
title: External-agent platform integrations
status: draft
updated: 2026-10-02
---

# External-agent platform integrations

Tracking epic: [#52](https://github.com/factory-level/inferos/issues/52); roadmap: [#1](https://github.com/factory-level/inferos/issues/1); provider and consumer companions: [factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326) and [factory-level/inferops#2316](https://github.com/factory-level/inferops/issues/2316). Decision record: [ADR 0003](../adr/0003-distinct-agent-capabilities.md).

## Wave 5 disposition

Harness HG and all #81 work are completely deferred by the owner. No HG research, adapter/configuration, fixture, conformance or runtime-control work is included. The historical requirements below remain backlog, not current delivery scope. Wave 5 prepares only the [provider-neutral contract](external-agent-contract.md) and review scenarios for #79/#80. No runtime bridge or production client is implemented.

## Purpose

Let Harness HG and other agent platforms install an integration that operates a customer's InferOS, InferOps and InferMind through the same governed capabilities, without requiring Harness HG, replacing those platforms' runtimes, or duplicating business APIs.

This is a proposed design and backlog. No plugin installation, agent dispatch, permission or production code exists for it yet.

## Requirements

- Publish versioned client, session, operation and error contracts and a thin shared client.
- Adapters select the appropriate supported CLI, HTTP or MCP interface, translate host-specific invocation and results, and declare their capabilities truthfully.
- Keep platform client access separate from optional runtime control such as start, resume, cancel and deploy. An unsupported runtime control fails explicitly; suppressing it in the UI is not enough.
- Authenticate individual agents. Bind tenant, workspace and resource scope, the deployment or installation identity, and current grants. Never trust an adapter's self-asserted identity or approval.
- Route agent platform access through native Gatekeeper policy and observations and the provider contract. There is no broad direct backend token bypass. The domain keeps its final authorization and revision checks.
- Exporting sensitive data to an external runtime requires explicit policy.
- Package adapter config schema, skills, SOPs, fixtures and conformance tests. Pin versions, and update customer forks through [connection extensions](connection-extensions.md) without copying credentials or widening authority.
- Do not introduce a second task store, a second authorization engine, a universal agent fleet or a mandatory transport.

## Behavior

An integration exposes to an authorized external agent: authorized knowledge, SOP and Master-page text; operational reads and actions; proposals and approval status; and attributable results. Capability discovery exposes only the operations that agent is authorized for.

Only explicitly authorized agents can invoke the [local coding workflow](local-coding-workflows.md). Ordinary read or write rights do not imply dispatch.

A plugin cannot provide native CloudflareOS containment over an unrestricted external host. External plugins do not inherit the native sandbox.

`HARNESS_HG_ENABLED` (see [feature capabilities](feature-capabilities.md)) gates only the HG integration. Disabling it does not block other adapters or native agents.

InferOps owns the provider-side changes and task identity. It does not own each client's runtime.

## Non-Goals

- Making Harness HG a requirement.
- Replacing an external platform's runtime.
- Duplicating business APIs for each adapter.
- Native [agent deployments](agent-deployments.md), which are a separate lifecycle, and the local coding runner, which is a separate capability.
- Waiting for every adapter before local coding's first proof.

## Acceptance and delivery

- Harness HG and one independent external client perform the same scoped workflow (read context, propose an action, approval and result) with denial, revocation and retry evidence.
- One allowed external agent invokes the local coding workflow; denied dispatch, stale config and disconnected runtime states are visible.
- HG disabled does not block other adapters or native agents. Local coding's first proof does not wait for every adapter.
- Capability discovery exposes only authorized operations; optional management capabilities have actual conformance tests.
- No second task store, authorization engine, universal agent fleet or mandatory transport is introduced.

## Open Questions

- The shape of the versioned contracts and where the thin shared client lives.
- How an individual external agent is authenticated and bound to an installation identity.
- The policy model for exporting sensitive data to an external runtime.
- Which independent external client is the second conformance target.

## Related

- [InferOps gatekeeper](inferops-gatekeeper.md)
- [Connection extensions](connection-extensions.md)
- [Local coding workflows](local-coding-workflows.md)
- [Agent deployments](agent-deployments.md)
- [Feature capabilities](feature-capabilities.md)
- [Repository setup skills](repo-setup-skills.md)
- [Pillars](platform-pillars.md)
