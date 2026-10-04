---
title: Publication destinations for the widget and app flags
status: proposed
date: 2026-10-03
---

# 0008. Publication destinations for the widget and app flags

## Context

[ADR 0001](0001-customer-capability-flag-vocabulary.md) names `PUBLISH_CLOUDFLAREOS_WIDGET` and `PUBLISH_CLOUDFLAREOS_APP` and says publication destinations are separate configuration fields, but it does not say what the destinations are. [#68](https://github.com/factory-level/inferos/issues/68) requires that, with a flag off, publication is denied at the server, CLI, tools and UI; that a publication records what, where and to whom and can be withdrawn; and that nothing is published by a deploy, profile or flag change alone. It leaves the destinations open.

The upstream Workshop already publishes. A blueprint is a versioned snapshot of a gadget's code. Anyone holding its 128-bit id can read its metadata and download its `.gadget` archive through `PublicApi.getBlueprint` and `downloadBlueprint` without signing in, and an admin can feature it to every user of the deployment. Publish to Operate is built on the same blueprints but stays inside the deployment ([operate mode](../design/operate-mode.md)). So the flags cannot be satisfied by adding new destinations alone: with both flags off, a blueprint link would still send code out of the deployment.

## Decision

Proposed, pending the owner's decision:

- An artifact is one pinned blueprint version of a `widget`-kind workspace (widget flag) or an `app`-kind workspace (app flag), identified by blueprint id, version and a digest of the snapshot. It never carries chat history, storage, credentials, bindings or InferOps data.
- Publication records decide reachability. A blueprint reaches beyond its owner and its Operate installs only while it has an active, admin-approved publication record for a destination. Without one, `PublicApi` reads refuse it and it cannot be featured.
- The destinations are `deployment` (the featured listing, for this deployment's signed-in users), `export` (a `.gadget` archive for import into another deployment) and `link` (today's unauthenticated blueprint link). `deployment` and `export` are offered first. `link` is defined but deferred. Public hosting of a live app is rejected, and an external marketplace is deferred.
- A record holds the artifact, destination, audience, requester, approver and time. It is append-only and withdrawn by adding the withdrawal. Withdrawing stops new reach but cannot uninstall copies or recall downloaded archives, and says so.
- With a flag off, every surface refuses: server, CLI, agent tools and UI. Turning a flag off suspends reach without changing records, and turning it on again resumes nothing without fresh confirmation. A flag, profile, deploy, migration or intake never publishes.

The full proposal and the decision checklist are in [feature capabilities: publication destinations](../design/feature-capabilities.md#publication-destinations-proposed-pending-owner-decision).

## Consequences

- With both flags off, a deployment publishes nothing, which matches the private-shell MVP.
- `PublicApi` and featuring change behavior in the kernel. That diverges from `cloudflare/cloudflare-os`, so it has to meet the kernel review bar and be kept in step through upstream merges.
- Existing blueprint links break unless a migration grandfathers them as `link` records.
- The blueprint must record its workspace kind before an artifact can be mapped to a flag. That is an existing gap in Publish to Operate.
- Each flag needs a backend variable on the dev server and later the release manifest, like `CODING_WORKBENCH_ENABLED`. Until then cloud deployments stay off.

## Alternatives Considered

- Gate only new destinations and leave blueprint links, downloads and featuring as they are upstream: no kernel change, but a flag-off deployment still publishes code by link, which contradicts #68's acceptance unless a blueprint link is ruled to be data sharing rather than publication.
- Gate blueprint creation for each kind: it breaks Publish to Operate and output formats, which depend on blueprints.
- Public hosting of live apps: it runs against someone's bindings and data, so it would share business data.

## Related

- Design: [`../design/feature-capabilities.md`](../design/feature-capabilities.md)
- Design: [`../design/operate-mode.md`](../design/operate-mode.md)
- [Blueprints](../blueprints.md), [Sharing](../sharing.md)
- [ADR 0001](0001-customer-capability-flag-vocabulary.md)
