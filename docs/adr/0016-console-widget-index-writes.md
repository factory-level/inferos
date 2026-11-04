---
title: A builder's own console publication lists its widgets in InferOps directly, not through the approval queue
status: proposed
date: 2026-11-04
---

# 0016. A builder's own console publication lists its widgets in InferOps directly, not through the approval queue

## Context

FAC-11 slice 2 has InferOS list each widget a published console registers in InferOps' scoped widget index (`widget.publish`), and withdraw versions no console lists any more (`widget.withdraw`). It does this through the InferOps gatekeeper, under the authority of the person publishing (inferops ADR 0013 W10).

Until now every write InferOS makes to InferOps has been an approved action:
- a gadget or agent session stages it (`submitAction`);
- a person approves it;
- the gatekeeper applies it (`applyAction`).

Nothing is auto-approvable (`write-gatekeeper`, responsibility 4; [ADR 0004](0004-inferops-gatekeeper-user-authority.md)). The kernel's only synchronous call to InferOps was read-only: `publishConsole` asks whether the person holds `configuration:publish` (`holdsSharedConfiguration`).

A console publication is not something an agent proposes. It is a builder's own explicit action, and the builder is the person who would approve it. Queuing the index write would ask them to approve their own click, and InferOps decides against their own grant either way.

## Decision

Proposed by orch.advisor on 2026-11-04, for a person to accept.

- **Direct, not queued.** The kernel writes the widget index directly, as the publishing person, through their own connected account of the vendor `SHARED_CONFIGURATION_GATEKEEPER` names.
  - It uses new optional `GatekeeperUser` methods: `widgetIndexWorkspaces`, `registerWidget` and `withdrawWidget` (`InferOpsAccount`).
  - It never stages an action.
- **Reachable from two places only:** the build-role `publishConsole` and `deleteConsole`.
  - Gadgets, facets and the agent tool surface get no new RPC.
  - The use role and the operate session are refused `getConsoleWidgetIndex`, `listConsoleWidgetIndexWorkspaces` and `setConsoleWidgetIndexTarget`.
- **Own token only.**
  - The stopgap bearer, a demo account or a sign-in-only account writes nothing ("not listed: sign in as yourself").
  - An account that isn't the person's own, live, of that vendor is never sent a write.
- **InferOps decides; InferOS reports.**
  - What InferOps answered is recorded beside the console (`ConsoleWidgetIndexReport`): `applied`, `proposed`, `refused` or `unavailable`.
  - Only `applied` counts as listed. Nothing else is shown as done, and it is retried on the next publication.
  - The console's own publication never waits on the index: operators get it whatever InferOps answers.
- **An explicit target workspace.**
  - The one InferOps workspace where the person holds `configuration:publish`, or the one the builder chose for the console. With several, nothing is written until one is chosen.
  - It is recorded on the console and never moves on its own. If it stops qualifying, the publication says so.
- **Company visibility.** A definition is a pointer to the Blueprint version (`inferos.blueprint`, id and version) plus the console entry's label and the blueprint's description, with no records. Retrieval still filters live data by the reader's own permission.
- **Idempotent and reference-counted.**
  - A version is written once per publication revision. InferOps' upsert keeps one definition however often it is written.
  - A version is withdrawn only when no published console of the InferOS workspace lists it.
  - A refused or failed withdrawal is kept as owed and retried on the next publication or delete.

## Consequences

- **The approval queue still covers every agent and gadget write.** This exception is narrow: two capabilities, a person's own configuration, `configuration:publish` holders only, which InferOps enforces.
- **Between a publication and a successful write,** the console works for its operators but isn't found by retrieval. The builder sees why.
- **The divergence is recorded** in `inferops-gatekeeper.md` and `operate-mode.md`. A companion `docs/human` proposal asks for the gatekeeper design to name this exception.

## Alternatives considered

- **Queue the write for approval.** Rejected: the person approving is the person publishing.
- **Pick the first qualifying workspace in membership order.** Rejected: membership order isn't a contract, and a later join would silently move the listing.
- **`workspace` visibility.** Rejected: nothing registered from an operations workspace would be found by retrieval, which runs in InferMind workspaces.
