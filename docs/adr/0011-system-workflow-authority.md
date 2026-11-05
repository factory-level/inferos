---
title: Configured system work uses its assigned principal, apart from each person's token
status: proposed
date: 2026-11-02
---

# 0011. Configured system work uses its assigned principal, apart from each person's token

**Status note (2026-11-05):** this record stays proposed. Invoking (inferops ADR 0011 D3's grant half) is built: `workflow:invoke` is checked in the connection's target InferOps workspace only (manager, 2026-11-05), through the person's own token; no other workspace's grant counts.

## Context

[ADR 0004](0004-inferops-gatekeeper-user-authority.md) has the InferOps gatekeeper act with each person's own token, and leaves unattended work open. The design has a second context: a predefined system workflow runs with the authority assigned to it and its permitted trigger ([agent operations](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/agent-operations.md)).

The rules for both contexts are in InferOps' [ADR 0011](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0011-workflow-authority-envelopes.md), also proposed. This record says only what they mean on this side.

Read at inferos `c6e7e22378a08cce0bdc5c643f4bde7b4e9d08f3`. Nothing here is built, and this record changes no code.

## Decision

1. **ADR 0004 stands for user work.** A custom action, including through a personal agent, carries the requesting person's own token, narrowed by the capabilities available. An agent adds no authority of its own.
2. **System work uses a separate credential** for its assigned InferOps service account, held server-side by the gatekeeper. An agent, a Gadget's code or a sandbox never sees it.
3. **Neither falls back to the other.** User work with no usable token waits for the person to reconnect. A system run whose credential is refused fails or waits. **Denied:** a system run using someone's token, or a user request reaching the system credential.
4. **The context comes from the server-side run, never from a call.** A prompt, a tool result, a stub argument, a widget parameter or an `inferops://` reference can't select it. The gatekeeper has no parameter that names it.
5. **Agents can't start a system run or enable its trigger.** This keeps the shapes that exist: an agent's `startFlow` is refused (`packages/workshop-backend/src/user.ts:1188`), and a Scheduled Tasks registration is disabled until a person enables it (`packages/gatekeeper-scheduler/README.md`).
6. **A delegate keeps its parent's context and can only narrow it.** `spawn` and `spawnCallable` can't change the principal.
7. **InferOps stays authoritative.** It authorizes on the acting principal. A requester InferOS reports with a system call is recorded as a claim and grants nothing.

## Consequences

- Each person's connection works as ADR 0004 says, with no change.
- ADR 0007's deployment principal is where a system credential attaches. Its definition already holds no grant or trigger, so a behaviour edit can't change authority.
- The gatekeeper needs a second credential path, kept apart from per-person storage, with its own rotation. That's a security-sensitive change when it's built.
- Audit on this side has to keep the requester or trigger occurrence beside the executor, so the InferOps record can show both.
- `AGENT_DEPLOYMENTS` stays unsupported until this and its lifecycle are built. A flag or profile grants nothing.

## Alternatives Considered

- Run system work under the token of the person who configured it: it would stop when they leave, and an Operator's control would run with an Admin's reach.
- One shared service-account key for all system work in a deployment: a workflow's bound would mean nothing, and audit couldn't tell workflows apart.
- Choose the context from a field in the agent definition: an edit to reviewed behaviour would then change authority, which ADR 0007 rules out.

## Related

- Design: [`agent-operations.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/agent-operations.md), [`agent-deployments.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/agent-deployments.md)
- [ADR 0004](0004-inferops-gatekeeper-user-authority.md), [ADR 0007](0007-agent-deployment-lifecycle.md)
