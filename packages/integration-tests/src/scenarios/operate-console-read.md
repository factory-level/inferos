# Scenario `operate-console-read`, version 1

One programmed read of a registered widget's tool on a published console (MVP-31). It is played
through the real Workshop's `POST /api/operate/agui/console` endpoint
([wire contract](../../../workshop-backend/src/operate-agui-console.md)) by the unmodified
`@ag-ui/client` 1.0.2 `HttpAgent`. It is one concrete local example, not a scenario format or
runner. Its data is [`operate-console-read.ts`](operate-console-read.ts). Change a fixture input or
an expected result there and bump `version`. The report and verdict rules come from
[`scenario-report.ts`](scenario-report.ts), shared with the read and approval scenarios.

## Run it

```sh
pnpm --filter @gadgets/integration-tests exec vitest run __tests__/operate-console-scenario.test.ts
```

It boots the Workshop (with gadget execution) and the InferOps gatekeeper Worker on `127.0.0.1`
with `wrangler`'s `createTestHarness`. `COMPOSABLE_VIEWS`, `DURABLE_VIEWS` and `CONSOLE_TOOLS` are
set in that disposable harness only, as in `operate-console-tools.test.ts`. No credentials and no
external network are used: an outbound request nothing answers in process fails the run. The same
file runs in `pnpm test` and CI.

It writes a JSON report to `packages/integration-tests/.wrangler/tmp/scenario-reports/operate-console-read-v1.json`
(or the path in `OPERATE_SCENARIO_REPORT`). The report names:
- the scenario version, the tested commit and whether the tree was dirty;
- the fixtures and the mocked and real boundaries;
- the isolation check;
- each case's observed results, with no ids;
- the verdict.

The verdict is PASS only when all five cases pass in order and the isolation check ran and found no
unanswered request. The run fails rather than write a report containing a minted session token or
an InferOps token. `source` is always `mock` and `liveProviderProof` always `false`.

## Boundaries

Programmed:
- the model's replies (a scripted stream; text starts with `[mock model]`);
- the InferOps and InferLab provider answers (`InferOpsFake`; the console's board is a reference only and no board data is read);
- synthetic accounts.

Real code:
- Workshop sign-in and the bearer session;
- the operator's `use` role in the console workspace;
- the widgets, built from authored files, frozen and published on consoles through the Workshop;
- AG-UI preparation and the console endpoint;
- the stock client;
- console discovery and the C6 `callConsoleTool` gateway, the tool lane and the untrusted frame;
- the `consoleRead` projection and `inferos.console-boards.v1` activity;
- publication revision checks and invalidation;
- chat history, run admission and replay refusal.

Nothing here is per-person live identity, a live InferOps, or a real model.

## Fixtures and initial state

A builder publishes two widget blueprints:
- `Counts`, with one read tool, `count`, which answers `{n: 3}` for status `open`;
- `Other`, with one read tool, `other`, which answers `{n: 9}`.

They go on two consoles, each with one view of the same screen, which places the board
`inferops://acme.operations/project/board/ENG`: console A offers `Counts`, and console B offers
`Other`.

Each read case adds a fresh `use` collaborator whose Operate page opens console A at its current
published revision, then prepares one console read with `POST /api/operate/agui/prepare` (checked: 200,
`Cache-Control: no-store`, `or2:<generation>:t|r:<uuid>` selectors). The user message is always
`Read the published console.`

## Cases and expected results

1. `loopback-only`: the helper refuses any target that is not plain HTTP on `127.0.0.1`, `localhost`
   or `[::1]`, and the harness target passes.
2. `console-read`: the model lists the console's tools, calls `count` with `{status: "open"}`, calls
   console B's widget, then replies.
   - The stream starts `RUN_STARTED` and ends with one `RUN_FINISHED`.
   - `consoleRead.snapshot` describes exactly one widget, console A's, through `callConsoleTool`, with
     its authored text framed and only the `count` tool. Console B's label appears nowhere.
   - The activity is `inferos.console-boards.v1` with the placed board.
   - Each of the three calls has `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` and
     `TOOL_CALL_RESULT`.
   - `count` returns its output framed as untrusted widget output, `{n: 3}`.
   - Console B's widget is refused with `Console … does not offer widget N.`, before it runs.
   - The committed history record equals the wire result.
   - Later requests still offer only `callConsoleTool`, `listConsoleTools` and `operatePage`, and no
     action is created.
3. `console-read-repeat`: the same from another fresh operator gives identical observed results.
4. `replay`: resubmitting that run's selectors is refused 409, with no new model request (so no new
   tool invocation) and the chat history unchanged.
5. `stale-republish`:
   - A third console, published with the same widget, is opened, and its read's only model call is
     held. While held, the builder republishes that console.
   - The `consoleRead` snapshot becomes `null` and the board activity `{console: null, boards: []}`.
   - Once released, the call to the old frozen widget is refused with
     `Console … has changed since it was opened.` and recorded as an error, with no output.
   - The run ends with `RUN_FINISHED`.

Waits are bounded on observable conditions, never fixed sleeps. Only the report's comparison leaves
dynamic ids out.

## Not covered

Other fault paths, such as delete, revoke and page close, subject presence and taint, stay with
`operate-console-tools.test.ts`. Also out of scope:
- widget writes, approvals and any implicit policy;
- new roles;
- a browser or the Workshop UI;
- a deployed instance, a live InferOps or a real model;
- generic sanitization claims.
