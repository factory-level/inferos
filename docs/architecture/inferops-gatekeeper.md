---
title: InferOps gatekeeper
covers:
  - packages/gatekeeper-kit
  - packages/workshop-shared/src/gatekeeper.ts
  - packages/workshop-backend/src/user.ts
  - packages/mcp-shared
updated: 2026-10-01
---

# InferOps gatekeeper

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](../design/inferops-gatekeeper.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/gatekeeper-kit` | Connection lifecycle, capability scaffolding and approval integration. |
| `packages/workshop-shared/src/gatekeeper.ts` | Gatekeeper protocol contracts. |
| `packages/workshop-backend/src/user.ts` | Gatekeeper capability issuance policy. |
| `packages/mcp-shared` | Existing generic MCP connector implementation. |

## Data and Control Flow

There is no InferOps-specific gatekeeper in this checkout. Gatekeeper-kit supplies the native integration pattern, including nonce-bound handoff and staged reconnect. Generic MCP connectors already exist, but do not establish a dedicated typed board projection or canvas host. InferOps separately owns project board transactions and scope enforcement; those domain APIs are the proposed boundary.

## Configuration

A deployable gatekeeper needs canonical Worker config and explicit router/backend service bindings. Avoid spurious CLIENT_ID/CLIENT_SECRET deployment inputs if the chosen auth flow does not use them. Ambient provisioning is configured by user/admin policy, never declared as authority by the connector.

## Divergences from Design

The scoped InferOps account/session API, transition approval adapter and isolation tests are new work. Existing connector machinery should be reused without widening the kernel.

## Open Questions

- Agree the external InferOps authentication and API contract, including service versus user authority.
- Does the existing transition endpoint provide sufficient idempotency for approved action retries, or is a companion InferOps change required?

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
