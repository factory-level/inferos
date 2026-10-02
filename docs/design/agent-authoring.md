---
title: Reusable native agent authoring
status: draft
updated: 2026-10-01
---

# Reusable native agent authoring

Tracking epic: [#4](https://github.com/factory-level/inferos/issues/4); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Bring AI Trader’s reusable authoring discipline into InferOS while keeping execution on native Gadgets, bindings, callbacks and schedules.

## Requirements

- Expose common create/read/edit/validate/diff/publish operations to UI and agents through native contracts.
- Represent instructions, immutable skill references, model requirements and binding requirements without embedding credentials.
- Qualify a revision with reproducible proof evidence bound to the exact artifact and dependency revisions.
- Export/import portable native artifacts and explicitly rebind destination capabilities.
- Keep deployment configuration authority distinct from ordinary user/workspace authoring.

## Behavior

An author edits a draft, validates its native contract, inspects the diff, runs deterministic fixture proofs and publishes a named immutable revision. Changes to instructions, skills, model constraints or bindings invalidate the prior qualification. Import verifies the artifact, presents required bindings and obtains destination authority; it never imports source credentials or live execution state. Native callable agents and scheduler callbacks supply execution. Proofs cover enqueue-versus-completion semantics and idempotent retries before they are advertised as reliable workflow building blocks.

## Non-Goals

No trading strategy, brokerage, market-data or financial-policy code in the reusable layer. No separate general workflow engine or replacement agent runtime.

## Acceptance and delivery

### Extract reusable AI Trader authoring contracts onto native InferOS primitives

Tracking issue: [#15](https://github.com/factory-level/inferos/issues/15) (`author-contract`).

- Inventory actual AI Trader registry code separately from issues #34/#42/#43/#80.
- Map create/read/edit/validate/diff to existing Gadget/Blueprint APIs and define only missing operations.
- Prove native deterministic Gadget, callable completion and scheduler paths with fixtures.
- Document user versus deployer authority and exclude trading domain/runtime dependencies.

### Add skill revision pinning and artifact qualification proofs

Tracking issue: [#16](https://github.com/factory-level/inferos/issues/16) (`author-proofs`).

- Pin skill dependencies and model/binding requirements in a validated artifact contract.
- Bind qualification to exact artifact/dependency digests and invalidate on any relevant change.
- Store sanitized proof results and distinguish deterministic fixtures from live model outcomes.
- Test stale qualification, altered dependency, incompatible versions and secret exclusion.

### Publish, import and rebind portable native agent artifacts

Tracking issue: [#17](https://github.com/factory-level/inferos/issues/17) (`author-publish`).

- Reuse native Blueprint serialization where possible; document any versioned extension.
- Import into a second clean workspace and explicitly bind destination models/resources.
- Reject tampered or incompatible artifacts; never transfer credentials, history or runtime data implicitly.
- Prove export/import round trip, revision selection and rollback to a known artifact.

## Open Questions

- Choose the smallest native authoring API after inventorying existing Gadget/Blueprint operations.
- Define digest canonicalization and compatibility policy before labeling artifacts portable or qualified.

## Related

- [Current architecture](../architecture/agent-authoring.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)
