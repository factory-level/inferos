---
title: Implementation roadmap
updated: 2026-10-04
---

# Implementation roadmap

The MVP release walkthrough, the wave milestones that group the work, and what has merged so far.

Roadmap: [#1](https://github.com/factory-level/inferos/issues/1). Its MVP decision (2026-10-02) is the canonical release scope: **InferOps Kanban and the InferMind Wiki are the customer-facing MVP, and InferOS is the configurable private shell that boots and hosts them.** The wave milestones below are work groupings, not release gates; an issue's own phase note decides which slice of it is release-critical.

This page tracks merge state only. A merged pull request is implementation evidence for a slice of an issue, not acceptance of the issue or of a walkthrough step. The Wave 4 and Wave 5 sections record their 2026-10-04 implementation and disposition status; earlier waves retain their evidence boundaries.

## Evidence so far

- Merged slices are proven with unit tests, fake-fetch tests, and integration suites that run the real Workshop and the real InferOps gatekeeper Worker against a fake InferLab and InferOps (for example [#108](https://github.com/factory-level/inferos/pull/108)), plus local runs on the gatekeeper's built-in demo data or the local-development stopgap token.
- An opt-in live suite ([#110](https://github.com/factory-level/inferos/pull/110), `inferops-live.test.ts`) ran the real Workshop and gatekeeper against a running InferOps `develop` (`9bc02d68`) on 2026-10-03: bind and read ENG, create, update and transition through approvals, a stale revision refused, a repeated approval writing nothing, a reload, and a content-workflow policy refusal surfacing as `FORBIDDEN`. It used one shared dev-persona token, so it proves the real API path, not per-person identity.
- The per-person live walkthrough has not been run: no person has yet signed in through InferLab (Google sign-in) against a running InferOps and operated a real project end to end. No walkthrough step in #1 is checked.
- A second live run ([#125](https://github.com/factory-level/inferos/pull/125)) against InferOps `develop` (`abeca60a`) on 2026-10-03, with the same shared dev-persona token, proved governed coding dispatch (a real run queued on approval, `RUN_ACTIVE`, stale revision at proposal and at apply, cancel through approval, a board binding unable to dispatch) and the InferMind Wiki (InferMind-only binding, page reads and agent text matching InferOps, a section edit through approval, a stale edit refused at apply). No runner was started, so no coding run was executed.
- The local coding runner itself (InferOps patch mode, environment allowlist, test evidence and recovery) is merged to InferOps `develop` (factory-level/inferops#2330 `e6c43029`, #2332 `7c167888`) and tested there; no signed-in patch run has been executed yet. The InferOS side runs it only against a stub runner and stub Codex ([#120](https://github.com/factory-level/inferos/pull/120), labelled mocked).
- A Wave 4 browser run (2026-10-03, recorded on [#59](https://github.com/factory-level/inferos/issues/59)) drove the Operate console against a live InferOps `develop` (`abeca60a`) at 1440 and 390 widths: a console opening its board, board to issue and back through in-app and browser navigation, reload and sign-out/in, and an approved transition writing once despite a double-click. It used the stub persona token and the gatekeeper's shared stopgap connection with a scripted chat model, so it is not per-person or real-LLM evidence.
- Executed local runs: a fresh wrapper's custom Worker ([#118](https://github.com/factory-level/inferos/pull/118)) and its own gatekeeper, side by side with a second wrapper ([#126](https://github.com/factory-level/inferos/pull/126)).

## MVP walkthrough order

From #1. Each step lists its owner issues in #1's order; "merged" names pull requests that landed a slice, and every issue listed here is still open unless marked closed.

| Step | Owner issues | Merged so far | Still open |
| --- | --- | --- | --- |
| 1. Intake, then configure one private customer | [#82](https://github.com/factory-level/inferos/issues/82) → [#18](https://github.com/factory-level/inferos/issues/18), [#19](https://github.com/factory-level/inferos/issues/19), [#9](https://github.com/factory-level/inferos/issues/9), [#10](https://github.com/factory-level/inferos/issues/10), [#33](https://github.com/factory-level/inferos/issues/33), [#35](https://github.com/factory-level/inferos/issues/35), [#36](https://github.com/factory-level/inferos/issues/36) | Consumer bootstrap [#37](https://github.com/factory-level/inferos/pull/37); config schema v2 [#84](https://github.com/factory-level/inferos/pull/84) (closed [#67](https://github.com/factory-level/inferos/issues/67)); `pnpm local` lifecycle for the in-repo stack [#95](https://github.com/factory-level/inferos/pull/95) (#10); runtime-effective `INFEROPS_ENABLED` [#103](https://github.com/factory-level/inferos/pull/103) (#33); Kanban customer shell from a wrapper (`--capability`), wrapper `pnpm local` and the kind-picker radio group [#109](https://github.com/factory-level/inferos/pull/109) (#35, #10, #59); wrapper-owned gatekeepers and topology [#115](https://github.com/factory-level/inferos/pull/115), [#126](https://github.com/factory-level/inferos/pull/126) (#9); reviewed intake to configuration [#116](https://github.com/factory-level/inferos/pull/116) (#82); settings table and doctor [#119](https://github.com/factory-level/inferos/pull/119) (#19); starter inventory and fresh-wrapper extension run [#118](https://github.com/factory-level/inferos/pull/118) (#18, #36) | Wiki pillars and Masters from the intake (#82, waits on factory-level/inferops#2324); a browser pass of the customer shell (#35); the other capabilities in #33 |
| 2. Authenticate, then operate one real Kanban | [#66](https://github.com/factory-level/inferos/issues/66) → [#22](https://github.com/factory-level/inferos/issues/22), [#23](https://github.com/factory-level/inferos/issues/23) → [#25](https://github.com/factory-level/inferos/issues/25), [#26](https://github.com/factory-level/inferos/issues/26), [#27](https://github.com/factory-level/inferos/issues/27), with [#57](https://github.com/factory-level/inferos/issues/57), [#59](https://github.com/factory-level/inferos/issues/59), [#61](https://github.com/factory-level/inferos/issues/61), [#62](https://github.com/factory-level/inferos/issues/62) and bounded [#24](https://github.com/factory-level/inferos/issues/24), [#34](https://github.com/factory-level/inferos/issues/34) | Contract docs [#85](https://github.com/factory-level/inferos/pull/85) (closed [#21](https://github.com/factory-level/inferos/issues/21)); HTTP client [#86](https://github.com/factory-level/inferos/pull/86) and governed create/update [#104](https://github.com/factory-level/inferos/pull/104) (#22); Sign in with InferLab and per-person accounts [#94](https://github.com/factory-level/inferos/pull/94) (#66); URI grammar [#100](https://github.com/factory-level/inferos/pull/100) and [ADR 0005](../adr/0005-inferops-uri-authority.md) (#24, #25); resource-URL resolution [#88](https://github.com/factory-level/inferos/pull/88) and board adapter [#92](https://github.com/factory-level/inferos/pull/92) (#25); Kanban [#96](https://github.com/factory-level/inferos/pull/96) and Kanban create/edit [#107](https://github.com/factory-level/inferos/pull/107) (#26); action attribution [#97](https://github.com/factory-level/inferos/pull/97) and board activity [#102](https://github.com/factory-level/inferos/pull/102) (#27); operate session [#47](https://github.com/factory-level/inferos/pull/47) (closed #57); Operate page [#93](https://github.com/factory-level/inferos/pull/93) (#59); approval page events [#98](https://github.com/factory-level/inferos/pull/98), operate-only chat [#99](https://github.com/factory-level/inferos/pull/99) and approvals in the session [#105](https://github.com/factory-level/inferos/pull/105) (#61, #62); durable-view proof [#101](https://github.com/factory-level/inferos/pull/101) (#34); isolation suite [#108](https://github.com/factory-level/inferos/pull/108) (#23); opt-in live suite [#110](https://github.com/factory-level/inferos/pull/110) (#22, #23, #25, #26); Wave 4 console work: `findBoards` and `openBoard` [#140](https://github.com/factory-level/inferos/pull/140) (#61), action outcomes from the action log [#147](https://github.com/factory-level/inferos/pull/147) (#59) | The live per-person walkthrough and its negative proof against a running InferOps; every owner issue except #21 and #57 |
| 3. Open the related Wiki with the same live state | [#87](https://github.com/factory-level/inferos/issues/87) | The InferOps URI grammar (#100); the gatekeeper's `knowledge/wiki` resource [#123](https://github.com/factory-level/inferos/pull/123); the canvas Wiki widget with live board and issue embeds and the agent text view [#124](https://github.com/factory-level/inferos/pull/124); live stub-token run [#125](https://github.com/factory-level/inferos/pull/125) | Company root, pillars, Master pages, shared pages and document body authoring (InferOps: factory-level/inferops#1607, #2324, #2325); a per-person live run |
| 4. Detect missing and stale documentation | [#87](https://github.com/factory-level/inferos/issues/87), with InferOps companions | Nothing | All of it |
| 5. Dispatch one local coding customization | [#48](https://github.com/factory-level/inferos/issues/48) → [#69](https://github.com/factory-level/inferos/issues/69) → [#70](https://github.com/factory-level/inferos/issues/70), [#71](https://github.com/factory-level/inferos/issues/71) → [#72](https://github.com/factory-level/inferos/issues/72) | Governed dispatch behind `CODING_WORKBENCH_ENABLED` [#117](https://github.com/factory-level/inferos/pull/117) (#69, #70); the Kanban control surface [#121](https://github.com/factory-level/inferos/pull/121); runner lifecycle, coding doctor and skills [#120](https://github.com/factory-level/inferos/pull/120) (#71, #72); live stub-token dispatch [#125](https://github.com/factory-level/inferos/pull/125) | A real patch-mode run with a signed-in Codex (owner step, deferred) |
| 6. Review release evidence | [#83](https://github.com/factory-level/inferos/issues/83), local portion of [#20](https://github.com/factory-level/inferos/issues/20) | This documentation pass (#83); wrapper verify, upgrade and recover [#131](https://github.com/factory-level/inferos/pull/131), [#141](https://github.com/factory-level/inferos/pull/141) (closed #20) | Evidence capture against final candidate commits |

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
| [#59](https://github.com/factory-level/inferos/issues/59) Role-console Kanban and issue flow (reopened for MVP stabilization) | Open | [#90](https://github.com/factory-level/inferos/pull/90), #93, [#147](https://github.com/factory-level/inferos/pull/147) |
| [#67](https://github.com/factory-level/inferos/issues/67) Versioned config schema and migration | Closed | #84 |
| [#66](https://github.com/factory-level/inferos/issues/66) `INFEROPS_AUTH` identity integration | Open | #94 |
| [#22](https://github.com/factory-level/inferos/issues/22) Governed issue create/read/update/transition | Open | #86, #104, #110 |
| [#25](https://github.com/factory-level/inferos/issues/25) Scoped shared widget data adapter | Open | #88, #92, #100 |
| [#26](https://github.com/factory-level/inferos/issues/26) One real configurable Kanban | Open | #96, #107 |
| [#10](https://github.com/factory-level/inferos/issues/10) Local lifecycle, fixtures and diagnostics | Open | #95, #109 |

#59 now tracks the role-console Kanban flow; see Wave 4 for its status. The other five open issues wait on the live run.

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

Local coding with authorized dispatch, wrapper topology and settings, the InferOS side of customer onboarding, and the InferOS side of the Wiki. #28 moved to Wave 4 (post-release). The isolation suite's reload flake was fixed in [#122](https://github.com/factory-level/inferos/pull/122).

| Issue | State | Merged slices |
| --- | --- | --- |
| [#9](https://github.com/factory-level/inferos/issues/9) Wrapper-aware topology | Closed | [#115](https://github.com/factory-level/inferos/pull/115), [#126](https://github.com/factory-level/inferos/pull/126) |
| [#18](https://github.com/factory-level/inferos/issues/18) Bootstrap skill and scaffolder | Closed | #37, [#118](https://github.com/factory-level/inferos/pull/118) |
| [#19](https://github.com/factory-level/inferos/issues/19) Required settings | Closed | [#119](https://github.com/factory-level/inferos/pull/119) |
| [#36](https://github.com/factory-level/inferos/issues/36) Wrapper extensions manifest | Closed (MVP slice; cloud packaging post-release) | #37, [#118](https://github.com/factory-level/inferos/pull/118) |
| [#70](https://github.com/factory-level/inferos/issues/70) Authorized dispatch, status and result | Closed | [#117](https://github.com/factory-level/inferos/pull/117), [#121](https://github.com/factory-level/inferos/pull/121), [#125](https://github.com/factory-level/inferos/pull/125) |
| [#82](https://github.com/factory-level/inferos/issues/82) Customer from reviewed intake | Open: Wiki pillars and Masters wait on factory-level/inferops#2324 | [#116](https://github.com/factory-level/inferos/pull/116) |
| [#69](https://github.com/factory-level/inferos/issues/69) Runner contract and patch mode | Open: no executed patch run (factory-level/inferops#2330 merged) | [#117](https://github.com/factory-level/inferos/pull/117), [#120](https://github.com/factory-level/inferos/pull/120) |
| [#71](https://github.com/factory-level/inferos/issues/71) Environment, evidence and recovery | Closed (factory-level/inferops#2332 merged) | [#120](https://github.com/factory-level/inferos/pull/120) |
| [#72](https://github.com/factory-level/inferos/issues/72) Skills, control surface, end-to-end proof | Open: live proof deferred by the owner | [#120](https://github.com/factory-level/inferos/pull/120), [#121](https://github.com/factory-level/inferos/pull/121) |
| [#87](https://github.com/factory-level/inferos/issues/87) Wiki host | Open: InferOps root, pillars, Masters and coverage | [#123](https://github.com/factory-level/inferos/pull/123), [#124](https://github.com/factory-level/inferos/pull/124), [#125](https://github.com/factory-level/inferos/pull/125) |

### Wave 4: Native agents and connection packages

Wave 4’s non-deferred work is complete: #28, #60 and #63 are closed. The owner directed remaining human input into follow-up issues; numeric Kanban budget agreement is deferred to [#158](https://github.com/factory-level/inferos/issues/158), Wave 5, and the recorded ceilings remain proposed. Role-console context/navigation (#63) is the bounded release-critical slice; the other Wave 4 tracks remain post-release per #1. The consoles, connection packages, reviewed upgrades, wrapper tooling, router-path parity, pinned installs and measured/windowed Kanban are merged. The milestone remains open only for the eight owner-deferred issues listed below; agent contract/publication drafts remain parked.

Owner decision (2026-10-03): a use-role operator reads boards through their own InferOps sign-in, never through the owner's connection. #139 and #142 implement it.

Merged pull requests:

| Pull request | Issue | What landed |
| --- | --- | --- |
| [#113](https://github.com/factory-level/inferos/pull/113) | Operate consoles | Consoles kernel, console page state with full chat, and Operate seed data; console events check membership; use-role `listConsoles` |
| [#114](https://github.com/factory-level/inferos/pull/114) | Operate consoles | Console UI: one sidebar, console mosaic, Overview rollup, right-side chat, full chat (the owner's work in progress, finished) |
| [#129](https://github.com/factory-level/inferos/pull/129) | [#28](https://github.com/factory-level/inferos/issues/28) | Kanban read metrics and a synthetic baseline |
| [#131](https://github.com/factory-level/inferos/pull/131), [#141](https://github.com/factory-level/inferos/pull/141) | [#20](https://github.com/factory-level/inferos/issues/20) | Wrapper verify, upgrade and recover with `files.json`; wrapper lockfile and port ownership |
| [#132](https://github.com/factory-level/inferos/pull/132) | [#73](https://github.com/factory-level/inferos/issues/73) | Shared gatekeeper conformance suite and the InferOps `connection.json` reference package |
| [#135](https://github.com/factory-level/inferos/pull/135) | [#11](https://github.com/factory-level/inferos/issues/11) | Router-path parity suite, parity matrix and preview smoke recipe |
| [#136](https://github.com/factory-level/inferos/pull/136) | [#60](https://github.com/factory-level/inferos/issues/60) | Pinned blueprint installs and explicit `upgradeInstall` |
| [#137](https://github.com/factory-level/inferos/pull/137) | [#75](https://github.com/factory-level/inferos/issues/75) | Three-way reconcile and reviewed upgrade branches |
| [#138](https://github.com/factory-level/inferos/pull/138) | [#74](https://github.com/factory-level/inferos/issues/74) | Connector scaffolder, a tickets connector, and manifest-gated wrapper gatekeepers |
| [#139](https://github.com/factory-level/inferos/pull/139), [#142](https://github.com/factory-level/inferos/pull/142) | [#63](https://github.com/factory-level/inferos/issues/63) | Use-role console screens; boards resolve through the operator's own InferOps account; console board and issue continuity |
| [#140](https://github.com/factory-level/inferos/pull/140) | [#61](https://github.com/factory-level/inferos/issues/61) | Semantic `findBoards` and a validated `openBoard` operate event |
| [#143](https://github.com/factory-level/inferos/pull/143), [#144](https://github.com/factory-level/inferos/pull/144), [#145](https://github.com/factory-level/inferos/pull/145) | [#64](https://github.com/factory-level/inferos/issues/64) | Operate subjects, handover and per-subject audit; presence; the Operate UI for them |
| [#146](https://github.com/factory-level/inferos/pull/146) | #63 | A workspace shared for use is listed for its collaborator as soon as it is shared |
| [#147](https://github.com/factory-level/inferos/pull/147) | [#59](https://github.com/factory-level/inferos/issues/59), #63 | Action outcomes announced from the action log, never inferred from a revision change; console recovery |
| [#149](https://github.com/factory-level/inferos/pull/149) | #60 | Version-specific install bindings, explicit upgrade checks and use-role resource-access failure coverage |
| [#150](https://github.com/factory-level/inferos/pull/150), [#152](https://github.com/factory-level/inferos/pull/152) | #63 | Identical creates join one pending action; reconnect, deleted-issue and pending-action recovery coverage |
| [#154](https://github.com/factory-level/inferos/pull/154) | #59, #63 | Reconnect opening status and accessible dialog Select portals |
| [#153](https://github.com/factory-level/inferos/pull/153), [#156](https://github.com/factory-level/inferos/pull/156) | #28 | Offscreen read deferral, per-column card windowing, explicit 200px pane preloading and paired browser measurements |

Issue status:

| Issue | State | Why |
| --- | --- | --- |
| [#20](https://github.com/factory-level/inferos/issues/20) Verify, upgrade and recovery skills | Closed | #131, #141 |
| [#64](https://github.com/factory-level/inferos/issues/64) Operate subjects, presence, handover and audit | Closed | #143, #144, #145 |
| [#73](https://github.com/factory-level/inferos/issues/73) Reference connection package and conformance suite | Closed | #132 |
| [#74](https://github.com/factory-level/inferos/issues/74) Connector scaffolder and second connector | Closed | #138 |
| [#75](https://github.com/factory-level/inferos/issues/75) Reviewed upgrades across customized repositories | Closed | #137 |
| [#11](https://github.com/factory-level/inferos/issues/11) Local-to-Cloudflare behavior | Deferred | Router-path parity is implemented; the Cloudflare smoke remains parked by the owner |
| [#28](https://github.com/factory-level/inferos/issues/28) Kanban performance | Closed: implementation and measurements | #129, #153, #156; windowing/preload browser proof and proposed local-fixture budgets in [Kanban performance](../architecture/inferops-canvas.md#kanban-performance); owner budget decision deferred to [#158](https://github.com/factory-level/inferos/issues/158), Wave 5; upstream paging/delta request [inferops#2335](https://github.com/factory-level/inferops/issues/2335) |
| [#60](https://github.com/factory-level/inferos/issues/60) Pinned install and explicit upgrade | Closed | #136, #149; all acceptance boxes covered by `operate-published.test.ts` and green CI. Container and Publish UI moved to design-first [#155](https://github.com/factory-level/inferos/issues/155), Wave 5 |
| [#63](https://github.com/factory-level/inferos/issues/63) Console context and continuity | Closed | #139, #140, #142, #146, #147, #150, #152, #154 and two live-provider browser runs; per-person identity stays with #59/#66/#23 |
| [#59](https://github.com/factory-level/inferos/issues/59), [#61](https://github.com/factory-level/inferos/issues/61) Integrated operating proof and chat (other milestones) | Open | The runs used stub-persona/shared-stopgap credentials and a scripted model; per-person identity and real-LLM proof are not established by the #63 closure |

Browser evidence: [first run](https://github.com/factory-level/inferos/issues/63#issuecomment-5976606582) and [second run](https://github.com/factory-level/inferos/issues/63#issuecomment-5977886294), at 1440 and 390 widths, record IDs/revisions, create/deny/approve, identical multi-tab proposals and reconnect recovery. Both reached live InferOps through the development stopgap; neither proves per-person sign-in. The second run’s accessibility findings are fixed by #154.

Owner-deferred, still open in milestone 4: **#11, #15, #16, #17, #68, #76, #77 and #78**. Each keeps its `deferred` label. Waiting on owner review (draft contract and design pull requests, not merged or modified by this closeout):

- [#130](https://github.com/factory-level/inferos/pull/130) agent artifact revision contract (ADR 0006) for [#15](https://github.com/factory-level/inferos/issues/15), [#16](https://github.com/factory-level/inferos/issues/16), [#17](https://github.com/factory-level/inferos/issues/17).
- [#133](https://github.com/factory-level/inferos/pull/133) agent deployment contract (ADR 0007, stacked on #130) for [#76](https://github.com/factory-level/inferos/issues/76), [#77](https://github.com/factory-level/inferos/issues/77), [#78](https://github.com/factory-level/inferos/issues/78).
- [#134](https://github.com/factory-level/inferos/pull/134) proposed publication destinations (ADR 0008) for [#68](https://github.com/factory-level/inferos/issues/68).

Implementation of #16, #17, #76, #77, #78 and #68 waits on those reviews.

Still deferred from Wave 3: one real signed-in Codex patch run for [#69](https://github.com/factory-level/inferos/issues/69) and [#72](https://github.com/factory-level/inferos/issues/72) (owner OK); Google sign-in for [#66](https://github.com/factory-level/inferos/issues/66) and [#23](https://github.com/factory-level/inferos/issues/23); the InferOps Wiki work behind [#82](https://github.com/factory-level/inferos/issues/82) and [#87](https://github.com/factory-level/inferos/issues/87) (factory-level/inferops#1607, #2324, #2325).

### Wave 5: External platforms and later tracks

The authorized research, design preparation and synthetic recipe work is complete. [#159](https://github.com/factory-level/inferos/pull/159) refreshes the capability inventory, the 12-area/36-workflow matrix and official-source ledger, audits the existing local ChatGPT companion, and adds proposed publication, policy and provider-neutral external-agent designs. [#160](https://github.com/factory-level/inferos/pull/160) adds reproducible synthetic wrapper recipes and an explicit proposal operator. Every merge requires both Lint and Build and test to pass at an unchanged, conflict-free head.

**Harness HG is entirely deferred by the owner.** No HG research, configuration, adapter, fixture, conformance or runtime-control work is in this wave. #81 remains parked in full, including its paired independent-client delivery. Existing deferred Wave 4 issues and draft PRs #130/#133/#134 are untouched.

| Track | Disposition | Evidence and requirement to resume |
| --- | --- | --- |
| [#30](https://github.com/factory-level/inferos/issues/30) Capability wiki | Closed on research acceptance | [Capability inventory](extension-capabilities.md), pinned baseline and dated [source ledger](research-sources.md); stale/product-note claims separated from implementation |
| [#31](https://github.com/factory-level/inferos/issues/31) Vertical matrix | Closed on research acceptance | [36 workflows across 12 areas](vertical-decision-matrix.md), three each, with surfaces, owner, authority, gap, proof and source; priority primary-source constraints refreshed |
| [#32](https://github.com/factory-level/inferos/issues/32) Recipes | Synthetic preparation delivered; open/deferred | [Runbook and local evidence](vertical-recipes.md); cloud proof (#11), customer/provider choices and actual domain operations remain |
| [#155](https://github.com/factory-level/inferos/issues/155) Operate container/Publish UI | Design delivered; implementation deferred | Review [publication design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Gadget%20Authoring%20Operate%20Widgets%20and%20Operate%20Apps.md%23Publication%20and%20installation%20review): container ownership, mock handling, migration/rollback; then separate kernel/UI slices |
| [#65](https://github.com/factory-level/inferos/issues/65) Roles/restricted data | Design and acceptance specifications delivered; enforcement deferred | Review [policy design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20IAM.md%23Approval%20roles%20and%20restricted-data%20policy): trusted policy source, identity/role mapping, action classes and provider restrictions |
| [#79](https://github.com/factory-level/inferos/issues/79), [#80](https://github.com/factory-level/inferos/issues/80) External-agent contract/auth | Provider-neutral design and specifications delivered; runtime deferred | [Contract proposal](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Agent%20Deployments.md%23Provider-neutral%20external-agent%20contract), linked to [inferops#2326](https://github.com/factory-level/inferops/issues/2326); actual delegation, schema, revision and retry agreement required; no bridge/SDK/auth endpoint |
| [#81](https://github.com/factory-level/inferos/issues/81) Harness HG and independent client | Entirely deferred | Explicit owner resumption required; no part silently carried into #79/#80 |
| [#12](https://github.com/factory-level/inferos/issues/12), [#13](https://github.com/factory-level/inferos/issues/13), [#14](https://github.com/factory-level/inferos/issues/14) Hosted ChatGPT | Local audit delivered; hosted work/live sign-in deferred | [Feasibility and audit](chatgpt-feasibility.md): 39 tests/166 assertions; official supported deployment, token custody, entitlement and owner live validation remain |
| [#29](https://github.com/factory-level/inferos/issues/29) Maps | Deferred | Provider/viewport choices and unresolved live performance validation |
| [#158](https://github.com/factory-level/inferos/issues/158) Kanban budgets | Deferred | Owner agreement against the recorded numbers; all ceilings remain proposed, not agreed |

The 19 JSON design scenarios are acceptance **specifications**, not executable policy/auth tests. The industrial and medical fixtures are scenario inputs, not adapters or compliance evidence. Three recipe wrappers were generated and exercised against one isolated synthetic stack on :28787: normal creation proposals, rejection preserving revision, approved state change, stale-revision refusal and browser rendering. The pinned runtime does not import wrapper fixture JSON; the explicit operator queues catalog titles and retains the existing demo board. No real model, provider, cloud deployment or per-person identity proof is claimed.

Milestone 5 remains open only for the eleven deferred issues above. Earlier unresolved identity and Wiki work is explicitly parked in #59/#82/#87 with its upstream/owner dependencies; none of this closes the MVP walkthrough.

## Epics

| Epic | Design |
| --- | --- |
| [#2](https://github.com/factory-level/inferos/issues/2) Cloudflare-like local development | [local-development](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20Deployment.md%23Local%20development) |
| [#3](https://github.com/factory-level/inferos/issues/3) Personal ChatGPT connection | [chatgpt-connection](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20IAM.md%23Personal%20ChatGPT%20connection) |
| [#4](https://github.com/factory-level/inferos/issues/4) Reusable native agent authoring | [agent-authoring](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Agent%20Deployments.md%23Agent%20deployments) |
| [#5](https://github.com/factory-level/inferos/issues/5) InferOS repository setup skills | [repo-setup-skills](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Repository%20setup%20skills) |
| [#6](https://github.com/factory-level/inferos/issues/6) Scoped real InferOps issue operations | [inferops-gatekeeper](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20IAM.md%23InferOps%20project%20gatekeeper) |
| [#7](https://github.com/factory-level/inferos/issues/7) MVP Kanban and live operational widgets | [inferops-canvas](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Consoles.md%23Screen%20requirements%20and%20delivery) |
| [#8](https://github.com/factory-level/inferos/issues/8) Vertical extension research | [vertical-extension-research](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Vertical%20extension%20research) |
| [#48](https://github.com/factory-level/inferos/issues/48) Local coding workflows | [local-coding-workflows](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20Deployment.md%23Local%20coding%20workflows) |
| [#51](https://github.com/factory-level/inferos/issues/51) Connection packages and reviewed fork updates | [connection-extensions](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Connection%20packages%20and%20reviewed%20updates) |
| [#52](https://github.com/factory-level/inferos/issues/52) External-agent platform integrations | [agent-platform-integrations](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Agent%20Deployments.md%23External-agent%20platform%20integrations) |
| [#53](https://github.com/factory-level/inferos/issues/53) Native agent deployments | [agent-deployments](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Agent%20Deployments.md%23Native%20deployment%20lifecycle%20review) |
| [#55](https://github.com/factory-level/inferos/issues/55) One useful Operate view | [operate-mode](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Operate%20and%20Build.md%23Repository%20Operate%20baseline) |

Customer capability flags are specified in [feature-capabilities](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Feature%20Flags.md%23Capability%20contract%20and%20migration%20review) (#33) and consumer configuration in [consumer-configuration](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Feature%20Flags.md%23Consumer%20configuration) (#33 to #36).

## Release evidence

Closing a feature issue requires its stated checks and an updated architecture document. #1 separates unit and fake-fetch tests, local integration, signed-in provider proof and cloud-only checks; each is reported as what it is. A mock or fake is not a live-provider proof, a local proof is not a deployed-origin proof, and a merged pull request is not a checked walkthrough step. ChatGPT plan usage on Cloudflare stays gated by its feasibility issue (#12) and is never silently replaced with API-key billing.

## Documentation validation

Run `pnpm docs:check` and `git diff --check`. These checks validate document structure only; they imply no feature build, provider integration or deployment.
