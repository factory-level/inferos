---
title: Native agent deployments
covers:
  - packages/workshop-shared/src/agent-deployment.ts
updated: 2026-10-05
---

# Native agent deployments

## Overview

Nothing in the [design](../design/agent-deployments.md) is implemented. `packages/workshop-shared/src/agent-deployment.ts` holds the accepted contract (owner decision 2026-10-05) and nothing else: the types for definitions, deployments, runs and triggers, the operator interface `AgentDeploymentApiProposal`, and two pure rules with tests (`agentDeploymentTransition` over `AGENT_DEPLOYMENT_TRANSITIONS`, and `carryForwardGrants`). No backend code imports it, and no RPC interface exposes it.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/agent-deployment.ts` | Accepted contract types, lifecycle transition table and grant carry-forward rule. Not wired. |

## Data and Control Flow

None. No deployment, trigger or run can be created. Agents run today only as chats and `spawnCallable` agents inside a person's own workspace ([agent authoring](agent-authoring.md)).

## Configuration

`AGENT_DEPLOYMENTS` is accepted by the version 2 configuration schema. Its `capabilitySources` entry in `scripts/consumer/runtime.ts` is `null`, so switching it on is reported unsupported ([feature capabilities](feature-capabilities.md)). This change does not alter that.

## Divergences from Design

The whole accepted contract is unimplemented: storage, the operator capability, triggers, the per-call flag guard and run records.

## Open Questions

- See the [design's open questions](../design/agent-deployments.md#open-questions).
