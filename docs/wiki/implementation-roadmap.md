---
title: Implementation roadmap
updated: 2026-10-03
---

# Implementation roadmap

The MVP release walkthrough, the wave milestones that group the work, and what has merged so far.

Roadmap: [#1](https://github.com/factory-level/inferos/issues/1). Its MVP decision (2026-10-02) is the canonical release scope: **InferOps Kanban and the InferMind Wiki are the customer-facing MVP, and InferOS is the configurable private shell that boots and hosts them.** The wave milestones below are work groupings, not release gates; an issue's own phase note decides which slice of it is release-critical.

This page tracks merge state only. A merged pull request is implementation evidence for a slice of an issue, not acceptance of the issue or of a walkthrough step. Status was taken from `main` after PR [#110](https://github.com/factory-level/inferos/pull/110) on 2026-10-03.

## Evidence so far

- Merged slices are proven with unit tests, fake-fetch tests, and integration suites that run the real Workshop and the real InferOps gatekeeper Worker against a fake InferLab and InferOps (for example [#108](https://github.com/factory-level/inferos/pull/108)), plus local runs on the gatekeeper's built-in demo data or the local-development stopgap token.
- An opt-in live suite ([#110](https://github.com/factory-level/inferos/pull/110), `inferops-live.test.ts`) ran the real Workshop and gatekeeper against a running InferOps `develop` (`9bc02d68`) on 2026-10-03: bind and read ENG, create, update and transition through approvals, a stale revision refused, a repeated approval writing nothing, a reload, and a content-workflow policy refusal surfacing as `FORBIDDEN`. It used one shared dev-persona token, so it proves the real API path, not per-person identity.
- The per-person live walkthrough has not been run: no person has yet signed in through InferLab (Google sign-in) against a running InferOps and operated a real project end to end. No walkthrough step in #1 is checked.
- The InferMind Wiki has no InferOS code yet ([#87](https://github.com/factory-level/inferos/issues/87), moved to Wave 3).

## MVP walkthrough order

From #1. Each step lists its owner issues in #1's order; "merged" names pull requests that landed a slice, and every issue listed here is still open unless marked closed.

| Step | Owner issues | Merged so far | Still open |
| --- | --- | --- | --- |
| 1. Intake, then configure one private customer | [#82](https://github.com/factory-level/inferos/issues/82) → [#18](https://github.com/factory-level/inferos/issues/18), [#19](https://github.com/factory-level/inferos/issues/19), [#9](https://github.com/factory-level/inferos/issues/9), [#10](https://github.com/factory-level/inferos/issues/10), [#33](https://github.com/factory-level/inferos/issues/33), [#35](https://github.com/factory-level/inferos/issues/35), [#36](https://github.com/factory-level/inferos/issues/36) | Consumer bootstrap [#37](https://github.com/factory-level/inferos/pull/37); config schema v2 [#84](https://github.com/factory-level/inferos/pull/84) (closed [#67](https://github.com/factory-level/inferos/issues/67)); `pnpm local` lifecycle for the in-repo stack [#95](https://github.com/factory-level/inferos/pull/95) (#10); runtime-effective `INFEROPS_ENABLED` [#103](https://github.com/factory-level/inferos/pull/103) (#33); Kanban customer shell from a wrapper (`--capability`), wrapper `pnpm local` and the kind-picker radio group [#109](https://github.com/factory-level/inferos/pull/109) (#35, #10, #59) | Reviewed intake (#82); wrapper topology (#9); settings explanation (#19); a browser pass of the customer shell (#35); the other capabilities in #33 |
| 2. Authenticate, then operate one real Kanban | [#66](https://github.com/factory-level/inferos/issues/66) → [#22](https://github.com/factory-level/inferos/issues/22), [#23](https://github.com/factory-level/inferos/issues/23) → [#25](https://github.com/factory-level/inferos/issues/25), [#26](https://github.com/factory-level/inferos/issues/26), [#27](https://github.com/factory-level/inferos/issues/27), with [#57](https://github.com/factory-level/inferos/issues/57), [#59](https://github.com/factory-level/inferos/issues/59), [#61](https://github.com/factory-level/inferos/issues/61), [#62](https://github.com/factory-level/inferos/issues/62) and bounded [#24](https://github.com/factory-level/inferos/issues/24), [#34](https://github.com/factory-level/inferos/issues/34) | Contract docs [#85](https://github.com/factory-level/inferos/pull/85) (closed [#21](https://github.com/factory-level/inferos/issues/21)); HTTP client [#86](https://github.com/factory-level/inferos/pull/86) and governed create/update [#104](https://github.com/factory-level/inferos/pull/104) (#22); Sign in with InferLab and per-person accounts [#94](https://github.com/factory-level/inferos/pull/94) (#66); URI grammar [#100](https://github.com/factory-level/inferos/pull/100) and [ADR 0005](../adr/0005-inferops-uri-authority.md) (#24, #25); resource-URL resolution [#88](https://github.com/factory-level/inferos/pull/88) and board adapter [#92](https://github.com/factory-level/inferos/pull/92) (#25); Kanban [#96](https://github.com/factory-level/inferos/pull/96) and Kanban create/edit [#107](https://github.com/factory-level/inferos/pull/107) (#26); action attribution [#97](https://github.com/factory-level/inferos/pull/97) and board activity [#102](https://github.com/factory-level/inferos/pull/102) (#27); operate session [#47](https://github.com/factory-level/inferos/pull/47) (closed #57); Operate page [#93](https://github.com/factory-level/inferos/pull/93) (closed #59); approval page events [#98](https://github.com/factory-level/inferos/pull/98), operate-only chat [#99](https://github.com/factory-level/inferos/pull/99) and approvals in the session [#105](https://github.com/factory-level/inferos/pull/105) (#61, #62); durable-view proof [#101](https://github.com/factory-level/inferos/pull/101) (#34); isolation suite [#108](https://github.com/factory-level/inferos/pull/108) (#23); opt-in live suite [#110](https://github.com/factory-level/inferos/pull/110) (#22, #23, #25, #26) | The live per-person walkthrough and its negative proof against a running InferOps; every owner issue except #21, #57 and #59 |
| 3. Open the related Wiki with the same live state | [#87](https://github.com/factory-level/inferos/issues/87) | The shared prerequisite only: the InferOps URI grammar (#100) | All of it; no InferOS Wiki surface or Wiki resource on the gatekeeper exists |
| 4. Detect missing and stale documentation | [#87](https://github.com/factory-level/inferos/issues/87), with InferOps companions | Nothing | All of it |
| 5. Dispatch one local coding customization | [#48](https://github.com/factory-level/inferos/issues/48) → [#69](https://github.com/factory-level/inferos/issues/69) → [#70](https://github.com/factory-level/inferos/issues/70), [#71](https://github.com/factory-level/inferos/issues/71) → [#72](https://github.com/factory-level/inferos/issues/72) | Nothing; `CODING_WORKBENCH_ENABLED` is accepted by the config schema and reported unsupported | All of it |
| 6. Review release evidence | [#83](https://github.com/factory-level/inferos/issues/83), local portion of [#20](https://github.com/factory-level/inferos/issues/20) | This documentation pass (#83) | Evidence capture against final candidate commits |

## Wave milestones

The milestones as set on GitHub. Wave 2's own order is: the live run that closes Wave 1 (#66, #22, #25, #26, #10) → #33 runtime flags → #23 isolation proof → #62 approvals in session → #61 operate-only chat → #27 activity → #24/#34 bounded contracts → #35 customer shell → #87 Wiki → #83 docs. #87 has since moved to Wave 3 (owner decision recorded on the issue).

### Wave 1: InferOps live path and Operate foundation

Real InferOps data through the gatekeeper into Kanban, plus the Operate kernel and UI.

| Issue | State | Merged slices |
| --- | --- | --- |
| [#21](https://github.com/factory-level/inferos/issues/21) InferOps account auth and scoped capability API | Closed | #85 (contract record; provider agreement and #66 lifetime questions stay open in it) |
| [#56](https://github.com/factory-level/inferos/issues/56) Workspace kind and typed workspaces | Closed | [#43](https://github.com/factory-level/inferos/pull/43), [#49](https://github.com/factory-level/inferos/pull/49) |
| [#57](https://github.com/factory-level/inferos/issues/57) Operate session | Closed | #47 |
| [#58](https://github.com/factory-level/inferos/issues/58) Operate flows | Closed | [#50](https://github.com/factory-level/inferos/pull/50) |
| [#59](https://github.com/factory-level/inferos/issues/59) Single-view Operate UI | Closed | [#90](https://github.com/factory-level/inferos/pull/90), #93 |
| [#67](https://github.com/factory-level/inferos/issues/67) Versioned config schema and migration | Closed | #84 |
| [#66](https://github.com/factory-level/inferos/issues/66) `INFEROPS_AUTH` identity integration | Open | #94 |
| [#22](https://github.com/factory-level/inferos/issues/22) Governed issue create/read/update/transition | Open | #86, #104, #110 |
| [#25](https://github.com/factory-level/inferos/issues/25) Scoped shared widget data adapter | Open | #88, #92, #100 |
| [#26](https://github.com/factory-level/inferos/issues/26) One real configurable Kanban | Open | #96, #107 |
| [#10](https://github.com/factory-level/inferos/issues/10) Local lifecycle, fixtures and diagnostics | Open | #95, #109 |

The five open issues wait on the live run.

### Wave 2: Real Kanban on the private shell

MVP steps 2 to 4 of #1.

| Issue | State | Merged slices |
| --- | --- | --- |
| [#33](https://github.com/factory-level/inferos/issues/33) Capability flags across CLI, deployment, server, tools and UI | Open | #103 (`INFEROPS_ENABLED`) |
| [#23](https://github.com/factory-level/inferos/issues/23) Sharing, deployment and tenant isolation | Open | #108 (fake InferLab and InferOps), #110 (live, shared token) |
| [#62](https://github.com/factory-level/inferos/issues/62) Configured approvals and real operation results | Open | #97, #98, #105 |
| [#61](https://github.com/factory-level/inferos/issues/61) Operate-only chat and agent-dispatched page events | Open | #99, #105 |
| [#27](https://github.com/factory-level/inferos/issues/27) Live agent activity on widgets | Open | #97, #102 |
| [#24](https://github.com/factory-level/inferos/issues/24) Canvas composition and widget contracts | Open | #100 |
| [#34](https://github.com/factory-level/inferos/issues/34) Durable view definitions | Open | #101 |
| [#35](https://github.com/factory-level/inferos/issues/35) Deployment profiles and styling | Open | #109 |
| [#83](https://github.com/factory-level/inferos/issues/83) MVP docs alignment | Open | This pass |

### Wave 3: Local coding and customer setup

Local coding with authorized dispatch, wrapper topology and settings, and the InferOS side of customer onboarding. Nothing in this wave has merged.

[#87](https://github.com/factory-level/inferos/issues/87) Wiki host, [#82](https://github.com/factory-level/inferos/issues/82) customer from reviewed intake, [#69](https://github.com/factory-level/inferos/issues/69), [#70](https://github.com/factory-level/inferos/issues/70), [#71](https://github.com/factory-level/inferos/issues/71), [#72](https://github.com/factory-level/inferos/issues/72) local coding, [#9](https://github.com/factory-level/inferos/issues/9) topology, [#18](https://github.com/factory-level/inferos/issues/18) scaffolder, [#19](https://github.com/factory-level/inferos/issues/19) settings, [#36](https://github.com/factory-level/inferos/issues/36) extension manifest, [#28](https://github.com/factory-level/inferos/issues/28) Kanban performance.

### Wave 4: Native agents and connection packages

Post-release per #1. All open: agent deployments [#76](https://github.com/factory-level/inferos/issues/76), [#77](https://github.com/factory-level/inferos/issues/77), [#78](https://github.com/factory-level/inferos/issues/78); agent authoring [#15](https://github.com/factory-level/inferos/issues/15), [#16](https://github.com/factory-level/inferos/issues/16), [#17](https://github.com/factory-level/inferos/issues/17); connection packages and fork upgrades [#73](https://github.com/factory-level/inferos/issues/73), [#74](https://github.com/factory-level/inferos/issues/74), [#75](https://github.com/factory-level/inferos/issues/75); publishing [#60](https://github.com/factory-level/inferos/issues/60), [#68](https://github.com/factory-level/inferos/issues/68); Operate views and subjects [#63](https://github.com/factory-level/inferos/issues/63), [#64](https://github.com/factory-level/inferos/issues/64); verify/upgrade skills [#20](https://github.com/factory-level/inferos/issues/20); cloud parity [#11](https://github.com/factory-level/inferos/issues/11).

### Wave 5: External platforms and later tracks

Post-release per #1. All open: external-agent integrations [#79](https://github.com/factory-level/inferos/issues/79), [#80](https://github.com/factory-level/inferos/issues/80), [#81](https://github.com/factory-level/inferos/issues/81); regulated-data rules [#65](https://github.com/factory-level/inferos/issues/65); ChatGPT connection on Cloudflare [#12](https://github.com/factory-level/inferos/issues/12), [#13](https://github.com/factory-level/inferos/issues/13), [#14](https://github.com/factory-level/inferos/issues/14); vertical research [#30](https://github.com/factory-level/inferos/issues/30), [#31](https://github.com/factory-level/inferos/issues/31), [#32](https://github.com/factory-level/inferos/issues/32); maps [#29](https://github.com/factory-level/inferos/issues/29).

## Epics

| Epic | Design |
| --- | --- |
| [#2](https://github.com/factory-level/inferos/issues/2) Cloudflare-like local development | [local-development](../design/local-development.md) |
| [#3](https://github.com/factory-level/inferos/issues/3) Personal ChatGPT connection | [chatgpt-connection](../design/chatgpt-connection.md) |
| [#4](https://github.com/factory-level/inferos/issues/4) Reusable native agent authoring | [agent-authoring](../design/agent-authoring.md) |
| [#5](https://github.com/factory-level/inferos/issues/5) InferOS repository setup skills | [repo-setup-skills](../design/repo-setup-skills.md) |
| [#6](https://github.com/factory-level/inferos/issues/6) Scoped real InferOps issue operations | [inferops-gatekeeper](../design/inferops-gatekeeper.md) |
| [#7](https://github.com/factory-level/inferos/issues/7) MVP Kanban and live operational widgets | [inferops-canvas](../design/inferops-canvas.md) |
| [#8](https://github.com/factory-level/inferos/issues/8) Vertical extension research | [vertical-extension-research](../design/vertical-extension-research.md) |
| [#48](https://github.com/factory-level/inferos/issues/48) Local coding workflows | [local-coding-workflows](../design/local-coding-workflows.md) |
| [#51](https://github.com/factory-level/inferos/issues/51) Connection packages and reviewed fork updates | [connection-extensions](../design/connection-extensions.md) |
| [#52](https://github.com/factory-level/inferos/issues/52) External-agent platform integrations | [agent-platform-integrations](../design/agent-platform-integrations.md) |
| [#53](https://github.com/factory-level/inferos/issues/53) Native agent deployments | [agent-deployments](../design/agent-deployments.md) |
| [#55](https://github.com/factory-level/inferos/issues/55) One useful Operate view | [operate-mode](../design/operate-mode.md) |

Customer capability flags are specified in [feature-capabilities](../design/feature-capabilities.md) (#33) and consumer configuration in [consumer-configuration](../design/consumer-configuration.md) (#33 to #36).

## Release evidence

Closing a feature issue requires its stated checks and an updated architecture document. #1 separates unit and fake-fetch tests, local integration, signed-in provider proof and cloud-only checks; each is reported as what it is. A mock or fake is not a live-provider proof, a local proof is not a deployed-origin proof, and a merged pull request is not a checked walkthrough step. ChatGPT plan usage on Cloudflare stays gated by its feasibility issue (#12) and is never silently replaced with API-key billing.

## Documentation validation

Run `pnpm docs:check` and `git diff --check`. These checks validate document structure only; they imply no feature build, provider integration or deployment.
