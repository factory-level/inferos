---
title: Agent deployment lifecycle and flag-off semantics
status: proposed
date: 2026-10-03
---

# 0007. Agent deployment lifecycle and flag-off semantics

## Context

[#76](https://github.com/factory-level/inferos/issues/76), [#77](https://github.com/factory-level/inferos/issues/77) and [#78](https://github.com/factory-level/inferos/issues/78) need a contract reviewed before implementation. It has to cover definition, deployment and run, a lifecycle that preserves evidence, `AGENT_DEPLOYMENTS` enforcement on every surface, and browser-independent triggers that keep enqueue-versus-completion semantics and survive retries.

Four native facts constrain it:

- `spawnCallable` resolves once a call is durably queued, and completion is visible only through a persistent callback the caller supplies.
- Scheduler registration creates a disabled hook that the user enables in Connections, and every registration creates a distinct hook. Retries reuse the same `runId`.
- Hooks carry no delivery identity.
- The InferOps gatekeeper already enforces its flags with a per-call guard (`guarded` in `custom-gatekeepers/gatekeeper-inferops/src/enablement.ts`), so a capability held across a flag change is refused from its next call.

## Decision

1. **A definition is a published `agent` artifact revision** ([ADR 0006](0006-agent-artifact-revisions.md)). It has no field for grants, triggers or limits, so a behaviour edit cannot change authority.
2. **Lifecycle:** `planned → active → draining → paused → active … → retired`, as the table `AGENT_DEPLOYMENT_TRANSITIONS`. Update is allowed only in `planned` and `paused`. Retire is allowed only from `planned` and `paused`. Every operator transition names an expected revision.
3. **Grants carry into an update only for binding names whose requirement is unchanged.** Everything else is granted explicitly in the reviewed update.
4. **Reviewed activation is the user's enablement** of the deployment's Scheduler hooks. Registration is keyed by `(deployment, trigger id)`, and the deployment stores the schedule ID before enabling it.
5. **Every delivery has an occurrence key.** `(deployment, trigger, occurrence)` is unique, so duplicates map to the existing run. `succeeded` is set only by the run's completion callback.
6. **Flag off:** a per-call guard refuses activation and invocation everywhere. It passes only diagnostic reads and the capability-reducing actions (pause, retire, cancel run). In-flight runs are cancelled at their next guarded step, not drained. No state changes. Re-enabling replays and restores nothing; active deployments accept new deliveries again. The guard's file becomes `AGENT_DEPLOYMENTS`' `capabilitySources` entry. `HARNESS_HG_ENABLED` is not consulted.
7. **Isolation:** each deployment has its own principal and its own workspace.

## Consequences

- No run straddles two definitions, and no approval crosses an update, because update needs a drained deployment.
- Pausing is slower than an in-place swap. An urgent stop is a pause plus cancelling runs.
- Flag-off loses in-flight work rather than finishing it. That is the cost of refusing invocation literally.
- Closing the crash window between registration and storing the schedule ID needs a Scheduler change (an optional registration key), which is outside the kernel.
- Event triggers cannot be deduplicated until hooks carry a delivery identity.
- A workspace per deployment costs one more Durable Object per deployment, and gives identity, storage, chat history and binding isolation for free.

## Alternatives Considered

- **Update in place while active:** new runs pick up the new pin immediately, but in-flight runs and their pending approvals would cross definitions.
- **Drain on flag off:** finishing in-flight runs needs model turns and binding calls, which the flag forbids.
- **Mark every deployment paused on flag off:** needs a sweep at the moment the flag changes. Flags are environment configuration with no change event.
- **Require the user to enable each hook in Connections after activation:** two separate approvals of the same thing, and the deployment would sit `active` with nothing able to fire.
- **Deduplicate by asking the Scheduler `list()`:** it lists only enabled schedules, so it cannot detect a duplicate disabled registration.
- **One shared workspace for all deployments of a definition:** two deployments' grants, storage and history would mix.

## Related

- Design: [`../design/agent-deployments.md`](../design/agent-deployments.md)
- Architecture: [`../architecture/agent-deployments.md`](../architecture/agent-deployments.md)
- Decisions: [ADR 0001](0001-customer-capability-flag-vocabulary.md), [ADR 0003](0003-distinct-agent-capabilities.md), [ADR 0006](0006-agent-artifact-revisions.md)
