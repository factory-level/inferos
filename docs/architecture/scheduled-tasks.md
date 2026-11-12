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
