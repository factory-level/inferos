---
title: Scheduled tasks
design: https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workflows.md
covers:
  - packages/gatekeeper-scheduler/src/schedule-driver.ts
  - packages/workshop-backend/src/overseer.ts
  - packages/workshop-shared/src/workflow-definition.ts
  - packages/workshop-backend/__tests__/workflow-invocation.test.ts
updated: 2026-11-12
---

# Scheduled Tasks

Scheduled Tasks is an InferOS gatekeeper whose durable driver stores schedules under both the
connected account and the target workspace. A schedule controller is bound to one immutable
workspace and schedule id; it cannot list or inspect another workspace's schedules. Equal
schedule ids in two workspaces therefore identify separate records.

## Workflow schedule visibility

The workflow trigger list may show a schedule only after the Workshop has checked that the current
viewer can read the workflow definition pinned to that trigger. This includes definition readers
and runners, as well as editors and owners. A person without definition read access sees neither
the schedule nor its title or description. An operate session cannot use this read.

For an authorized definition, the projection contains only the trigger (`hookId`), schedule id,
title, description, cadence, status, and the next fire time while the schedule is active. Titles
and descriptions are visible because the same person already has permission to read those fields
on the definition. The projection excludes connection data, secrets, run inputs, requester
identity, account-wide schedule state, and admission refusal details. Creating, changing, and
removing schedules remains a builder capability.

The Workshop bounds schedule reads to 100 authorized scheduler hooks per call and gives each
controller read two seconds. Reads proceed independently: a timeout, rejection, or malformed
projection omits that entry without withholding the others. Runtime validation checks the cadence
and status variants and bounds schedule id, title, description, and time-zone strings before the
projection crosses the RPC boundary.

## Removing a workflow trigger

Removing a workflow trigger first pauses it. No firing admitted after the pause begins, and no new
manual request, can start. A run admitted before the pause is allowed to finish with its recorded
definition and revision. If it is still executing, the removal request returns a fixed message that
the trigger is paused while its run finishes; retry removal after the run completes to retire the
trigger. Retirement removes the trigger and its control but preserves delivery and run history.
Ordinary hooks that are not pinned to a workflow keep immediate deletion behavior.

Deleting the gadget itself stops its runs: the run's executable code is part of the gadget being
removed. This is distinct from removing only a schedule, which drains the already admitted run.
While a trigger is draining, the delete response carries the stable `TRIGGER_DRAINING` code and
explains that the trigger is paused; clients can offer retry after the run finishes. In the
Connections tab, this response is shown as an informational paused state rather than a deletion
error. The owner can retry removal there; after the run finishes, retry removes the trigger while
leaving its history available in Recent.
