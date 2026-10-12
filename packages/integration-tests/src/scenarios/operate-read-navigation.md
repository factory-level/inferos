# Scenario `operate-read-navigation`, version 1

One programmed Operate read/navigation interaction (MVP-31), played through the real Workshop's
AG-UI 1.0 endpoint by the unmodified `@ag-ui/client` 1.0.2 `HttpAgent`. It is one concrete local
example, not a scenario format or runner for other scenarios. Its data is
[`operate-read-navigation.ts`](operate-read-navigation.ts); change a fixture input or an expected
result there and bump `version`.

## Run it

```sh
pnpm --filter @gadgets/integration-tests exec vitest run __tests__/operate-read-scenario.test.ts
```

It boots the Workshop and the InferOps gatekeeper Worker with `wrangler`'s `createTestHarness` on
`127.0.0.1` and needs no model, cloud, Google or InferOps credentials. Every outbound request is
answered in process; an unanswered one fails the run. The same file runs in `pnpm test` and CI.

It writes a JSON report to `packages/integration-tests/.wrangler/tmp/scenario-reports/operate-read-navigation-v1.json`
(or the path in `OPERATE_SCENARIO_REPORT`), and prints a one-line summary. The report names the
scenario version, the tested commit and whether the tree was dirty, the fixtures, the mocked and real
boundaries, each case's observed results and a PASS/FAIL verdict. It holds no bearer token (the run
fails rather than write one), credential or real personal data. `source` is always `mock` and
`liveProviderProof` always `false`: a mock result never closes a live acceptance criterion.

## Boundaries

Programmed: the model's replies (a scripted OpenAI-compatible stream; every text reply starts with
`[mock model]`), the InferOps and InferLab provider answers (`InferOpsFake`'s synthetic board and
sign-in) and the synthetic password accounts. Nothing here is per-person live identity.

Real code: Workshop sign-in and the bearer session, `POST /api/operate/agui/prepare` and
`POST /api/operate/agui`, the stock client, the InferOps gatekeeper connection and its board
permission check, Operate navigation and its event log, chat history, run admission and replay
refusal, and the read-only `operatePage` policy.

## Fixtures and initial state

Each case starts from a fresh account, workspace and Operate session, checked before it starts:
session sequence 0, no session events, no chats, no board. The read cases also connect InferOps as a
fake person holding the `operations` workspace and add the board
`inferops://acme.operations/project/board/ENG` to the workspace. The user message is always
`Read the board I just opened.`

## Cases and expected results

1. `loopback-only`: the helper refuses any target that is not plain HTTP on `127.0.0.1`, `localhost`
   or `[::1]`, and the harness target passes.
2. `read-navigation`: prepare, then run with `forwardedProps.operate` opening the board at
   `expectedSeq` 0, the model reading the page with `operatePage` and answering
   `[mock model] The ENG board is open on your page.`
   - The stream starts with `RUN_STARTED`, ends with exactly one `RUN_FINISHED`, and carries state,
     messages, tool-call and text events.
   - The client state is at sequence 1 on the board. The session log has one `openBoard` by the
     person. The history has the one user message, the `operatePage` call and the reply.
   - Every model request offered only `operatePage`.
   - Resubmitting the same selectors is refused 409 `RUN_ALREADY_RESERVED` and changes nothing.
3. `read-navigation-repeat`: the same run from another fresh fixture gives identical observed
   results (event type sequence, state, log, history, offered tools, replay refusal).
4. `refusal`: a person with no InferOps connection opening the board is refused 403
   `READ_RUN_REFUSED`, with no session event, chat or model request.
5. `interrupted`: the model call is held, and the client calls `abortRun()` once `RUN_STARTED` has
   arrived and the call is waiting.
   - No `RUN_FINISHED` or `RUN_ERROR` crosses the wire. The stock client reports its own local
     `RUN_ERROR` with code `abort`, which the report keeps apart from the wire events.
   - Once released, the kernel turn still completes and its reply is recovered from history: the
     transport loss is not a cancellation.
   - Nothing resubmits: the model saw exactly one request, the same selectors are refused 409
     `RUN_ALREADY_RESERVED`, and the session log stays empty.

Waits are bounded on observable conditions (an event, a held request, a history row), never on
fixed sleeps.

## Not covered

A browser or the Workshop UI, approvals, widgets, write actions, a deployed instance, a live InferOps
or InferLab, or a real model. The Build mock (`scripts/dev/scripted-model.ts`) is unchanged.
