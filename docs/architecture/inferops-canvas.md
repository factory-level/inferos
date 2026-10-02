---
title: InferOps canvas and transactional widgets
covers:
  - packages/workshop-frontend/src/GadgetUI.tsx
  - packages/workshop-frontend/src/components/GadgetPresence.tsx
  - packages/workshop-shared/src/api.ts
  - packages/workshop-shared/src/canvas.ts
  - scripts/consumer/views.ts
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

A guarded composition schema and pure edit engine now exist; authorized persistence, an InferOS widget host/data adapter, live agent activity and measured Kanban performance are unimplemented. Importing the existing React component alone would not resolve authentication, styling, iframe or sharing boundaries.

## Open Questions

- Choose ownership and persistence for shared canvas configuration; current InferOps pins are personal and cannot simply be widened.
- Decide whether the canonical InferOps widget client package can be safely adapted to Kumo and capability RPC or needs a thin host-specific renderer.
- Set measured payload, latency and memory budgets from representative device/network fixtures.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.

## Implemented guarded definition and edit engine

`@gadgets/workshop-shared/canvas` exports v1 definition, content, section, widget and operation types, `parseCanvasDefinition`, `applyCanvasOperations` and a revision-conflict error. The parser reconstructs detached objects, accepts only known fields and rejects unknown definition/widget versions. The only registered widget is `inferops.project-board` v1, with a canonical target reference, software/content workflow filter and explicit completed-card visibility. Presentation filters do not authorize data. No transaction DTO, credentials, ownership or sharing grants are embedded in portable content.

View, section and widget IDs occupy one unique namespace per definition. Titles are bounded plain text. Sections have one to three desktop columns; sizes are normal (one column), wide (up to two), or full (all available columns). The renderer must collapse layouts responsively. Structural limits are 12 sections, 48 total widgets and 32 operations per batch; these bound validation work and are not measured performance budgets.

Edits add/remove/move/configure sections or widgets, rename the view, or restore validated prior content. Move indices refer to the destination after removal. Every intermediate composition validates, and a failure returns no partially modified caller state. A successful batch advances one canonical decimal-string revision using BigInt; stale expected revisions return a conflict with the current revision. Restore keeps the view identity and advances revision; it never invokes or reverses InferOps transactions. An unchanged-content edit still consumes a revision.

This engine performs no storage, authorization or feature enforcement. Its result is suitable for preview. Before persisting, a server caller must check installation flags and workspace edit authority, resolve resource capabilities independently, and compare/write inside one storage transaction. A test of this pure engine is not evidence that concurrent durable writes are safe.

Bootstrap writes `views/operations.json` with the configured target reference. `views:check` runs the pinned validator, bounds file count/size, rejects links/executable files and duplicate view IDs, and reports runtime readiness false. It does not load the InferOps fixture, connect a provider or publish a view. The composable/durable flags continue to fail startup while their adapters are absent.
