---
title: Choosing an InferOS extension
updated: 2026-10-04
---

# Choosing an InferOS extension

A code-backed decision guide for choosing the smallest extension surface. Wave 5 audit: InferOS `21708d3449a482843e13cb2268d1ae79451c7dfb` (2026-10-04). Paths below are relative to that revision; [source ledger](research-sources.md) records dated provider evidence.

## Steps

1. State the workflow, data owner and authority needed, including the exact write and rollback behavior.
2. Check whether deployment/admin configuration or an existing bound capability already supplies it.
3. Use a skill for authoring guidance and a Gadget/Blueprint for sandboxed application behavior.
4. Use a gatekeeper for new external authority or a typed domain boundary. Add an external service when protocols, storage or runtime requirements demand it.
5. Propose a kernel change only after showing why existing composition cannot provide a general missing capability.

## Capability inventory

| Surface | Current mechanism and evidence | Appropriate use | Boundary or gap |
| --- | --- | --- | --- |
| Deployment configuration | `scripts/worker-config.ts`, `scripts/release/manifest-lib.ts` | Workers, bindings, origins, storage and deploy inputs | Canonical configs generate Wrangler files; wrapper custom-worker discovery exists, cloud proof remains #11 |
| Admin configuration | `packages/workshop-backend/src/admin-config.ts` | Instructions, site appearance, offered connectors and provisioning modes | Cannot change authentication policy; optional is the default auto-provisioning mode |
| Skills | `.agents/skills` | Explain and orchestrate reproducible authoring/setup tasks | Instructions confer no runtime authority; setup/verify/upgrade/recover commands exist, production qualification remains separate |
| Gadget | `packages/workshop-shared/src/api.ts`, `packages/workshop-frontend/src/GadgetUI.tsx` | Sandboxed UI and native agent/application behavior | Bind resources explicitly; no host DOM or ambient external credentials |
| Blueprint | [Blueprint docs](../blueprints.md), `packages/bundled-blueprints` | Portable code with binding requirements; curated deployment formats | Export does not move live SQLite/history/credentials; pinned install/explicit upgrade exists, publication UI is #155 |
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

## Wave 5 implemented additions and remaining gaps

| Capability | Inspected evidence at the revision above | Limit / tracking |
| --- | --- | --- |
| Wrapper intake, pinning, rerun preservation and reviewed upgrade | `scripts/consumer/bootstrap.ts`, `intake.ts`, `upgrade.ts`, `reconcile.ts`; their colocated tests | Cloud parity #11; customer Wiki gates #82/#87 |
| Connection package scaffolding and discovery | `scripts/scaffold-gatekeeper.ts`, `scripts/connection-package.schema.json`, `scripts/worker-dirs.ts`, `custom-gatekeepers/gatekeeper-tickets` | Tickets is synthetic/conformant, not a real provider |
| Pinned app/widget/workflow installs | `packages/integration-tests/__tests__/operate-published.test.ts`, shared API `upgradeInstall` | Publication review UI/container #155; destination flags #68 remain deferred |
| Board composition and bounded rendering | `features/canvas/KanbanColumn.tsx` in Workshop frontend, `boardData.ts`; #156 paired browser measurements | Full provider read, proposed budgets #158, paging inferops#2335, maps #29 |
| Per-person Operate session and use-only capabilities | `packages/workshop-shared/src/operate-session.ts`, backend `user.ts` and `overseer.ts`; #63 browser evidence | Company IAM roles/policy #65/#80; per-person live identity #59/#66/#23 |
| Local subscription inference | `assistant-plugins/openai`, `workshop-backend/src/openai-plugin.ts` | Fake-backed tests; Cloudflare eligibility/live proof #12–#14 |
| Native deployments / external agents | Configuration accepts names but reports unsupported runtime | #15–#17/#76–#78 and #79/#80; HG/#81 entirely deferred |

Do not infer deployment support from schema acceptance, or product availability from a source-code test. Obsidian's 2026-10-04 product drafts still call all pinned publication and role gating unbuilt: the bounded mechanisms above supersede that implementation wording, not their unimplemented publication-review UI or company-role requirements.
