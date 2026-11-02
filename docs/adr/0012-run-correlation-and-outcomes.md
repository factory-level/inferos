---
title: Workflow runs share one correlation record and seven observable outcomes
status: proposed
date: 2026-11-02
---

# 0012. Workflow runs share one correlation record and seven observable outcomes

## Context

User and system work has to continue without an open browser and report what actually happened. The design keeps definition, trigger, run, delegate and result distinct ([workflows](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workflows.md)). [ADR 0007](0007-agent-deployment-lifecycle.md), accepted, gives deployments their lifecycle and says only a completion callback sets `succeeded`. InferOps' [ADR 0011](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0011-workflow-authority-envelopes.md) and this repository's [ADR 0011](0011-system-workflow-authority.md), both proposed, hold each run's authority envelope, and leave run states, waiting, pinned revisions and in-flight runs on retirement to this record.

Read at inferos `fd4f46c7087cfab5f5240396c6dc9a7612ae0b25`, inferops `15aa152b967ae4a0787511f848e4971d6e82a750` and `trycompai/crm` `c9473b82e3b4bfd5d0598bbdf7c1f36f3d2d68f0`, the last as data with nothing run. Nothing here is built, and this record changes no code.

What exists bears on it:

- **A queued call says nothing about the work.** `spawnCallable` resolves once the call is durably queued, and there is no built-in notification when the agent is done (`packages/workshop-backend/src/agent-spawner-binding.d.ts:22,28`).
- **Scheduler delivery can repeat.** `runId` is stable across retries of one occurrence, and delivery may happen more than once (`packages/gatekeeper-scheduler/README.md:88,93-94`).
- **The accepted run contract has no way to say "we don't know".** `AgentRunStatus` has seven values with no uncertain one (`packages/workshop-shared/src/agent-deployment.ts:186-187`), and a run with no observed completion fails with `completion_timeout` (`:137-138,199`), though it may have done its work.
- **"Unknown" already exists one level down, and in InferOps.** An action's last attempt is `notApplied` or `unknown`, and `unknown` is never presented as safely undone (`packages/workshop-shared/src/api.ts:2432-2447`). InferOps' coding runs have an `unknown` status (inferops `migration/src/migrations/1789445633_create_project_runs_and_repos.ts:40`).
- **A navigation flow already exists and isn't work.** `startFlow` copies a list of screens into the Operate page (`docs/architecture/operate-mode.md:387`), and an agent's `startFlow` is refused (`packages/workshop-backend/src/user.ts:1188`).

## Decision

Each rule gives what exists today: **built**, **partial** or **missing**. Items marked **proposed default** stay open after acceptance unless the owner says otherwise.

### 1. A navigation flow isn't a run

| # | Rule | Code today |
| --- | --- | --- |
| F1 | **A navigation flow moves a person between screens.** It has no run id, outcome, delegate or result, and leaving it undoes nothing. **A run is business execution.** A control on a screen may start a run, and that's a separate act with its own record | **Built** for flows (`operate-mode.md:387`). Runs are **missing** |
| F2 | **Denied:** counting a flow's completion as a run's outcome, or inferring a business result from which step a page shows | **Built** by absence |

### 2. The correlation record

One record per run, written when the run is admitted, stored with the deployment's workspace or, for a custom request, the person's. Observations and approvals stay in the native chat and action log, as the accepted contract says, and the run refers to them. **InferOps entities are referenced, never copied.**

| Field | Meaning | Code today |
| --- | --- | --- |
| `runId` | Server-minted, opaque, never reused | **Missing.** `AgentRun.id` is declared (`agent-deployment.ts:209`) and not stored |
| `definition` | The exact revision, pinned at admission. Null for a custom request, as ADR 0011's envelope says | **Partial.** Declared, unstored. Artifact pins exist |
| `occurrence` | `(trigger id, occurrence key)`, unique within the deployment, so a repeated delivery maps to the existing run. Schedule: the Scheduler's `runId`. Control: the server's id for that press. Custom request: a client request id, whose replay must match the original | **Partial.** Declared (`agent-deployment.ts:217`). **Event triggers can't have one yet:** hooks carry no delivery identity (ADR 0007) |
| `envelope` | Requester, execution principal, context and bound, as ADR 0011 defines them. **This record stores it and doesn't redefine it** | **Missing** |
| `delegates` | `(delegateId, parentDelegateId or null, chatId, outcome)`. A delegate's envelope is its parent's or narrower (ADR 0011) | **Missing** |
| `actionIds` | The action-log entries this run created, including delegates' | **Partial.** `waitingOn` holds only waiting ones (`agent-deployment.ts:223`) |
| `externalRefs` | References the run produced: `inferops://` targets, an InferOps coding run's id. References only | **Missing** |
| `resultDestination` | Copied at admission from the definition or assignment. **Denied:** from a payload or prompt (ADR 0011). Run history is always one destination | **Missing** |
| `delivery` | Per destination: `pending`, `delivered` or `undelivered`. **Separate from the outcome:** a run that succeeded and couldn't reach its canvas still succeeded, and says so | **Missing** |
| `outcome`, `events`, times | Below. Events are append-only, with a sequence number | **Partial.** Status is declared; events aren't |

InferOps stays authoritative. A `runId` sent to it is a correlation claim and authorizes nothing (ADR 0011).

### 3. Outcomes

**The screen shows the outcome's own word.** No state is shown as another, and queued is never shown as done.

| Outcome | What it means, observably | Set by | Final? |
| --- | --- | --- | --- |
| `queued` | Admitted and durably queued. **Nothing has been shown to have started, and this isn't success** | Admission | No |
| `running` | The runtime reported the first turn | The runtime | No |
| `waiting` | Started and can't continue without something named: `approval` (action ids), `reconnect` (the person's credential, per ADR 0011) or `decision`. The reason is always shown | The runtime or gatekeeper | No |
| `succeeded` | The run's completion callback reported success, **and** none of its actions is pending or unknown, **and** every delegate has ended in `succeeded`. A person sees the summary and the applied actions | The callback, checked by the server | Yes |
| `failed` | **Known** to have stopped without finishing, with nothing unknown. **Partial effects are possible, and are listed:** failed doesn't mean nothing happened | The server | Yes |
| `cancelled` | A cancel was delivered and the run stopped, with nothing unknown. Pending actions were rejected. A cancel only requested leaves the run in its state, marked "cancel requested" | The server | Yes |
| `uncertain` | **Work may or may not have happened, and nothing available can tell.** See section 4 | The server | Until reconciled |

`denied`, in the accepted contract, stays what it is: a delivery refused before anything started, recorded, and not an outcome of work.

**Allowed moves.** `queued` to `running`, `cancelled`, `failed` or `uncertain`. `running` and `waiting` to each other, and to any final outcome or `uncertain`. `uncertain` to `succeeded`, `failed` or `cancelled`, only through section 4. **Denied:** leaving a final outcome; any other move; setting an outcome from a client, prompt or agent argument.

**Delegates.** Each has an outcome with these meanings, and a parent can't succeed past an unfinished or uncertain one. **Proposed default D1: within a run, a delegate is `spawnCallable` with a completion callback.** `spawn()` has no way to report (`agent-spawner-binding.d.ts:12`), so it's refused inside a run.

**A completion callback** is a persistent stub bound to one run and delegate. A second call is a no-op. An agent saying "done" in chat sets nothing. **Its report is a claim, not proof,** which is why `succeeded` also checks the action log, and why a person sees the actions and not only the summary. Effects made outside gatekeeper actions aren't visible to this check.

| Today's code for this section | |
| --- | --- |
| **Partial** | Six of the seven values are declared and unstored. `waitingApproval` becomes `waiting` with a reason |
| **Missing** | `uncertain`, cancel-requested, delegate outcomes, a "first turn" signal, and the callback binding. Nothing sets any of them |

### 4. Uncertain

**When a run becomes uncertain:**

- no completion by `maxRunMs`, and the run has any action applied, unknown or sent, or any delegate not known to have ended. **This changes the accepted contract's `completion_timeout`.** A timed-out run with nothing sent and every delegate stopped is still `failed`;
- an action attempt's outcome is `unknown`;
- a delegate is uncertain;
- the runtime was lost after anything may have been sent;
- a cancel or flag-off stopped a run while an action's result was unknown.

**What a person sees:** "We can't tell whether this finished." Then what's known: each action as applied, rejected, pending or unknown, with a link to its record; the last thing heard and when; and what they can do. **It's never shown green, never shown as failed, and never counted as either.** It stays visible until someone resolves it, including after a reconnect.

**What may happen, in order:**

| # | Rule | Safe because |
| --- | --- | --- |
| R1 | **Nothing restarts by itself.** No automatic rerun, whatever the trigger. The occurrence stays bound to this run, so a repeated delivery maps here and starts nothing | The occurrence key |
| R2 | **Reconcile first.** For each unknown action, read the target and compare, using what its connection contract says about it. **A reconcile only reads.** A clean answer for every action and delegate lets the server settle the outcome, recording why | Reads have no effect |
| R3 | **Resending one action is allowed only if its contract says so:** same idempotency key, `retryable` on its last attempt, and a provider replay verified for that kind. **Reconcile-only kinds are never resent** | `api.ts:2441-2447`; `connection.json` declares each kind. Coding dispatch and cancel are reconcile-only (`docs/architecture/inferops-gatekeeper.md:311-316`) |
| R4 | **A person may resolve it,** to `succeeded`, `failed` or `cancelled`, with a note. The record keeps `uncertain`, who resolved it, when and why. **Proposed default D2:** the requester for a custom request, a deployment operator for system work. A label or flag grants nothing | The person is asserting what they checked, and it's attributed |
| R5 | **"Run again" is a new run,** only after R4, by a person allowed to invoke it: a new `runId`, a new occurrence, the same pinned revision, with `retryOf` naming the old run. The confirmation lists what the old run applied. **Denied:** reusing the old occurrence, or running again from `uncertain` without resolving it | It's visibly a second run, by a person who has seen the first one's effects |
| R6 | **A late callback** on an uncertain run is evidence: it can settle it under `succeeded`'s rule. After a person resolved it, it's recorded and changes nothing | Final stays final |

**`failed` isn't automatically safe to retry either,** because of partial effects. **Proposed default D3: automatic retry only before anything is sent.** After that, R5 applies.

### 5. Waiting, pins and retirement

| # | Rule | Code today |
| --- | --- | --- |
| L1 | **A run's definition is pinned at admission** and doesn't change. An update needs a drained deployment, so no run straddles two (ADR 0007). A trigger keeps its pinned revision until someone updates it | **Partial.** The table exists (`agent-deployment.ts`, `AGENT_DEPLOYMENT_TRANSITIONS`). Unstored |
| L2 | **An expiring or edited definition doesn't touch a run already started** (workflows design). The pinned revision stays readable while the run's history is kept | **Missing** |
| L3 | **Proposed default D4: `maxRunMs` counts only time not waiting. A separate required `maxWaitMs` limits waiting.** At the limit, pending actions are rejected and the run ends `cancelled`, with reason `wait_expired`. A person's approval can take days, and a run can't wait forever | **Missing.** The limits have no such field (`agent-deployment.ts:137-138`) |
| L4 | **Pause stops new runs, and in-flight ones finish.** `draining` becomes `paused` when nothing is `queued`, `running` or `waiting`. **Uncertain isn't in flight,** so it doesn't hold a drain | **Partial,** as a table |
| L5 | **Retire stays allowed only from `planned` and `paused`, and proposed default D5 adds: refused while a run is unresolved.** History is kept, and grants are released on retiring, so reconciling afterwards could be impossible | **Missing** |
| L6 | **Flag off:** ADR 0007 stands. In-flight runs are cancelled at their next guarded step, and section 3's rule applies: unknown makes it `uncertain`, not `cancelled`. `cancelRun` stays allowed | **Partial,** as a contract |
| L7 | **A revoked grant or disabled principal** refuses the next step (ADR 0011). The run ends `failed` with `grant_revoked`, or `uncertain` if anything is unknown | **Missing** |
| L8 | **Proposed default D6: an uncertain run doesn't block later occurrences of a schedule,** and it shows as needing attention. Stopping every later run on one unknown would stop company work | **Missing** |

### 6. Words across the repositories

| Here | InferOps coding run | Action attempt | CRM upstream (pattern only) |
| --- | --- | --- | --- |
| `queued`, `running` | Same | | Same |
| `waiting` | None | `pending` | `WAITING_FOR_APPROVAL` |
| `succeeded`, `failed`, `cancelled` | Same | `approved`, `failed`, `rejected` | Same |
| `uncertain` | `unknown` | `unknown` | None |

**The patterns taken from the CRM** (`apps/api/src/agent/agent-runs.service.ts`): an idempotency key with a lock and a check that a replay matches (`:148-224`), retry on the same version (`:241-316`), append-only events with a sequence, and requested versus delivered cancel (schema, `AgentRun`). No CRM service runs (inferops ADR 0010, proposed). **InferOps coding runs and internal jobs aren't workflow runs.** A coding run is referenced in `externalRefs`, and InferOps jobs carry only audit identity (inferops `lib/ts/jobs/backend/context.ts`).

### Denied, together

- Treating queue acknowledgment, a resolved `spawnCallable`, a delivery attempt or a chat message as success.
- Showing `uncertain` as success or failure, or hiding it after a time.
- Any automatic rerun of work that may have had effects.
- Choosing a destination, principal or outcome from a run's content.
- Copying InferOps entities into a run record.

### Proposed defaults, not decided

1. **D1:** delegates in a run report through a callback; `spawn()` is refused there. The cost: existing one-way spawning can't be used inside a run.
2. **D2:** the requester or a deployment operator resolves an uncertain run.
3. **D3:** automatic retry only before anything is sent.
4. **D4:** waiting has its own limit, and hitting it cancels.
5. **D5:** retiring is refused while a run is unresolved. The cost: an unresolved run has to be resolved first, which D2's person can do by hand.
6. **D6:** an uncertain run doesn't block later scheduled occurrences. The cost: a definition that isn't safe to overlap could repeat an effect. A definition that needs otherwise needs a stated rule, not built here.

**Dependencies on undecided records:** InferOps ADR 0011 and this repository's ADR 0011 for the envelope, including its D4 (agents propose, people confirm), D6 (waiting on a credential) and pinned triggers. Inferops ADR 0008's G8 means a background run reaches only its own workspace's records. Inferops ADR 0010's P1 and D4 for the CRM patterns. **ADR 0007 is accepted, and this record proposes three changes to its contract:** an `uncertain` status, `completion_timeout` becoming uncertain when anything may have been sent, and `maxWaitMs`.

## Consequences

**Criteria:**

1. **Contracts name definition revision, trigger occurrence, requester, executor, run and delegate ids, and result destination: stated (section 2). None is stored,** and event triggers can't yet have an occurrence key.
2. **Each outcome has an observable meaning, and queue acknowledgment isn't success: stated (sections 3 and 4). None is observable today,** because no run can exist: `AGENT_DEPLOYMENTS` stays unsupported.

**Evidence:** code reading only. Nothing was run, and no local, CI or deployed evidence applies. R2 and R3 rest on what `connection.json` and the gatekeeper's architecture say, and those cover the InferOps connection, not other providers.

**Gaps:**

| Issue | Takes from this record |
| --- | --- |
| FAC-110 | Store the record at admission with its pin and envelope; run it through `spawnCallable`; a "first turn" signal. The contract change in `agent-deployment.ts` |
| FAC-113 | Occurrence keys per trigger. Event triggers need a hook delivery identity first |
| FAC-114 | Callback binding, destinations and `delivery`, `uncertain` staying visible after reconnect, R6 |
| FAC-117 | Cancel requested versus delivered, R1 to R5, L3 to L8 |
| FAC-118 | `waiting` for a decision, persisted and resumed |
| FAC-102, FAC-104 | The envelope and its live checks. A `runId` as a claim in InferOps' audit |
| FAC-120 | Must keep F1, and ADR 0011's D4, whose reading it depends on |
| FAC-121 | Showing each outcome in its own word in Recent |
| FAC-125 | How long the record, pins and results are kept |

- The screen for an uncertain run has no issue naming it, beyond FAC-114's "visibly uncertain".
- This adds work a simple queue-and-callback wouldn't need, because every action has to stay attached to its run.

## Alternatives Considered

- **Keep six statuses and let `failed` cover timeouts:** a person retries something that already happened. This is the failure the record exists to prevent.
- **Automatic retry with an idempotency key for the whole run:** a run's steps are chosen by a model, so a second run isn't the same calls and no key covers it. Keys hold per action.
- **Treat a completion callback alone as success:** an agent's report would be the only evidence, while the action log already knows better.
- **Keep runs in InferOps:** InferOS holds the runtime, chat and action log that say what happened, and InferOps would hold copies of those. InferOps needs no record of its own for this: its coding runs keep their own status, and its authority doesn't change.
- **A separate workflow engine:** the design rules out replacing the native runtime, and FAC-110 reuses the Scheduler and spawner.
- **Block a schedule's later runs on any uncertain run:** safer for one definition, and it stops a company's work on one lost callback (D6).

## Related

- Design: [`workflows.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workflows.md), [`agent-operations.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/agent-operations.md), [`agent-deployments.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/agent-deployments.md)
- Architecture: [`../architecture/agent-deployments.md`](../architecture/agent-deployments.md)
- Decisions: [ADR 0004](0004-inferops-gatekeeper-user-authority.md), [ADR 0007](0007-agent-deployment-lifecycle.md), [ADR 0011](0011-system-workflow-authority.md)
