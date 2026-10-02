---
title: Distinct agent capabilities
status: proposed
date: 2026-10-02
---

# 0003. Distinct agent capabilities

## Context

Three kinds of agent work appear in the roadmap ([#1](https://github.com/factory-level/inferos/issues/1)):

- operational agents that run natively on CloudflareOS primitives ([#53](https://github.com/factory-level/inferos/issues/53));
- agents on external platforms, Harness HG among them, that operate the customer's environment from outside ([#52](https://github.com/factory-level/inferos/issues/52));
- coding tools that run on a local machine ([#48](https://github.com/factory-level/inferos/issues/48)).

They could be read as three implementations of one runtime. They differ in where they execute, what contains them, and what authorizes them: a native deployment runs inside the sandbox, an external plugin does not inherit that containment, and a local coding child runs in a worktree, which is not a sandbox.

## Decision

Native agent deployments, external-agent platform integrations and local coding runners are three separate capabilities. Each has its own flag (`AGENT_DEPLOYMENTS`, `HARNESS_HG_ENABLED` for the HG adapter, `CODING_WORKBENCH_ENABLED`), its own lifecycle and its own acceptance tests.

Harness HG is optional. Disabling it blocks neither native deployments, other external adapters, nor local coding.

All three reach customer data and actions through the same governed capabilities: native Gatekeeper policy and observations, with InferOps keeping final authorization and revision checks. None introduces a second task store, authorization engine or general workflow engine.

Persona and skills are behavior, not permissions.

## Consequences

- Each capability can ship and be proven independently. Local coding's first proof waits for neither adapters nor native deployments.
- The containment each one actually has must be stated truthfully. An external plugin or local host cannot claim native sandbox containment.
- An external agent that wants to dispatch local coding needs explicit dispatch authorization; read or write rights do not imply it.
- Three lifecycles and three conformance suites must be maintained.
- The shared provider contract ([factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326)) has to serve all three without a per-capability backend bypass.

## Alternatives Considered

- One unified agent runtime: would force external hosts and local tools into the native execution model, or weaken the native sandbox to fit them.
- Harness HG as the mandatory harness: makes one external platform a dependency of native deployments and local coding.
- Replace native execution with a general workflow engine: discards the native Gadget, callable-agent, scheduler and Gatekeeper primitives already in place.

## Related

- Design: [`../design/agent-deployments.md`](../design/agent-deployments.md)
- Design: [`../design/agent-platform-integrations.md`](../design/agent-platform-integrations.md)
- Design: [`../design/local-coding-workflows.md`](../design/local-coding-workflows.md)
