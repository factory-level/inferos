---
title: Reusable native agent authoring
covers:
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/agent-spawner-binding.d.ts
  - packages/gatekeeper-scheduler
  - docs/blueprints.md
updated: '2026-10-05'
obsidian_designs:
- note: software/InferOS/InferOS Agent Deployments.md
  sections:
  - Agent deployments
- note: software/InferOS/InferOS Durable Agents.md
- note: software/InferOS/InferOS IAM.md
  sections:
  - Remote agent boundary
---

# Reusable native agent authoring

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Agent%20Deployments.md%23Agent%20deployments), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/api.ts` | Native Gadget, Blueprint, binding and agent APIs. |
| `packages/workshop-backend/src/agent-spawner-binding.d.ts` | Callable agents and completion callback contract. |
| `packages/gatekeeper-scheduler` | Persistent workspace callbacks. |
| `docs/blueprints.md` | Portable code and binding requirements. |

## Data and Control Flow

InferOS already provides native Gadgets, Blueprint import/export, bindings and callable agents. spawnCallable persists an enqueue; completion uses callbacks rather than synchronous task completion. Scheduler callbacks are persistent but not exactly-once. Blueprint export does not contain live SQLite state, history or credentials. AI Trader’s registry implements revisions and qualification concepts; its generic agent authoring issues are still planned, so they are requirements evidence rather than proof of a shipped editor.

## Configuration

Model and gatekeeper bindings are installed in the destination workspace. Scheduler hooks must be enabled through Connections. BUNDLED_BLUEPRINTS_DIR selects deployment bundles; it does not establish artifact qualification.

## Divergences from Design

The owner clarified on 2026-10-05 that agents belong to the deployment feature and are independently authored. Both native Gadget-based and Mastra-connected agents remain in scope; the earlier shared agent-creation API proposal is superseded. Existing native primitives do not establish a complete deployment lifecycle or remote approval contract. All intended IAM goes through InferOS gatekeepers. Durable-agent execution remains undecided in Obsidian.

## Open Questions

- Define registration, configuration, activation, updates and removal for supplied agents using existing runtime primitives where possible.
- Prove remote gatekeeper authority and approval behavior separately from AG-UI transport.
- Resolve durable execution, recovery and version-update behavior in InferOS Durable Agents before claiming those guarantees.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.

## Design authority

The `obsidian_designs` front matter identifies intended design in the `authored` vault.
Read the owning notes through the [Obsidian CLI workflow](_brain.md); references do not
imply complete implementation.
