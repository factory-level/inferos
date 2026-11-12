---
title: Governed widgets launch gate evidence (FAC-15)
updated: 2026-11-12
---

# Governed widgets launch gate evidence (FAC-15)

The release evidence for governed React/Refine widgets: one approved authored widget through the whole loop (creator → Gadget → InferMind → Operate → agent), the security regression around it, and the gaps that stay open. **This page stops at "ready for go/no-go": Calvin decides.**

## Go or no-go

**Recommendation (Calvin decides).**

- **Scope A, authored React/Refine widgets with their own local data, no governed data: GO, with the conditions below.**
  - Every step of the loop runs on the real product path, and the regression around it holds.
  - The open gaps (R-4 and R-3, below) can only move data the widget itself holds, and today that's never governed data.
- **Scope B, governed data inside an authored widget's frame: NO-GO.**
  - It isn't built (G-1).
  - Two known P0 gaps would let a widget move governed rows to another viewer or outside the frame (R-4, R-3), which ADR 0013 itself calls a no-go.

**Conditions for A** (each is a no-go blocker for B):

| Known P0 gap | What's true today | Safe only while | Closes it |
|---|---|---|---|
| **R-4: a console install's own server state is shared across operators** (inferops ADR 0013, W3: "no writable state shared between viewers of a data widget"; "rows reach another viewer by any route" is a no-go) | A published console's widget is one frozen install for every operator, so its own server (its Gadget Durable Object) holds one state. Operator B reads what operator A wrote. Characterized by "known P0 gap (ADR 0013 W3)…" in `integration-tests/__tests__/wiki-embedded-widget.test.ts` (#468). | no governed data reaches a code-running widget (G-1) | Per-operator Gadget partitioning, then inverting that test |
| **R-3: the frame's outward paths 3 and 4** (ADR 0013 "Outward paths from a frame"; "any route left open" is a no-go) | **Path 3 is open:** a widget can navigate its own frame to an outside URL. Characterized by "known P0 gap (ADR 0013 outward path 3)…" in `GadgetUI.request-probes.test.ts` (#470), in real Chrome. **Path 4 (`window.open` on a click) is not characterized:** headless Chrome showed no request even with a click proven to reach the widget's handler, but the sandbox allows popups that escape it (`GadgetUI.tsx`), so **treat it as open**. Path 5 (forms) is closed. | the same: G-1 | A sandbox and CSP change for navigation and popups, which is a product decision (links need popups), then inverting the path 3 test and adding a headed-browser probe for path 4 |

**Mitigations in force today:**
- publishing a widget needs `configuration:publish` in InferOps (an Administrator's grant);
- installs are frozen and reviewed at publication;
- the frame sees no governed data;
- `connect-src 'none'` and the rest of the frame CSP block the request APIs (paths 1 and 2) and forms (path 5).

## What ran, and where

| What | Commit | Kind |
|---|---|---|
| The scenario's clean evidence run | inferOS `48ee0bf1` (#466's head), squash-merged to main as `3c11c9db` | local, `wrangler createTestHarness` |
| The scenario on main, after the S2 and S3 PRs | main SHA: **pending** (#468, #470) | local |
| InferOps pinned by the gatekeeper | `custom-gatekeepers/gatekeeper-inferops/connection.json`, `9734f61a1` | not run: the scenario programs InferOps (`InferOpsFake`) |
| CI | each PR's passing run on its final head, linked below; **pending** for #470 | CI |

The FAC-15 PRs:
- #465 (`b917e6c6`): the Refine closure fix. CI: [https://github.com/factory-level/inferos/actions/runs/43201698115](https://github.com/factory-level/inferos/actions/runs/43201698115) at `f9385638`.
- #466 (`3c11c9db`): the scenario. CI: [https://github.com/factory-level/inferos/actions/runs/43205349077](https://github.com/factory-level/inferos/actions/runs/43205349077) at `48ee0bf1`.
- #467 (`45bb541a`): surface parity. CI: [https://github.com/factory-level/inferos/actions/runs/43204603236](https://github.com/factory-level/inferos/actions/runs/43204603236) at `27055b7c`.
- #468 (`01c5ea75`): red-team R-6 and R-4. CI: [https://github.com/factory-level/inferos/actions/runs/43209356824](https://github.com/factory-level/inferos/actions/runs/43209356824) at `f22b53e8`. Its first attempt was killed at 900 s on `account-subject.test.ts`, a hang main's own runs show too; the rerun passed.
- #470 (pending): R-3, the probes required in CI, and path 5 pinned on the CSP alone.

## The scenario: `widget-launch-gate` (version 2)

The contract is `packages/integration-tests/src/scenarios/widget-launch-gate.md`, and the runner is `__tests__/widget-launch-gate-scenario.test.ts`.
- **Programmed:** InferOps and InferLab (`InferOpsFake`), and the model (a scripted router; no live model calls).
- **Everything else runs real code.**
- **Isolation:** only the harness's own origin may use the real network.

**The report at `48ee0bf1`:** verdict **PASS**, `dirty: false`, isolation checked, **0** unmocked requests, `source: "mock"`, `liveProviderProof: false`.

| Case | Shows | Observed |
|---|---|---|
| `loopback-only` | non-loopback targets refused | 4 refused |
| `generate` | the React/Refine TSX widget is compiled on the server when its blueprint is published (authored as TSX only; the Worker's only compiler is the build Durable Object's) | `client.tsx`, `server.js`, `tools.json`; no authored `client.js` |
| `publish` | a console publication lists it in InferOps' widget index as the publisher (who holds `configuration:publish`), with its declared command bound to the console's own board | 1 index entry; `moveIssue` bound |
| `find` | the operator's own widget search finds it | found (keyword ranking: the fake's) |
| `embed-resolve` | the kernel embed path a Wiki embed calls resolves the published instance and serves its compiled bundle (no Wiki page renders it here) | available; **371,046** bytes compiled |
| `embed-operate` | a placement on the operator's own canvas | 1 placement |
| `agent-read-filter` | the operate agent finds, describes and filters it; the filter lands in the overlay only | found, described; placements unchanged |
| `agent-act` | the declared command waits for a decider of the console's workspace (not the asker), then applies once; a second approval is refused | pending 1, writes 0 → 1; second approval refused |

## Red-team regression

| Category | Proven by | Note |
|---|---|---|
| Direct HTTP or a custom provider (R-2: a declared extra method refused **not run**, below) | `GadgetUI.request-probes.test.ts` (real Chrome; **required in CI by #470**), `GadgetUI.integration.test.tsx`, `governedDataProvider.test.ts`, `gatekeeper-lookup.test.ts` (a connector session's extra method is unreachable), `widget-tools.test.ts` (a command outside the kernel's templates is refused), `inferops-isolation.test.ts`, `rpc-target-validation.test.ts` | Outward paths 3 and 4: see the go/no-go |
| Unsafe imports | `authoring-compiler.test.ts`, `authored-widget-build-runtime.test.ts` (an edge outside the reviewed closure, and an unlisted browser-field disabled module, are refused; #465), `authored-widget-build.test.ts` | |
| Cross-user and cross-company leaks | `widget-placements.test.ts`, `personal-state-partition.test.ts`, `agent-widgets.test.ts`, `console-commands.test.ts`, `temporary-canvases.test.ts`, `wiki-embedded-widget.test.ts`; inferops `widget-definitions.integration.test.ts`, `widget-retrieval.integration.test.ts`, `rls-isolation.integration.test.ts` | Cross-*operator* via a widget's own server: **R-4**, a known P0 gap |
| Cache or subscription reuse (R-5: two people through a widget **not run**, below) | `gatekeeper-kit/__tests__/cache.test.ts`, `workerd/conformance.test.ts` (repartition on reconnect), `OperateSessionPage.reconnect.test.tsx`, `wiki-embedded-widget.test.ts` | Known: the governed cache isn't discarded when a connection is removed (#409) |
| Revoked grants | `governed-table.test.ts`, `governed-queue.test.ts`, `account.test.ts`, `operate-console-widget-index.test.ts`, `console-commands.test.ts`, `wiki-embedded-widget.test.ts`; **new (#468):** a revoked role ends the agent's widget reads mid-session (`agent-widgets.test.ts`) | |
| Preview side effects | `authored-widget-publish-flow.test.ts`, `authored-widget-preview.test.ts`, `AuthoredWidgetPreview.test.tsx` | |

### Planned red-team tests not run (S2 part 3)

The plan's S2 part 3 wrote no new tests. What exists today, and what stays unproven:

| Planned | Existing test | Not run |
|---|---|---|
| **P-2:** the Dot's two deciders | gatekeeper-inferops `dot.test.ts`, "settles one InferOps says was decided to what it is": a proposal declined in InferOps is not applied by an approval in InferOS | Nothing: covered. |
| **R-2:** a custom gatekeeper's extra methods or commands | `gatekeeper-lookup.test.ts` ("offering only the governed methods": an extra method is unreachable); `widget-tools.test.ts` (reserved methods; a command outside the kernel's templates is refused) | **A test where a custom gatekeeper declares an extra method or command and is refused.** Today it's shown unreachable, not refused. |
| **R-5:** a cached query or rendered widget never reused across two people | `gatekeeper-kit/__tests__/cache.test.ts` ("does not serve an entry written under another authority"; "does not share an in-flight load across a reconnect") | **Two people in one session or worker, through a widget.** The tests cover the gatekeeper's governed cache, not that path. Also known: the governed cache isn't discarded when a connection is removed (#409). |

## Parity across surfaces

- **One decision path.** Approval, rejection, failure and revocation go through the kernel's `approveAction`/`rejectAction` (with `withActionClaim`) and one outcome vocabulary (`action-outcome.ts`).
- **The shared approve-again rule.** `canApproveAgain` is used by Activity, the chat card and the Operate approvals panel.
  - **#467:** the notification dropdown offered Approve for an attempted, non-retryable action the others withhold. The kernel refused it anyway, so no authority was gained. It now applies the same rule, and a test covers it.
- **The Dot's two deciders:** a proposal declined in InferOps isn't applied by an approval in InferOS, and one InferOps made is recorded as made (gatekeeper-inferops `dot.test.ts`).
- **A Wiki embed decides nothing:** it shows no decision control, and asks its workspace only to resolve and open the widget (#467).

## Runtime logs, audit trail, cost and limits

- **Runtime logs:** gatekeeper observations (each read) and actions (each write), the action journal and receipts.
  - **Gap E-1:** there are no widget-level telemetry events (publish, search, render, act) in either repo.
- **Audit trail:**
  - the action journal, with who asked and on whose behalf, and its receipts;
  - `Overseer.exportWorkspaceRecords()` (widget installs and action audit, hashed and bounded);
  - InferOps records `published_by` on widget definitions.
- **Limits in force:**
  - the compile caps: 1 MiB, 256 KiB per file, 100 files, 10 s;
  - `widget.search` k ≤ 20;
  - `WIDGET_PLACEMENT_LIMITS`;
  - governed lists ≤ 200 rows;
  - `DAILY_AGENT_TURN_LIMIT` and `MODEL_ALLOWLIST` on dev.
- **Observed:** the compiled Refine bundle is 371,046 bytes. The local runs made no model calls (the model was scripted).
- **Gap E-2:** load time and CI minutes aren't measured. ADR 0013's table asks for them.

## Deployed proof (dev-os): preconditions for the manager

These steps aren't run, and need the Cloudflare Access service token (`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`):
1. **E-3:** dev-os sets neither `AUTHORED_WIDGET_BUILD_ENABLED` nor `CONSOLE_TOOLS` (`scripts/stage/stage-config.ts`). Authored builds and console tools are off there until the manager turns them on and redeploys.
2. **The stage smoke:** FAC-145's `scripts/ci/stage-smoke.ts` (nine oracles) is in progress. Until it lands, the deployed smoke is pending FAC-145.
3. **A GrokBot run on dev-os** (operate@grokbot, in a test company): publish a Refine widget, find it, place it, and have the operate agent request its command and wait for a decider.

## Known gaps

**G-1:** governed data inside an authored widget's frame isn't built.

**G-2:** the agent's act is a declared command on the board connection, not the widget's own governed command.

**R-4 and R-3:** above.

**E-1 to E-3:** above.

**Search:** the scenario's fake ranks by keyword, so real embedding ranking isn't exercised.

**Not a live, deployed or browser proof of the whole loop:** the scenario is mock; the probes are real Chrome.

**Path 4:** needs a headed-browser probe.
