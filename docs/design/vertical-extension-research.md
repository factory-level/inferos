---
title: Vertical extension research and decision matrix
status: draft
updated: 2026-10-01
---

# Vertical extension research and decision matrix

Tracking epic: [#8](https://github.com/factory-level/inferos/issues/8); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Make extension choices from documented native capabilities and concrete workflow requirements instead of assuming every vertical requires a kernel fork.

## Requirements

- Maintain dated primary sources and pinned code evidence; distinguish current implementation, upstream plans and proposed extensions.
- Cover at least three workflows each for field operations, IT, DevOps, industrial, medical, social/content, agency/client delivery, knowledge/research, AI trading, sales/CRM, support and ecommerce.
- Classify each workflow using configuration, skills, native Gadget/Blueprint, custom gatekeeper, external service and exceptional kernel change.
- Record authority, transaction ownership, data sensitivity, failure behavior and an executable proof needed for each recommendation.
- Research the first five verticals in greater depth; separate medical administration from clinical decisions and industrial monitoring from control.

## Behavior

Start from the capability inventory and score the workflow against authority, runtime, data, interaction, latency/connectivity and operational requirements. Choose the smallest composition that meets the requirements. A custom connector or external service is normal when a provider owns the data or protocol. A kernel change requires a missing general capability, failed composition proof and a separate small review. Each matrix row links evidence and states confidence or unresolved provider-specific questions. Recipes use synthetic data and publish verification results rather than declaring compliance or suitability.

## Non-Goals

No promise that a matrix entry is a certified medical/industrial solution; no implementation of all vertical adapters in this planning release.

## Acceptance and delivery

### Maintain a source-backed CloudflareOS extension capability wiki

Tracking issue: [#30](https://github.com/factory-level/inferos/issues/30) (`research-capabilities`).

- Document configuration, skills, Gadgets, Blueprints, gatekeepers, MCP, scheduling, local/cloud runtime and kernel boundaries.
- Pin repository evidence and date official documentation; identify stale or conflicting sources.
- Separate actual primitives from assumptions and deployment-dependent constraints.
- Verify links and tie open capability gaps to implementation issues.

### Validate the 12-vertical, 36-workflow customization decision matrix

Tracking issue: [#31](https://github.com/factory-level/inferos/issues/31) (`research-matrix`).

- Cover the agreed 12 areas with at least three concrete workflows each.
- For every workflow document native primitive/custom code/external service decision, authority, data owner, gap and proof.
- Deepen fieldops, IT, DevOps, industrial and medical with primary-source constraints.
- Keep medical clinical and industrial control workloads distinct; record provider/jurisdiction questions without certifying suitability.

### Turn priority vertical decisions into reproducible extension recipes

Tracking issue: [#32](https://github.com/factory-level/inferos/issues/32) (`research-recipes`).

- Publish wrapper examples for field dispatch, IT triage and DevOps incident/release workflows first.
- Use synthetic industrial monitoring and medical administration fixtures before any real sensitive data.
- Run native primitives before proposing kernel additions; document failed composition proofs.
- Record setup/settings, permission tests, retry/conflict behavior and upgrade evidence for each recipe.

## Open Questions

- Which actual providers and deployment jurisdictions apply to each first customer?
- Which offline, latency, retention and audit requirements are mandatory rather than desirable for each workflow?

## Related

- [Current architecture](../architecture/vertical-extension-research.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)
