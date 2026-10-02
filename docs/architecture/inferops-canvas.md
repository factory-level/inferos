---
title: InferOps canvas and transactional widgets
covers:
  - packages/workshop-frontend/src/GadgetUI.tsx
  - packages/workshop-frontend/src/components/GadgetPresence.tsx
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/overseer.ts
  - packages/ui
updated: 2026-10-01
---

# InferOps canvas and transactional widgets

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](../design/inferops-canvas.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-frontend/src/GadgetUI.tsx` | Sandboxed iframe host and RPC handshake. |
| `packages/workshop-frontend/src/components/GadgetPresence.tsx` | Existing human presence display. |
| `packages/workshop-shared/src/api.ts` | Human presence protocol and native client/server contracts. |
| `packages/workshop-backend/src/overseer.ts` | Session roster and agent execution orchestration. |
| `packages/ui` | Shared Kumo-based interactions. |

## Data and Control Flow

InferOS hosts sandboxed Gadgets and human participant presence; these are not an implemented InferOps canvas or agent activity feed. InferOps has a versioned widget definition, visual/text registries, inferops:// target references and one project/board widget. Its text resolver coalesces repeated URIs, then resolves distinct URIs independently. ProjectKanban currently depends on InferOps authFetch and its own UI environment. The board DTO contains a full board and decimal-string revisions, not a cursor-page protocol. Personal canvas pins are scoped by tenant/workspace/principal and store x/y positions; they are not the guarded shared composition contract proposed here.

## Configuration

Current board widget freshness is 60 seconds. The InferOps board hook pauses polling when the document is hidden and merges revisions while protecting pending changes. Existing personal pins have their own RLS boundary. InferOS frontend changes must follow frontend-conventions and reuse Kumo/@gadgets/ui.

## Divergences from Design

Shared guarded composition, an InferOS widget host/data adapter, live agent activity and measured Kanban performance are unimplemented. Importing the existing React component alone would not resolve authentication, styling, iframe or sharing boundaries.

## Open Questions

- Choose ownership and persistence for shared canvas configuration; current InferOps pins are personal and cannot simply be widened.
- Decide whether the canonical InferOps widget client package can be safely adapted to Kumo and capability RPC or needs a thin host-specific renderer.
- Set measured payload, latency and memory budgets from representative device/network fixtures.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
