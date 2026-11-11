---
title: Workflow run history
design: https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workflows.md
covers:
  - packages/workshop-backend/src/workflow-definition-store.ts
  - packages/workshop-backend/src/overseer.ts
  - packages/workshop-backend/src/env.d.ts
  - packages/workshop-shared/src/workflow-definition.ts
  - packages/workshop-backend/__tests__/workflow-definitions.test.ts
updated: 2026-11-10
---

# Workflow run history

## Overview

Workflow deliveries are the durable run-history records. A workspace keeps at most the configured
number of records (default 10,000). New admission removes at most two batches of 100 expired,
reconciled records. If the workspace remains at its limit, admission is refused with a message that
directs its administrator to wait for expiry or raise the configured limit. In-window records are
never silently evicted.

Settled succeeded and failed records expire after the configured retention (default 90 days).
Not-started records expire after their start window plus retention. Queued, running, waiting,
pending-approval, and uncertain outcomes other than not-started are exempt. Retention and cap are
deployment settings (`WORKFLOW_RUN_HISTORY_RETENTION_DAYS` and
`WORKFLOW_MAX_RUN_HISTORY`), validated at use. Both defaults are proposed, not product defaults.

The ordered expiry index lets admission sweep at most two batches synchronously. When a due backlog
remains, the Durable Object alarm retries one bounded batch after a delay, and schedules successive
passes until the due prefix is drained. FAC-113's
occurrence tombstones remain independent and live for seven days; a tombstone can therefore outlive
its run record, in which case a repeated occurrence remains deduplicated without a run to return.
There is no per-run delete, archive, or ownership transfer. Removing a collaborator does not remove
workspace history.

The first index build on an upgraded workspace scans its legacy deliveries once. Before this change,
admission retained at most 1,000 deliveries per workspace, so that migration scan is bounded by the
former cap. The first admission and first alarm sweep both initialize the index; later admissions
and alarm passes use the index directly. This bound assumes no other writer or import added legacy
rows beyond that former cap.

Each delivery retains its definition owner's profile id. The recorded owner and a persisted edit
share can list history by definition id even after a temporary definition is swept. Other
people receive the same not-found response as an unknown definition. Definition expiry does not
delete run history or action receipts.

The Workshop discovers history IDs through `listReadableWorkflowHistories`, which returns only
definitions whose history the caller may read: the owner or a persisted edit-share holder. This
includes histories whose temporary definition was swept. A stranger does not receive the ID and
cannot read its history. For each discovered definition, the UI reads its deliveries and shows
loading, error with retry, empty, or populated state; a failed request is never presented as empty.
The trigger editor also reads the latest five deliveries for its pinned definition and filters them
to that trigger. It shows the outcome, time, revision and server-computed expiry date using the
deployment's configured retention; records still live or uncertain are labeled as retained while
live, uncertain or waiting. When an on-request run is refused at the workspace cap, the existing
server message tells the owner to wait for older completed runs to expire or ask an administrator
to raise the limit. The cap cannot be monitored live from the Workshop.

`security-review` was not available to the implementation seat; this change has not been represented
as security-reviewed.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-backend/src/workflow-definition-store.ts` | Stores run deliveries, indexes expiry, enforces the cap, and lists history. |
| `packages/workshop-backend/src/overseer.ts` | Supplies deployment settings, schedules bounded sweeps, and authorizes history reads. |
| `packages/workshop-backend/src/env.d.ts` | Declares deployment retention and cap settings. |
| `packages/workshop-shared/src/workflow-definition.ts` | Defines defaults, bounds, validation, and the owner-visible cap refusal. |
| `packages/workshop-frontend/src/features/workspace-kind/TriggerControlEditor.tsx` | Shows recent per-trigger run history and retention state to definition editors. |
| `packages/workshop-frontend/src/features/workspace-kind/WorkflowHistorySection.tsx` | Discovers readable definition histories and shows each history's loading, error, empty, or populated state. |

## Data and Control Flow

Admission initializes the retention index if needed, removes at most 200 due eligible records, then
refuses admission if the workspace remains at its cap. Settling an eligible delivery updates its
ordered expiry pointer. Alarm sweeps use the same bounded index. History reads first pass the
workspace shared-configuration authorization check, then return a definition's deliveries to its
owner or an authorized workspace editor. The UI discovers readable definition IDs through the
same owner/edit-share rule before loading deliveries.

## Configuration

`WORKFLOW_RUN_HISTORY_RETENTION_DAYS` defaults to 90 and accepts whole days from 1 through 3,650.
`WORKFLOW_MAX_RUN_HISTORY` defaults to 10,000 and accepts whole counts from 1,000 through 100,000.
Invalid values fail closed when the setting is used. These are proposed defaults pending the
companion human design proposal.

## Divergences from Design

Transfer and archive are not implemented; they are out of scope and require a follow-up decision.
The shared design proposal is pending.

## Open Questions

- Confirm the proposed defaults and bounds in the companion human design proposal.
- Define transfer and archive semantics in a follow-up.
