---
title: Native agent deployments
status: draft
updated: 2026-10-02
---

# Native agent deployments

Tracking epic: [#53](https://github.com/factory-level/inferos/issues/53); roadmap: [#1](https://github.com/factory-level/inferos/issues/1). Decision record: [ADR 0003](../adr/0003-distinct-agent-capabilities.md).

## Purpose

`AGENT_DEPLOYMENTS` enables persistent native CloudflareOS agent deployments: a reviewed persona, instruction and skill artifact bound to a scoped identity, capabilities and triggers. Always-on means available independently of a browser session, not an endless inference loop.

This is a draft target. The deployment lifecycle is not shipped, and the exact API, schema and provider support are reviewed during implementation.

## Requirements

Three things stay distinct:

| Term | Meaning |
| --- | --- |
| Definition | Immutable, versioned instructions and persona, pinned skills, and model and binding requirements. It holds no credentials. |
| Deployment | A selected definition in a customer environment with an authenticated agent identity, explicitly granted resource bindings, schedules, events or callers, limits and a lifecycle state. |
| Run | One invocation with its actual native execution identity, status, observations, approval waits and result. InferOps may correlate a run to work; it does not become a second native scheduler or executor. |

- Use native Gadgets and Blueprints, callable agents, scheduler callbacks and Gatekeepers. Reuse completed and available primitives, including the artifact contract in [agent authoring](agent-authoring.md), before rebuilding.
- Preserve completion-callback versus enqueue semantics and idempotent retry behavior.
- Persona and skills are behavior, not permissions. Persona or skill edits cannot change grants.
- Deploying an app or widget does not automatically deploy an agent.
- Setting the feature flag creates no agent, trigger, spend or privilege.

## Behavior

### Lifecycle

An authorized operator validates and plans a deployment, reviews the capabilities it requests, explicitly activates it, inspects it, pauses or drains it, updates it to a pinned revision, or retires it.

Artifact export and import rebinds destination resources. It never copies source credentials, live grants, runtime history or execution state.

Update, pause and retire preserve evidence. They do not silently transfer grants or execute old approvals under changed semantics.

### Isolation

Two deployments of one definition remain isolated in identity, resources and history.

### Disabled flag

With `AGENT_DEPLOYMENTS` off (see [feature capabilities](feature-capabilities.md)), new activation and invocation are denied through all authoritative surfaces. The design defines drain or cancel for existing runs, retained history, restricted diagnostic access, and re-enable behavior.

### Inventory

The customer's operational inventory and InferMind Master coverage include the deployment's role, scope and SOP obligations, not secret payloads.

## Non-Goals

- Replacing native execution with a new general workflow engine.
- Requiring Harness HG. `HARNESS_HG_ENABLED=false` does not disable native deployments.
- [External-agent platform integrations](agent-platform-integrations.md) and [local coding workflows](local-coding-workflows.md), which are separate capabilities with their own gates.
- An endless inference loop as the meaning of always-on.

## Acceptance and delivery

- One native deployment survives browser closure and can receive an authorized schedule, event or call using native execution.
- Two deployments of one definition remain isolated in identity, resources and history.
- Policy denial, revoked binding, retry or duplicate event, waiting approval, cancellation and observed actual completion are tested.
- Update, pause and retire behavior preserves evidence and does not silently transfer grants or execute old approvals under changed semantics.
- `HARNESS_HG_ENABLED=false` does not disable native deployments; local coding remains independently gated.
- Operational inventory and InferMind Master coverage include the deployment's role, scope and SOP obligations, not secret payloads.

## Open Questions

- The exact API and schema for definitions, deployments and runs.
- Provider support for the triggers a deployment may declare.
- The drain or cancel policy for existing runs when the flag is disabled, and what re-enabling restores.
- How a deployment's agent identity is authenticated and how its resource bindings are granted.

## Related

- [Agent authoring](agent-authoring.md)
- [InferOps gatekeeper](inferops-gatekeeper.md)
- [Feature capabilities](feature-capabilities.md)
- [Agent platform integrations](agent-platform-integrations.md)
- [Local coding workflows](local-coding-workflows.md)
- [Pillars](platform-pillars.md)
