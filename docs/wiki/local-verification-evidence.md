---
title: Consumer local verification evidence
updated: 2026-10-01
---

# Consumer local verification evidence

Evidence from a real generated wrapper, separated from the full bootstrap acceptance criteria. This verification does not close the overall goal.

## Steps executed

1. Bootstrapped `/tmp/inferos-consumer-proof` from the actual local InferOS repository at `1045d2e1ceac7be29e1a6f056c936fb31aa00851`.
2. Ran the generated `setup` command. The frozen pnpm 11.17.0 install completed for all 32 workspace projects (717 packages).
3. Attempted native startup on 8787. An unrelated existing service already owned that port. The test consumer was stopped; the existing service was not changed.
4. Set the disposable wrapper's `local.port` to 18787 and started again. The frontend build and all configured local Workers completed startup. Browser navigation returned the login page and `/api` upgraded to WebSocket.
5. Created a synthetic local admin account, completed onboarding without a model or external connector, and reached the authenticated Workshop home. The automation's coordinate clicks did not advance the wizard; invoking the same buttons' DOM handlers did. Physical pointer behavior across that wizard is therefore not proven by this run.
6. Stopped the owned test consumer. Applied only the working-tree local-development script patch to its submodule and restarted. This second run is explicitly a modified-checkout proof, not an exact-revision proof.
7. Confirmed generated `wrangler.dev.jsonc` assigns ASSETS to the public router, retains production worker-first API/gatekeeper paths, and leaves the backend without an assets binding.
8. Reopened the browser after restart. The authenticated home and local admin controls remained available; no new signup/onboarding was required. Screenshots were inspected and browser error collection returned no entries.

## Findings implemented

The consumer runtime now checks IPv4 and IPv6 loopback port availability before builds. A conflict returns an actionable instruction to change `local.port`, without touching the other listener. The check is a preflight, not a reservation: startup still needs to handle a subsequent race.

Configuration diagnostics now report `modifiedUpstream`; matching Git HEAD and index alone no longer imply that the running files are unchanged.

The source run-local flow now derives ASSETS ownership, SPA fallback and worker-first paths from the canonical production router configuration. This eliminates the separate backend-owned local assets configuration. A wrapper pinned to the older baseline needs a reviewed newer pin to receive this change.

## Automated evidence

- `node --test scripts/dev-server-config.test.ts scripts/consumer/bootstrap.test.ts`: 20 tests passed, including recursive cloning, edit preservation, failed-create cleanup, Git drift, modified-checkout reporting, occupied-port handling, and router asset configuration.
- `pnpm types:scripts`: passed.
- `pnpm configs:check`: passed; canonical generated configs remain synchronized.
- Focused lint: passed after resolving the callback-name warning.
- `pnpm docs:check` and `git diff --check`: passed.

## Completion audit

| Requirement | Evidence state |
| --- | --- |
| Forkable pinned wrapper | Fresh creation and recursive clone tested |
| Native local environment | Real dependency install, builds, workerd startup and browser page verified |
| Local account state survives restart | Authenticated home/admin controls remain available after restart |
| Local/router asset parity | Code, focused tests, generated configuration and restarted browser verified |
| Semi-configured InferOps data model | Synthetic wire fixture exists; runtime data adapter still missing |
| Composable views | Configuration/design/issues exist; runtime feature missing |
| Durable views | Configuration/design/issues exist; scoped storage/recovery feature missing |
| Applied profile and styling | Local profile initialization and theme fallback verified through RPC/jsdom; density remains pending |
| Wrapper-owned custom Cloudflare code | Explicit local Worker launch and enabled/disabled routes verified on a clean pin; cloud packaging remains pending |
| Live InferOps gatekeeper | Contract and implementation issues remain open |
| Agent authoring and activity | Native mechanisms researched; reusable authoring/canvas activity work remains |
| Personal Cloudflare ChatGPT subscription | Eligibility and approved target topology unresolved |
| Full cloud parity | No cloud deployment or live provider verification performed |

See the [roadmap](implementation-roadmap.md) and [consumer design](../design/consumer-configuration.md) for the remaining work. A healthy native home page is not a substitute for the required InferOps board read/propose/approve/refresh flow.

## Consumer doctor verification

The new doctor implementation was run against the same disposable consumer after the local server had stopped. It verified Node 22.22.3, pnpm 11.17.0, required native scripts, local build tools and available port 18787. The report returned `ok: true`, warned about the modified submodule and pending data/profile/style adapters, and returned `runtimeReady: false`. This adds preflight evidence; it does not extend the prior browser proof to the unfinished InferOps experience.

## Wrapper-owned blueprint verification

The disposable consumer was given copies of the standard blueprints plus a new `consumer.proof` blueprint under its own `blueprints/` directory. The updated copied runtime launched the native runner with that directory selected. Frozen-lockfile installation succeeded. A synthetic local user completed onboarding without a model or external connector, found **Consumer Source Proof** in Explore alongside the standard formats, created a gadget from it, and saw **Wrapper source loaded** rendered inside the Gadget UI iframe. This proves source selection, native packaging/installation, discovery, instantiation and rendering for a wrapper-owned blueprint. The test does not exercise InferOps transactions, composable views or custom Workers. As before, onboarding used DOM button handlers, so pointer behavior across the wizard is not proven.

The focused suites passed 26 tests covering clone/rerun preservation of customized blueprint files, empty-wrapper fallback, linked-root rejection, real compilation of external sources, invalid edits followed by repair, preservation of the backend generated module, router topology and build-environment declarations. Script type-checking and focused lint also passed.

A fresh actual-repository wrapper at `/tmp/inferos-blueprint-bootstrap-proof` also passed pin validation with `modifiedUpstream: false` and contained all three copied standard formats plus the documented `blueprints:check` command. The browser screenshot of the separate runtime test was inspected, its error list was empty, and its browser/server were stopped after verification (server termination exit 143). The runtime test still used the earlier modified-submodule overlay; it is not a clean shipped-revision proof.

## Administrator profile initialization

The real Workers/RPC integration suite exercises `AdminApi.initializeProfile` with concurrent initial requests, rejects over-limit site names/instructions, verifies that a non-admin receives no admin capability, and reconnects after administrators reset both fields to prove the initialization marker survives independently of those values. The operator command was also launched as a Node subprocess against the harness: a fresh deployment received `InferOps Workspace` and the operations profile instructions; a deployment with prior branding returned `preserved` without partially applying instructions. Captured output did not contain the synthetic administrator session. Three integration cases and the 14 existing admin-config tests passed. This proves the local command and native settings path, not cloud application, density/theme defaults or a full operations profile.

## Deployment fallback theme

Profile initialization now sends the consumer theme and the public server config returns the persisted default. Four real Workers/RPC tests passed, including invalid theme input and preservation of a prior non-system deployment theme. Ten frontend theme/editor tests passed: delayed deployment configuration applies without writing a browser preference; explicit system/light/dark choices win; system-theme changes update the DOM; invalid/unavailable storage falls back correctly; session choices survive storage failures. The 14 admin-config tests, workspace build, final affected-package type checks and focused lint passed. This is RPC and jsdom evidence, not a new browser visual/contrast audit. Density and the admin-panel default-theme control remain pending.

## Committed consumer verification

A fresh wrapper at `/tmp/inferos-committed-consumer-proof` was created from implementation commit `0e282e2144edbac404bcb83d52a5c814121be9e8`, with local port 18789. Frozen dependency installation succeeded, pin validation reported `modifiedUpstream: false`, the consumer preflight passed, and the pinned native compiler validated all three wrapper-owned blueprints. No source overlay was applied. This proves clean-pin setup and preflight, not a new browser launch or cloud deployment.

Use `pnpm run doctor` explicitly: bare `pnpm doctor` selects pnpm’s built-in diagnostics. The generated instructions now use explicit `run` for both setup and doctor. The preflight continues to report `runtimeReady: false` because InferOps data/view adapters remain pending.

## Listing density implementation

The profile operator now sends configured density to the existing administrator initialization capability. All five real Workers/RPC profile cases passed, including invalid input, compact initialization, later administrator changes observed after reconnect, and preservation of an already customized density. Backend/frontend/integration builds and focused lint passed. The frontend maps compact to desktop workspace-row and Explore card/list spacing using existing Tailwind utilities. This turn did not run a browser layout/keyboard audit; CSS source and successful compilation do not substitute for that visual evidence. Previously initialized deployments need an explicit administrator density update; rerunning initialization never overwrites them.

## Clean-pin custom Worker activation

A fresh wrapper at `/tmp/inferos-worker-verified` pinned `a69999e2b143c33ed59b838d36cd8ef29a5a7902` and enabled `customCloudflareCode` on port 18791. Frozen setup, canonical extension validation and consumer doctor passed with `modifiedUpstream: false`. Its ordinary `pnpm dev` command built and started the native multi-Worker environment. A real browser showed the Workshop login page; its screenshot was inspected and the browser error list was empty. The same origin returned 200 with `{"message":"Hello from the consumer Worker"}` at `/extensions/hello` and `/extensions/hello/nested`; an unlisted route returned 404.

After stopping that runtime, changing only the feature flag to false and restarting through the same command, the Workshop still rendered and a browser fetch of `/extensions/hello` returned 404. The wrapper's Worker source remained intact. Both runtime handles terminated with signal exit 143 after deliberate cleanup, and the browser was closed. This proves enabled/disabled local behavior through actual Wrangler/workerd and the public router, not cloud deployment or authenticated custom endpoints.

The initial clean-pin attempt exposed a scaffold import that traversed one directory too far. It was corrected before the successful proof, and bootstrap tests now import the generated canonical config and check preservation of Worker source through rerun/recursive clone. Eleven focused bootstrap/blueprint/extension tests, 13 workerd router tests, script type checking, router build and focused lint passed. The release manifest golden change was reviewed: it only reserves `/extensions` and `/extensions/*` for Worker-first routing; all 11 manifest tests then passed. No cloud deployment or provider connection was performed.

## Guarded canvas contract

Five pure-engine tests passed: detached validation, registered-only content, layout/move semantics, atomic failure, large decimal revisions, stale-editor conflict, add/remove and restore, unknown operation rejection and structural limits. Two starter-file tests reject duplicate view IDs, extra ownership fields, links, executable files and oversized input. Four bootstrap tests verify the starter target matches configuration while preserving prior wrapper customization behavior. Shared-package build, script type checking and focused lint were run. These tests prove the composition contract and source validation, not a rendered board, persisted concurrent edits, resource authorization or runtime flag support.

A fresh consumer at `/tmp/inferos-view-contract-proof`, pinned to `e3033598d5535bde51ab76bd35939a381589ae13`, ran its generated `pnpm views:check` successfully and reported the `operations` definition. Its pin check reported `modifiedUpstream: false`. No upstream dependency install or server launch was needed for this pure source validation. This is separate from the preceding custom-Worker browser proof at its recorded revision.

## Native durable definition storage

The workspace build passed after adding five documented Overseer methods and a workspace-local typed-storage collection. Six real Workers/RPC/use-role tests passed. They verify both installation gates, concurrent expected-revision edits with exactly one winner, failed-batch rollback, workspace isolation, outsider denial, owner/build access, use-only denial, the 64-definition quota, revision-checked deletion and a fresh identity on recreation. The tests reconnect through a new browser-style RPC transport and recover the saved definition.

A separate test reloads the actual Workers through the harness configuration update API: disabled durable views reject read/delete, then re-enabled Workers return the unchanged saved definition. This proves retention across Worker reload and flag disable/re-enable. It does not prove OS/process crash recovery, cloud deployment, resource dereference authorization or a rendered canvas. The consumer still rejects its view flags while renderer/data/installation wiring is pending.

## Saved canvas browser proof

A fresh consumer at `b31250aa831f2cc27078e2ef5b7c1cc516f2bf46` ran frozen setup and native development on port 18793 with composable and durable views enabled. `inferos:check` reported `modifiedUpstream: false`. Browser signup created a synthetic local account; authenticated RPC completed onboarding and created an empty workspace without a model provider. This does not verify the provider-onboarding wizard.

The visible Canvas button opened the Kumo dialog. Importing the generated `views/operations.json`, renaming it to Dispatch board and selecting two columns succeeded. After a full browser reload, reopening Canvas recovered the title and selected two-column layout from storage. Board cards displayed the configured reference and explicit unconnected state. Browser errors were empty. Escape closed the dialog and returned focus to the Canvas button. Screenshots were inspected locally; the test browser and native server were stopped afterward.

Focused verification for this slice: four frontend state/race tests, five native Workers canvas tests, eleven bootstrap/extension/view tests, frontend production build, script types, focused lint and documentation checks passed. Initial sandbox-only build/port checks required the normal escalated local-test execution. This proves saved composition UI on a clean pin, not board data access, Kanban transactions, agent tools, cloud deployment or complete operational readiness.

## Profile resolution and default bootstrap

A fresh consumer at `02d6d3b2327904426e0c190caf559f5741bee419` passed its generated `inferos:check` and `views:check` commands with `modifiedUpstream: false`. The generated operations snapshot enabled both view flags, disabled custom code, selected compact density and system theme, and reported each materialized field as an explicit override. No server was started for this parser/default-only follow-up; the saved-layout browser proof above covers the same enabled flag combination.

Fifteen focused configuration/bootstrap/extension/view tests passed. They cover base/profile/override precedence, explicit false, dependency validation after inheritance, invalid overrides, preservation of fully explicit legacy values, recursive clone and generated CLI provenance. Script type checks, focused lint and docs checks passed. New defaults do not initialize administrator settings automatically or load InferOps records.

## Canonical board fixture proof

The board JSON Schema was generated and checked without drift from a clean isolated InferOps checkout at `29b01a024c377b9c37b8754e7001b290e15d1509`, using its frozen dependencies. The existing sibling checkout had unrelated tracked edits and was left untouched. The generated schema records its source and covers the complete canonical BoardResponse wire shape, including lease/run fields.

A fresh consumer at `6bb215f0ad9d6911d599117949088dab4e0d7496` passed frozen setup, its generated fixtures:check command and doctor on port 18795, with a clean submodule. Replacing a string revision with a number made both fixture validation and dev fail before the native startup branch. The fixture was restored in a finally block. No server or browser was started for this validation-only proof. Nineteen configuration/bootstrap/extension/view/fixture tests, script types, focused lint and documentation checks passed. Fixture validation does not load records into Canvas or prove the pending InferOps gatekeeper/data adapter.
