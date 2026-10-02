---
title: Reusable authoring and widget evidence
updated: 2026-10-01
---

# Reusable authoring and widget evidence

What AI Trader and InferOps already provide, and what still needs a native adapter.

## Steps

1. Inspect pinned implementation before copying a feature claim from an issue or design.
2. Extract domain-neutral contracts and prove them against native InferOS primitives.
3. Keep sibling repositories authoritative for their domain transactions.
4. Publish adapter/compatibility evidence with the resulting implementation.

## AI Trader

Inspected revision: `943c28666dc6dd5093ef411684b18023f93e3cc0`.

| Evidence | Reusable finding | Do not infer |
| --- | --- | --- |
| `libs/backend/registry/src/index.ts`, `memory.ts`, `postgres.ts` | Revision and publication/qualification machinery | Full native agent authoring UI is already implemented |
| `docs/architecture/revision-loop.md` | Revision provenance and proof discipline | Its database/runtime must be imported wholesale |
| [#34](https://github.com/factory-level/ai-trader/issues/34), [#42](https://github.com/factory-level/ai-trader/issues/42) | Shared user/developer contracts; generic authoring intent | Open issue acceptance criteria are current code |
| [#43](https://github.com/factory-level/ai-trader/issues/43), [#80](https://github.com/factory-level/ai-trader/issues/80) | Skill creation and early native deterministic/callable/scheduler proofs | A new trading-specific workflow engine belongs in InferOS |

Port instructions, validation, diffing, immutable skill dependencies and qualification concepts. Keep brokerage, market execution and strategy semantics out of the reusable layer. Export must rebind destination authority and qualify the exact imported revision.

## InferOps

Inspected revision: `29b01a024c377b9c37b8754e7001b290e15d1509`. The sibling worktree also has unrelated uncommitted documentation; this baseline relies on the inspected widget/project source, not those drafts.

| Evidence | Current behavior | Adapter gap |
| --- | --- | --- |
| `_libs/widgets/shared/define-widget.ts` | Registered kind, params schema, contractVersion, supported sizes, permission, freshness and action metadata | InferOS runtime/host integration |
| `_libs/widgets/shared/inferops-uri.ts` | Stable domain target reference grammar | URI is an identifier, not authorization |
| `_libs/widgets/shared/resolve.ts` | Repeated-URI dedupe, separate distinct projections | No single bulk database query or bounded load contract proven |
| `domains/project/shared/board-widget.ts` | project/board visual/text projection, transition action, freshness 60s | Shared host adapter and approval integration |
| `domains/project/shared/board.dto.ts` | Full board with string revisions; expectedRevision optional | Pagination/deltas and mandatory revision policy for approved writes need decisions |
| `domains/project/backend/board.ts` | Domain scope/business-rule checks and revision-aware writes | Agree externally supported auth/API/idempotency boundary |
| `domains/project/client/kanban.tsx` | Existing interactive board with embedded mode | InferOps authFetch/UI dependencies prevent direct drop-in reuse |
| `domains/project/client/use-project-board.ts` | Polling/focus handling and revision merge protecting pending edits | Cross-widget dedupe and measured payload strategy |
| `domains/knowledge/backend/canvas-pins.ts` | Personal tenant/workspace/principal-scoped pins | Shared guarded composition is a different contract |

Existing coordination issues: [operational-space pins #1698](https://github.com/factory-level/inferops/issues/1698), [chat/pinning #1627](https://github.com/factory-level/inferops/issues/1627), [templates #1166](https://github.com/factory-level/inferops/issues/1166), [layout persistence #1152](https://github.com/factory-level/inferops/issues/1152). The InferOS backlog links these; it does not claim to close or replace them.

## Performance proof design

Use repeated widgets referencing one board, multiple independent boards, a large board with pending edits, a slow response arriving after a mutation, hidden/offscreen views, reconnect and scope changes. Record API calls, transferred bytes, visible-card counts, long tasks, memory and p50/p95 latency with hardware/network details. Choose numeric release budgets after capturing the baseline. Virtualization reduces rendering work; it does not by itself reduce a full-board API payload.
