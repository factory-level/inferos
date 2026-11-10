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

New trigger definitions default to `follow-latest`: each admitted run resolves the definition's
current published revision. A trigger can explicitly select `pinned` to retain its revision.
Existing stored pins without a mode continue to mean `pinned`; they are never migrated silently.
Each delivery records its starting definition, revision and commit, so a run already admitted stays
on that version after another publication. Follow-latest refuses to run a definition without a
publication. Unpublished saves never change the version it runs.

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
