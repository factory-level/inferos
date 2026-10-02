---
title: Implementation roadmap
updated: 2026-10-01
---

# Implementation roadmap

Seven pillars, sequenced implementation slices and deferred maps work.

## Steps

1. Start local topology, ChatGPT eligibility, native authoring inventory and InferOps API contract work.
2. Establish fixtures, configuration explanations and scoped gatekeeper actions.
3. Deliver guarded canvas composition/data loading and Kanban, then agent activity and measured performance.
4. Verify consuming-repository setup, upgrade and cloud parity; publish reproducible vertical recipes.
5. Add maps after the first widget contract and performance path are stable.

Roadmap: [#1](https://github.com/factory-level/inferos/issues/1). All feature work remains open. See the [draft pillars](../design/platform-pillars.md). GitHub Issues was enabled to publish this backlog. Documentation is local until committed/merged; issue bodies are self-contained and do not link to nonexistent main-branch documents.

## Pillar and implementation issue map

### Cloudflare-like local development — [#2](https://github.com/factory-level/inferos/issues/2)

| Issue | Outcome | Dependencies |
| --- | --- | --- |
| [#9](https://github.com/factory-level/inferos/issues/9) | Generate wrapper-aware local and deployed Worker topology | Foundation |
| [#10](https://github.com/factory-level/inferos/issues/10) | Add local lifecycle, fixtures and agent diagnostics | [#9](https://github.com/factory-level/inferos/issues/9) |
| [#11](https://github.com/factory-level/inferos/issues/11) | Verify local-to-Cloudflare behavior and document cloud-only checks | [#10](https://github.com/factory-level/inferos/issues/10) |

### Personal ChatGPT connection — [#3](https://github.com/factory-level/inferos/issues/3)

| Issue | Outcome | Dependencies |
| --- | --- | --- |
| [#12](https://github.com/factory-level/inferos/issues/12) | Prove official ChatGPT subscription support for a personal Cloudflare install | Foundation |
| [#13](https://github.com/factory-level/inferos/issues/13) | Implement subscription account lifecycle and eligible model discovery | [#12](https://github.com/factory-level/inferos/issues/12) |
| [#14](https://github.com/factory-level/inferos/issues/14) | Adapt native inference and tool turns for ChatGPT plan usage | [#13](https://github.com/factory-level/inferos/issues/13) |

### Reusable native agent authoring — [#4](https://github.com/factory-level/inferos/issues/4)

| Issue | Outcome | Dependencies |
| --- | --- | --- |
| [#15](https://github.com/factory-level/inferos/issues/15) | Extract reusable AI Trader authoring contracts onto native InferOS primitives | Foundation |
| [#16](https://github.com/factory-level/inferos/issues/16) | Add skill revision pinning and artifact qualification proofs | [#15](https://github.com/factory-level/inferos/issues/15), [#10](https://github.com/factory-level/inferos/issues/10) |
| [#17](https://github.com/factory-level/inferos/issues/17) | Publish, import and rebind portable native agent artifacts | [#16](https://github.com/factory-level/inferos/issues/16) |

### InferOS repository setup skills — [#5](https://github.com/factory-level/inferos/issues/5)

| Issue | Outcome | Dependencies |
| --- | --- | --- |
| [#18](https://github.com/factory-level/inferos/issues/18) | Create InferOS-owned wrapper bootstrap skill and deterministic scaffolder | [#9](https://github.com/factory-level/inferos/issues/9) |
| [#19](https://github.com/factory-level/inferos/issues/19) | Explain and validate required local and deployment settings | [#18](https://github.com/factory-level/inferos/issues/18) |
| [#20](https://github.com/factory-level/inferos/issues/20) | Add verify, upgrade and recovery skills for consuming repositories | [#19](https://github.com/factory-level/inferos/issues/19), [#11](https://github.com/factory-level/inferos/issues/11) |

### InferOps gatekeeper — [#6](https://github.com/factory-level/inferos/issues/6)

| Issue | Outcome | Dependencies |
| --- | --- | --- |
| [#21](https://github.com/factory-level/inferos/issues/21) | Define InferOps account auth and scoped project capability API | Foundation |
| [#22](https://github.com/factory-level/inferos/issues/22) | Implement observed board reads and approved issue transitions | [#21](https://github.com/factory-level/inferos/issues/21), [#10](https://github.com/factory-level/inferos/issues/10) |
| [#23](https://github.com/factory-level/inferos/issues/23) | Verify sharing, deployment and tenant isolation for InferOps capabilities | [#22](https://github.com/factory-level/inferos/issues/22) |

### InferOps canvas and transactional widgets — [#7](https://github.com/factory-level/inferos/issues/7)

| Issue | Outcome | Dependencies |
| --- | --- | --- |
| [#24](https://github.com/factory-level/inferos/issues/24) | Define guarded canvas composition, persistence and shared widget contracts | [#21](https://github.com/factory-level/inferos/issues/21) |
| [#25](https://github.com/factory-level/inferos/issues/25) | Build a scoped shared transactional widget data adapter | [#24](https://github.com/factory-level/inferos/issues/24), [#22](https://github.com/factory-level/inferos/issues/22) |
| [#26](https://github.com/factory-level/inferos/issues/26) | Ship Kanban across guarded canvas, chat and full view | [#25](https://github.com/factory-level/inferos/issues/25) |
| [#27](https://github.com/factory-level/inferos/issues/27) | Show live agent activity on authorized canvas widgets | [#25](https://github.com/factory-level/inferos/issues/25), [#15](https://github.com/factory-level/inferos/issues/15) |
| [#28](https://github.com/factory-level/inferos/issues/28) | Measure and improve Kanban loading and interaction performance | [#26](https://github.com/factory-level/inferos/issues/26), [#27](https://github.com/factory-level/inferos/issues/27) |
| [#29](https://github.com/factory-level/inferos/issues/29) | Later: add maps using the shared widget contract | [#28](https://github.com/factory-level/inferos/issues/28) |

### Vertical extension research and decision matrix — [#8](https://github.com/factory-level/inferos/issues/8)

| Issue | Outcome | Dependencies |
| --- | --- | --- |
| [#30](https://github.com/factory-level/inferos/issues/30) | Maintain a source-backed CloudflareOS extension capability wiki | Foundation |
| [#31](https://github.com/factory-level/inferos/issues/31) | Validate the 12-vertical, 36-workflow customization decision matrix | [#30](https://github.com/factory-level/inferos/issues/30) |
| [#32](https://github.com/factory-level/inferos/issues/32) | Turn priority vertical decisions into reproducible extension recipes | [#31](https://github.com/factory-level/inferos/issues/31), [#19](https://github.com/factory-level/inferos/issues/19), [#11](https://github.com/factory-level/inferos/issues/11) |

## Release evidence

Closing a feature issue requires its stated checks and an updated current-state architecture document. A mock is not a live-provider proof; a local proof is not a deployed-origin proof. The first complete user flow is wrapper setup → native agent → scoped board read → approved transition → canvas refresh with truthful activity. ChatGPT target-host support is separately gated by its feasibility issue and must never be silently replaced with API-key billing.

## Documentation validation

Run `pnpm docs:check` and `git diff --check`. Check the issue map for seven epics and 28 children, no missing prerequisites and no dependency cycles. No feature build, provider integration or cloud deployment is implied by these documentation checks.

## Consumer completion gaps

The objective also requires runtime-effective flags, profiles, styling, durable definitions and custom Cloudflare code. These four implementation issues expand the original backlog:

| Issue | Parent | Required outcome |
| --- | --- | --- |
| [#33](https://github.com/factory-level/inferos/issues/33) | #5 | Versioned profile/flag resolution in bootstrap, server and UI |
| [#34](https://github.com/factory-level/inferos/issues/34) | #7 | Scoped durable definitions with revisions, recovery and disable/re-enable |
| [#35](https://github.com/factory-level/inferos/issues/35) | #5 | Applied profiles and semantic styling without overwriting admin edits |
| [#36](https://github.com/factory-level/inferos/issues/36) | #2 | Wrapper-owned Cloudflare extension manifest, local and cloud wiring |

A first [consumer bootstrap](consumer-bootstrap.md) now creates a cloneable pinned wrapper and validates settings. This is partial implementation evidence. Full completion requires the synthetic/remote InferOps data and selected features to work in the running local environment, plus the deployment parity checks. The goal remains active.
