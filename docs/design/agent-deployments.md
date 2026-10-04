---
title: Native agent deployments
status: draft
updated: 2026-10-03
---

# Native agent deployments

Tracking epic: [#53](https://github.com/factory-level/inferos/issues/53); roadmap: [#1](https://github.com/factory-level/inferos/issues/1). Decision records: [ADR 0003](../adr/0003-distinct-agent-capabilities.md), [ADR 0007](../adr/0007-agent-deployment-lifecycle.md) (proposed).

## Purpose

`AGENT_DEPLOYMENTS` enables persistent native CloudflareOS agent deployments: a reviewed persona, instruction and skill artifact bound to a scoped identity, capabilities and triggers. Always-on means available independently of a browser session, not an endless inference loop.

This is a draft target. The deployment lifecycle is not shipped, and the exact API, schema and provider support are reviewed during implementation.

## Requirements

Three things stay distinct:

| Term | Meaning |
| --- | --- |
| Definition | Immutable, versioned instructions and persona, pinned skills, and model and binding requirements. It holds no credentials. |
| Deployment | A selected definition in a customer environment with an authenticated agent identity, explicitly granted resource bindings, schedules, events or callers, limits and a lifecycle state. |
| Run | One invocation with its actual native execution identity, status, observations, approval waits and result. InferOps may correlate a run to work; it does not become a second native scheduler or executor. |

- Use native Gadgets and Blueprints, callable agents, scheduler callbacks and Gatekeepers. Reuse completed and available primitives, including the artifact contract in [agent authoring](agent-authoring.md), before rebuilding.
- Preserve completion-callback versus enqueue semantics and idempotent retry behavior.
- Persona and skills are behavior, not permissions. Persona or skill edits cannot change grants.
- Deploying an app or widget does not automatically deploy an agent.
- Setting the feature flag creates no agent, trigger, spend or privilege.

## Behavior

### Lifecycle

An authorized operator validates and plans a deployment, reviews the capabilities it requests, explicitly activates it, inspects it, pauses or drains it, updates it to a pinned revision, or retires it.

Artifact export and import rebinds destination resources. It never copies source credentials, live grants, runtime history or execution state.

Update, pause and retire preserve evidence. They do not silently transfer grants or execute old approvals under changed semantics.

### Isolation

Two deployments of one definition remain isolated in identity, resources and history.

### Disabled flag

With `AGENT_DEPLOYMENTS` off (see [feature capabilities](feature-capabilities.md)), new activation and invocation are denied through all authoritative surfaces. The design defines drain or cancel for existing runs, retained history, restricted diagnostic access, and re-enable behavior.

### Inventory

The customer's operational inventory and InferMind Master coverage include the deployment's role, scope and SOP obligations, not secret payloads.

## Proposed contract

Added 2026-10-03. The owner asked for contract PRs for #76, #77 and #78 in this wave. Everything in this section is a **proposal pending owner review** and is not implemented. The types are in `packages/workshop-shared/src/agent-deployment.ts`, which builds on the [artifact contract](agent-authoring.md#proposed-contract). The rationale is in [ADR 0007](../adr/0007-agent-deployment-lifecycle.md) (proposed).

### Definition, deployment, run

- **Definition** is a published `agent` artifact revision (`AgentDefinitionRevision`). Persona, instructions and call declarations are files (`persona.md`, `instructions.md`, `call.d.ts`), so the digest covers them. Skills are `ArtifactPin`s, and the model and binding requirements come from the manifest. It has no field for a grant, account, resource, trigger or limit, so editing persona or skills cannot change grants: no such field exists to change.
- **Deployment** (`AgentDeployment`) holds the exact definition pin and its own identity (a principal and a workspace created for it alone). It also holds grants, triggers, required limits (concurrency, runs per day, run time), a lifecycle state, transition history, and a decimal-string `revision` that every mutation names, as canvas and flow edits do. Grants reuse `BlueprintBindingAssignment`: references to an account and resource, or to a model ID, never credentials.
- **Run** (`AgentRun`) holds the definition pin copied at start, the trigger and occurrence key, the principal, the native chat that holds its observations, the IDs of actions it waits on, its status and a sanitised result summary. Observations and approvals stay in the deployment workspace's own chat and action log, and the run refers to them.

### Lifecycle

```text
planned --activate--> active --pause--> draining --drained--> paused --resume--> active
planned --update--> planned            paused --update--> paused
planned --retire--> retired            paused --retire--> retired
```

`AGENT_DEPLOYMENT_TRANSITIONS` is the authoritative table, and `agentDeploymentTransition()` refuses anything not in it.

- **Update** is allowed only in `planned` or `paused`. No run is in flight then, so no run straddles two definitions and no approval requested under one definition is applied under another. In-flight runs keep the pin they started with.
- **Grants on update** carry forward per binding name only when the new definition requires exactly the same kind of resource (`carryForwardGrants()`). Every other requirement must be granted explicitly in the reviewed update, and grants for dropped bindings are released. A persona, instruction or skill change therefore carries the same grants and adds none.
- **Pause drains.** Pausing stops new runs and disables triggers. In-flight runs finish, or the operator cancels them. The last one ending raises `drained`.
- **Cancel** applies to one run. Its pending actions are rejected, never applied, and the run ends `cancelled`.
- **Retire** is reached only from `planned` or `paused`. It deletes the deployment's triggers and releases its grants. Transition history, runs and the deployment workspace's chats and action log are retained.
- **Completion** is observed, never assumed. `queued` means `spawnCallable` durably enqueued the call. `succeeded` is set only when the run's persistent completion callback is called. A run with no completion within `maxRunMs` fails with `completion_timeout`.

### Triggers and the Scheduler

`AgentTrigger` is a `schedule`, `event` or `call`, each with an `id` unique within its deployment. Every delivery carries an occurrence key: the Scheduler's `runId`, the hook's delivery identity, or a key the caller supplies. `(deployment, trigger, occurrence)` is unique, so a retried or duplicate delivery maps to the run it already started instead of starting another.

The Scheduler conflicts with this. Registration creates a disabled hook that the user enables in Connections, and every registration creates a distinct hook. The proposal:

- **Reviewed activation is the user's enablement.** The operator reviews the plan, including each trigger, and activates. That one act registers each trigger and enables its hook, with the same person's authority the Connections toggle uses (`Overseer.enableHook`). The deployment's hooks are not offered for separate enablement in Connections. Pause and resume disable and enable the same hooks.
- **Registration is keyed by `(deployment, trigger id)`.** The deployment stores each registered schedule ID before enabling it, and a retried activation reuses a stored ID instead of registering again. This still leaves one gap: a crash between registration and storing the ID orphans a disabled hook. Closing it needs the Scheduler to accept a registration key and return the existing schedule ID for a repeated key. That is listed below as a decision.

### Flag off

- With `AGENT_DEPLOYMENTS` off, every surface refuses activation and invocation through a per-call guard of the same shape as the InferOps gatekeeper's `guarded` proxy (`custom-gatekeepers/gatekeeper-inferops/src/enablement.ts`). The guard runs on every call, so a capability or stale client obtained while the flag was on is refused from its next call. Trigger deliveries, call stubs and each run's next model turn go through it too.
- While the flag is off, only `AGENT_DEPLOYMENT_METHODS_ALLOWED_WHILE_DISABLED` pass the guard: the restricted diagnostic reads (`listDeployments`, `getDeployment`, `listRuns`, for operators only) and the actions that only reduce capability (`pauseDeployment`, `retireDeployment`, `cancelRun`).
- **Existing runs are cancelled, not drained.** Draining would need the invocations the flag forbids. A run whose next turn or delivery is refused ends `cancelled` with `flag_disabled`. A refused delivery is recorded as a `denied` run.
- No deployment changes state when the flag changes. Turning it off deletes nothing, and turning it on creates nothing.
- **Re-enabling restores nothing.** Denied deliveries are not replayed, cancelled runs stay cancelled, and released or revoked grants stay released. Deployments still `active` accept triggers again from their next delivery, which matches `INFEROPS_ENABLED`.
- Implementing the guard registers its file as `AGENT_DEPLOYMENTS`' `capabilitySources` entry in `scripts/consumer/runtime.ts`. Until then the entry stays `null` and the capability is reported unsupported.
- `HARNESS_HG_ENABLED` plays no part in any check here. Turning it off disables no native deployment.

### Isolation

Each deployment gets its own principal and its own workspace: separate storage, chats, gatekeeper bindings and action log. Two deployments of one definition therefore share nothing but the immutable definition revision. A grant made to one is a binding in that deployment's workspace only. Revoking it affects no other deployment. Each deployment's runs and history are listed only under it.

### Operator surface

`AgentDeploymentApiProposal` lists the operations: plan, create, activate, pause, resume, update, retire, list, get, list runs and cancel run. It would be minted by a new `AuthenticatedApi` method that returns null for anyone who is not a deployment operator, the same way `getAdminApi()` works. Who counts as an operator is a decision below. The capability is not wired into any RPC interface in this proposal.

## Non-Goals

- Replacing native execution with a new general workflow engine.
- Requiring Harness HG. `HARNESS_HG_ENABLED=false` does not disable native deployments.
- [External-agent platform integrations](agent-platform-integrations.md) and [local coding workflows](local-coding-workflows.md), which are separate capabilities with their own gates.
- An endless inference loop as the meaning of always-on.

## Acceptance and delivery

- One native deployment survives browser closure and can receive an authorized schedule, event or call using native execution.
- Two deployments of one definition remain isolated in identity, resources and history.
- Policy denial, revoked binding, retry or duplicate event, waiting approval, cancellation and observed actual completion are tested.
- Update, pause and retire behavior preserves evidence and does not silently transfer grants or execute old approvals under changed semantics.
- `HARNESS_HG_ENABLED=false` does not disable native deployments; local coding remains independently gated.
- Operational inventory and InferMind Master coverage include the deployment's role, scope and SOP obligations, not secret payloads.

## Open Questions

- Proposed (above, pending owner review): the API and schema for definitions, deployments and runs, and the drain, cancel and re-enable policy when the flag is off.
- Who is a deployment operator: deployment admins only, or a separately configured role. It must not be ordinary workspace build access.
- How a deployment's principal is authenticated to InferOps and other gatekeepers. Today a binding acts with the authority of the person whose connected account it references, which is the spawner creator's authority. Whether a deployment needs its own service identity is open, including in relation to [ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md).
- Whether a deployment workspace is a new workspace (proposed) or a facet of the operator's workspace.
- Event triggers: hook deliveries carry no delivery identity today, so duplicate events cannot yet be told apart (ai-trader #82 tracks the same gap). Which gatekeepers deliver events is also open.
- Run cancellation needs a native way to stop an agent chat's in-progress turn. Which existing mechanism serves is unconfirmed.
- Whether re-enabling the flag should instead require each active deployment to be re-activated.

## Related

- [Current architecture](../architecture/agent-deployments.md)
- [Agent authoring](agent-authoring.md)
- [InferOps gatekeeper](inferops-gatekeeper.md)
- [Feature capabilities](feature-capabilities.md)
- [Agent platform integrations](agent-platform-integrations.md)
- [Local coding workflows](local-coding-workflows.md)
- [Pillars](platform-pillars.md)
