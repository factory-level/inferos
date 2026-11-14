---
title: Delegates a person's Dot launches
status: proposed
date: 2026-11-12
---

# 0020. Delegates a person's Dot launches

## Context

The [Ask Dot](https://github.com/factory-level/inferops/blob/develop/docs/human/journeys/operator/dot/ask-dot.md) journey lets a person's Dot launch a delegate, under that person's authority and never more. The [workflows](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workflows.md) design keeps the delegate a thing of its own, apart from the definition, trigger, run and result. FAC-134 builds the Dot's other two operations first:
- **capability 1:** running a published workflow;
- **capability 2:** a personal workflow of console commands.

Each is created only by the person's own approval in InferOS. The kernel's `ApprovedEffects` method is bound to what the action declared at submit, and the outcome is reported to the chat as a claim, never as proof.

Today the kernel has no safe place for a delegate:
- **Spawned agent chats** (`spawn`, `spawnCallable`) run on the spawner's creator. Each call re-checks their bindings (`assertAgentBindingStillAvailable`), but not the creator's role or grant.
- **An agent turn resumes after a deferred approval with no role check.** It reads the initiator's model and starts the agent.
- **[ADR 0012](0012-run-correlation-and-outcomes.md)** gives a run a `delegates` row whose envelope is its parent's or narrower. Its D1 has delegates report through a completion callback. Nothing builds either yet.

So a delegate that rode the spawner path could outlive the person's grant, or resume after the person lost it.

## Decision

1. **A delegate is a spawned agent chat in the starter's own operate session.** Its `initiatorUserId` is the starter, and it runs on their account and model. It is never a spawner connection, an assigned principal or a system authority ([ADR 0011](0011-system-workflow-authority.md)).
2. **Only a person's approval in InferOS launches one.** The Dot proposes a gatekeeper action that declares the delegate at submit (`ActionDescription.delegate`: title, prompt, connections, tools). The kernel then:
   - checks the declaration;
   - shows the ceiling in its own field;
   - never auto-approves it.

   Only the session's owner can approve it. Only then is `ApprovedEffects.launchDelegate()` given. It has no argument: it launches what was declared. An agent can't launch a delegate itself.
3. **Its ceiling is fixed at approval and only narrows.** The ceiling is two sets:
   - **connections:** the declared connections that are the session's own and usable by its owner in operate chats (not `excludeFromOperateChat`);
   - **tools:** the declared tools within the operate agent's allowlist (`OPERATE_AGENT_TOOLS`).

   Nothing adds to it later. A call outside it is refused, even one the starter could make.
4. **Its authority is the starter's grant intersected with the ceiling, checked on every call.** The delegate records the starter's authz generation at launch. Every gatekeeper or gadget call it makes re-checks:
   - that generation;
   - the starter's role in the session;
   - the ceiling.

   Any change refuses the call and cancels the delegate, as retiring an operate session cancels its turns.
5. **Resuming re-verifies the starter.** A delegate's turn that resumes after an approval checks the starter as in rule 4 before it starts. For delegates, this closes the gap above.
6. **A delegate can't launch another.** Its record's parent is always empty, and a delegate's own `launchDelegate` is never offered.
7. **It reports an outcome only:** `succeeded | failed | cancelled` (ADR 0012 D1), never its transcript or output. It is reported to the chat as `ApprovedRunOutcome {kind: "delegate", …}` under capability 1's rules:
   - only the gatekeeper's session reports it;
   - the run id is bound at hand-off;
   - the chat shows it as "reported, not verified".
8. **Its record lives in the starter's operate session.** The `delegates` row is `{delegateId, starterProfileId, fromAction, chatId, ceiling, authzGeneration, state, outcome?, endedAt?}`. It is ADR 0012's row, with `parentDelegateId` always null. Only the starter sees it.

## Consequences

- **A delegate never holds more than its starter does at that moment.** Losing the grant, a role change, a company switch or retiring the session ends it at its next call, and its outcome reads `cancelled`.
- **Every delegate call costs a generation and role check.** That is the same read every person-initiated call already makes.
- **The spawner path and the resume path keep their present behaviour for everything that isn't a delegate.** Closing the resume gap for all agent turns is separate work.
- **A delegate creates no spawner, publishes nothing, and its chat isn't shared.** Delegates can't pass work to each other or build a tree.
- **InferOps proposes a delegate** through a Dot tool behind its own flag, off by default, as a handed-off write like capabilities 1 and 2. InferOS keeps only the record and references, never InferOps entities.

## Alternatives Considered

- **Launch through the agent spawner, as today's `spawn` does.** Rejected: it runs on the spawner's creator without re-checking their grant, so it could outlive the person's authority.
- **Copy the starter's grants into the delegate at launch.** Rejected: copied authority doesn't narrow when the starter's grant does. Rule 4 re-reads it instead.
- **Let a delegate launch delegates within its own ceiling.** Rejected for now: the ceiling would still hold, but cancellation and outcome reporting across a tree aren't designed. ADR 0012's `parentDelegateId` leaves room for it later.
- **Report the delegate's output to the chat.** Rejected: the Dot would carry content it hasn't checked into the person's conversation. An outcome is enough to decide what to do next.

## Related

- Design: [`workflows.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workflows.md)
- Journey: [`ask-dot.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/journeys/operator/dot/ask-dot.md)
- [ADR 0011](0011-system-workflow-authority.md), [ADR 0012](0012-run-correlation-and-outcomes.md)
- [Operate mode](../architecture/operate-mode.md)
