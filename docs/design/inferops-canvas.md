---
title: InferOps canvas and transactional widgets
status: draft
updated: 2026-10-01
---

# InferOps canvas and transactional widgets

Tracking epic: [#7](https://github.com/factory-level/inferos/issues/7); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Make operational data easy to load, compose and act on through a simple canvas, starting with Kanban and later maps.

## Requirements

- Use existing InferOps transactional domains as the source of truth; canvas stores references and layout, not a second entity database.
- Humans and agents compose the same validated widget contract with sections, limited columns and curated sizes. The renderer owns visual style.
- Use simple Kumo-based styling, restrained chrome, clear loading/stale/error/empty states and accessible interactions.
- Persist canvas identity, ownership/sharing, ordered widget instances, validated params, target references, layout and revision. Preserve existing personal-pin privacy.
- Unify chat, canvas and full-view data identity and action semantics; dedupe scoped reads and invalidate only affected targets.
- Show real agent activity attached to authorized widget/data operations, with explicit active/recent distinctions and expiry.
- Measure Kanban interaction, loading and reconciliation performance with representative data before choosing budgets or announcing high performance.

## Behavior

The v1 portable definition stores id, revision, sections and widget instances. The future authoritative storage record separately owns scope and sharing policy; imports cannot assert either. Each instance has a stable id, registered kind/version, targetRef, schema-validated params and an allowed size. Composition operations add/remove/move/configure instances against an expected canvas revision; preview and undo operate on composition changes, not on silently reversing domain writes. No free-form CSS, absolute pixel placement or arbitrary executable renderer arrives through this interface. Existing InferOps personal pins require explicit migration/import, not silent conversion to shared canvases.

The data adapter keys caches by principal/capability scope plus kind, version, canonical target and normalized params. It rejects cross-scope targets, coalesces duplicate in-flight reads, bounds concurrency and supports cancellation. It must not claim batching where the domain exposes only independent board reads. Board revisions prevent stale snapshots from overwriting newer optimistic changes. Transition actions use the gatekeeper approval path, show pending status and reconcile from authoritative data; failed writes restore or reload the affected board.

Kanban supplies an embedded overview, keyboard-accessible transition actions and a full view using the same domain contract. Offscreen widgets suspend optional polling; visible boards refresh according to freshness policy. Large boards require measured pagination/windowing work rather than an assumption that DOM virtualization fixes oversized payloads.

Activity events are emitted only after authorization, carry canvas/widget/run identity and bounded status metadata, and use sequence/expiry rules. UI states include reading, proposing, awaiting approval, applying, finished and failed; pending approval is not an active edit. Stop, failure, revoke and disconnect clear or expire active indicators. Reconnect loads current activity plus separately labeled recent history. No prompts or transaction payloads enter presence telemetry.

## Non-Goals

No generic agent-authored schema platform, arbitrary free-form Retool clone, unrestricted HTML/CSS renderer, fake cursor animation or maps implementation in the first slice.

## Acceptance and delivery

### Define guarded canvas composition, persistence and shared widget contracts

Tracking issue: [#24](https://github.com/factory-level/inferos/issues/24) (`canvas-contract`).

- Specify registered kinds/versions, validated params, stable target/instance IDs and curated layout/size constraints.
- Choose persistence and ownership for shared canvases; preserve personal-pin scope and explicit import behavior.
- Expose identical validated composition operations to humans and agents with expected revisions, preview and undo.
- Test invalid layouts/params, unsupported kinds, concurrent edits, unauthorized sharing and schema upgrades.

### Build a scoped shared transactional widget data adapter

Tracking issue: [#25](https://github.com/factory-level/inferos/issues/25) (`canvas-data`).

- Keep transactions authoritative in InferOps and key caches by capability/principal plus canonical widget request.
- Coalesce duplicate requests, bound concurrency, cancel unused loads and invalidate affected boards after actions.
- Reconcile decimal-string revisions and pending optimistic mutations without stale overwrite.
- Test scope changes, unauthorized references, partial load failures, duplicate widgets, stale responses and revoked auth.

### Ship Kanban across guarded canvas, chat and full view

Tracking issue: [#26](https://github.com/factory-level/inferos/issues/26) (`canvas-kanban`).

- Adapt project/board contracts to the InferOS host and Kumo conventions without assuming ProjectKanban is drop-in.
- Render loading/empty/stale/error/pending states and shared target identity across chat/canvas/full view.
- Provide keyboard and pointer transitions through approved domain actions; preserve focus and announcements.
- Verify real fixture read, proposal, approval, conflict and refresh flow at narrow and wide sizes.

### Show live agent activity on authorized canvas widgets

Tracking issue: [#27](https://github.com/factory-level/inferos/issues/27) (`canvas-activity`).

- Emit scoped events for authorized reads, proposals, approval waits and applied writes using real run/widget identity.
- Distinguish active from recent activity and proposed from applied changes; omit prompts and data payloads.
- Handle ordering, expiry, cancellation, failures, reconnect and scope revocation.
- Test that unrelated tenants/widgets receive no activity and idle/failed agents cannot remain falsely active.

### Measure and improve Kanban loading and interaction performance

Tracking issue: [#28](https://github.com/factory-level/inferos/issues/28) (`canvas-performance`).

- Capture baseline request counts, payload bytes, p50/p95 load and transition latency, long tasks and memory.
- Use small/large boards and repeated widgets under recorded device/network conditions; agree numeric budgets from evidence.
- Address full-board payload limits explicitly; propose cursor/delta contracts upstream if necessary.
- Prove duplicate widgets share reads, offscreen work is bounded, stale polling does not clobber edits and performance meets the agreed budgets.

### Later: add maps using the shared widget contract

Tracking issue: [#29](https://github.com/factory-level/inferos/issues/29) (`canvas-maps`).

- Keep deferred until Kanban contracts/performance are stable.
- Specify location authorization, viewport filtering, projection/clustering and tile/provider policy.
- Reuse canvas identity, scoped data loading, activity and action paths.
- Define measured large-location fixtures and attribution/offline constraints before selecting a map implementation.

## Open Questions

- Choose ownership and persistence for shared canvas configuration; current InferOps pins are personal and cannot simply be widened.
- Decide whether the canonical InferOps widget client package can be safely adapted to Kumo and capability RPC or needs a thin host-specific renderer.
- Set measured payload, latency and memory budgets from representative device/network fixtures.

## Related

- [Current architecture](../architecture/inferops-canvas.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)

## V1 composition contract decisions

The shared implementation in `packages/workshop-shared/src/canvas.ts` defines the first registered widget and curated layout/edit grammar. Plain-text titles are limited to 120 characters, stable IDs to 64 characters, sections to 12, total widgets to 48 and edit batches to 32. These are conservative validation limits awaiting measured performance evidence. Unknown schema versions reject rather than being guessed or silently migrated.

Operational pages compose InferOps widgets together with the workspace's own Gadgets. A registered `inferos.gadget` kind references a gadget in the owning workspace and renders through the existing sandboxed gadget host; it adds no new renderer, styling or data path and grants no resource access. Gadget references are workspace-local, so portable consumer starter views contain only InferOps widgets.

Storage integration must place definitions under an authorized native workspace capability, preserving existing personal InferOps pins separately. Ownership/sharing metadata must be minted and checked by the storage layer, never accepted as portable composition fields. A view reference must not widen access to any bound InferOps resource. The implementation now supplies validation, atomic composition edits and workspace-scoped definition storage behind owner/build access and both deployment flags. Resource resolution, consumer flag wiring, renderer/agent integration and independent view-sharing controls remain acceptance work.
