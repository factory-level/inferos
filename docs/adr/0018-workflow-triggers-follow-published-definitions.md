---
title: Workflow triggers can follow a definition's latest publication
status: proposed
date: 2026-11-10
---

# 0018. Workflow triggers can follow a definition's latest publication

## Context

A trigger tied to a workflow definition revision requires a builder to repin it after every
publication. That couples deployment to publication and can leave routine workflow updates using
an old revision. At the same time, existing triggers may intentionally target a specific revision,
so changing their behavior in place would be unsafe.

## Decision

New trigger definitions default to `follow-latest`: a request records the published revision at
admission. Its delivery callback may run that revision after a newer publication only while the
gadget head still matches the admitted revision's commit. If the head moved, firing refuses with
“The workflow changed; ask again” so the run cannot record one revision while executing another.
A trigger can explicitly select `pinned` to retain its revision.
Existing stored pins without a mode continue to mean `pinned`; they are never migrated silently.
Each delivery records its starting definition, revision and commit. Follow-latest refuses to run a
definition without a publication, and also refuses when the gadget head is not the commit of the
current publication. Unpublished saves never change the version it runs.

Delivery retention is capped at 1,000. Terminal deliveries and runs that never started within the
10-minute start window may be evicted FIFO. Runs with queued, running, waiting or possibly-applied
uncertain work remain live. If all retained deliveries need completion or reconciliation, admission
refuses and reports their count. Requested-run reads in company-scoped deployments require known,
matching stored and current company scopes. Deployments without company-scoped gatekeeper authority
use the requester's identity as the scope.

## Consequences

Routine publication updates follow-latest triggers without extra configuration. Operators retain a
fixed-revision option, and existing workflows keep their historical behavior. Trigger controls and
delivery records should display the mode and the revision a run actually used. Revision history
must remain available while any delivery can reference it.

## Alternatives Considered

- Keep all triggers pinned by default: this requires a repin for each publication and was the
  repeated source of stale workflow behavior.
- Migrate existing pins to follow-latest: rejected because it silently changes which code an
  existing trigger can execute.

## Related

- Architecture: [Workflow definitions](../architecture/operate-mode.md#workflow-definitions)
