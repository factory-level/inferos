---
title: Choosing an InferOS extension
updated: 2026-10-01
---

# Choosing an InferOS extension

A code-backed decision guide for choosing the smallest extension surface.

## Steps

1. State the workflow, data owner and authority needed, including the exact write and rollback behavior.
2. Check whether deployment/admin configuration or an existing bound capability already supplies it.
3. Use a skill for authoring guidance and a Gadget/Blueprint for sandboxed application behavior.
4. Use a gatekeeper for new external authority or a typed domain boundary. Add an external service when protocols, storage or runtime requirements demand it.
5. Propose a kernel change only after showing why existing composition cannot provide a general missing capability.

## Capability inventory

| Surface | Current mechanism and evidence | Appropriate use | Boundary or gap |
| --- | --- | --- | --- |
| Deployment configuration | `scripts/worker-config.ts`, `scripts/release/manifest-lib.ts` | Workers, bindings, origins, storage and deploy inputs | Canonical configs generate Wrangler files; wrappers need additional discovery support |
| Admin configuration | `packages/workshop-backend/src/admin-config.ts` | Instructions, site appearance, offered connectors and provisioning modes | Cannot change authentication policy; optional is the default auto-provisioning mode |
| Skills | `.agents/skills` | Explain and orchestrate reproducible authoring/setup tasks | Instructions confer no runtime authority; setup suite is proposed |
| Gadget | `packages/workshop-shared/src/api.ts`, `GadgetUI.tsx` | Sandboxed UI and native agent/application behavior | Bind resources explicitly; no host DOM or ambient external credentials |
| Blueprint | [Blueprint docs](../blueprints.md), `packages/bundled-blueprints` | Portable code with binding requirements; curated deployment formats | Export does not move live SQLite/history/credentials; qualification is proposed |
| Custom gatekeeper | `packages/gatekeeper-kit`, `workshop-shared/src/gatekeeper.ts` | Typed external reads and proposed actions | Reuse observation/approval and nonce-bound connect handoff |
| Generic MCP | `packages/mcp-shared/README.md` | Connect existing MCP servers | Untrusted annotations cannot auto-approve writes; typed canvas hosting is separate |
| Context Library | `packages/gatekeeper-context` | Private or admin-published document collections | sharingDomain isolation; public publishing is admin-owned |
| Scheduler | `packages/gatekeeper-scheduler` | Durable callbacks into native workspaces | Enable via Connections; retries require idempotency; not exactly-once |
| Callable agent | `packages/workshop-backend/src/agent-spawner-binding.d.ts` | Native asynchronous delegated work | Enqueue acknowledgement differs from completion callback |
| External service | Gatekeeper HTTP/API boundary | Existing domain storage, device gateway, heavy compute, provider-owned data | API contract, availability and permissions remain real dependencies |
| Kernel | `workshop-backend`, `workshop-shared` | General capability the mechanisms above cannot represent | Small reviewable changes; document exported API; avoid parallel authority paths |

## Decision dimensions

| Question | If yes | Required proof |
| --- | --- | --- |
| Is it only a site policy/default? | Configuration | Settings apply without widening identity policy |
| Is it guidance or a repeatable development task? | Skill plus deterministic script | Fresh-clone and rerun evidence |
| Can existing bindings supply data/actions? | Gadget/Blueprint | Scope, persistence and failure-path tests |
| Is a new external credential or domain action needed? | Gatekeeper | Observation, preview, approval, revocation and retry proof |
| Is there a private network, specialist protocol or large compute need? | External service behind gatekeeper | Network/runtime/load proof and bounded authority |
| Is a fundamental sandbox/RPC capability missing? | Separate kernel proposal | Failed composition example and minimal general API |

The classifications below are engineering inferences from inspected mechanisms, not provider endorsements. Use the [vertical matrix](vertical-decision-matrix.md) to choose a representative proof.
