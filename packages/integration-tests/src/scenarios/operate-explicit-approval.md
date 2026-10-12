# Scenario `operate-explicit-approval`, version 1

One programmed explicit approval (MVP-31): a pending InferOps board transition is interrupted,
then approved or denied, through the real Workshop's `POST /api/operate/agui/approval` bridge
([wire contract](../../../workshop-backend/src/operate-agui-approval.md)) by the unmodified
`@ag-ui/client` 1.0.2 `HttpAgent`. It is one concrete local example, not a scenario format or
runner. Its data is [`operate-explicit-approval.ts`](operate-explicit-approval.ts). Change a fixture
input or an expected result there and bump `version`. The report and verdict rules it shares with
[`operate-read-navigation`](operate-read-navigation.md) live in [`scenario-report.ts`](scenario-report.ts).

## Run it

```sh
pnpm --filter @gadgets/integration-tests exec vitest run __tests__/operate-approval-scenario.test.ts
```

It boots the Workshop and the InferOps gatekeeper Worker with `wrangler`'s `createTestHarness` on
`127.0.0.1`, with no credentials, no model and no external network. An outbound request nothing
answers in process fails the run. The same file runs in `pnpm test` and CI.

It writes a JSON report to `packages/integration-tests/.wrangler/tmp/scenario-reports/operate-explicit-approval-v1.json`
(or the path in `OPERATE_SCENARIO_REPORT`) and prints a one-line summary. The report names:
- the scenario version, the tested commit and whether the tree was dirty;
- the fixtures and the mocked and real boundaries;
- the isolation check (the count and origins of unanswered outbound requests);
- each case's observed results, with dynamic ids left out;
- the verdict.

The verdict is PASS only when all five cases pass in order and the isolation check ran and found
none. The run fails rather than write a report containing a minted session token, an InferOps token
or a synthetic secret description. `source` is always `mock` and `liveProviderProof` always `false`.

## Boundaries

Programmed: the InferOps and InferLab provider answers (`InferOpsFake`: the synthetic `ENG` board,
its issues, sign-in and the log of committed writes), synthetic accounts and identities, and the
proposal itself. The fixture calls the board session's `transition`, as an agent's code would; no
model takes part.

Real code:
- Workshop sign-in and the bearer session;
- the InferOps gatekeeper connection, its proposal simulation and its provider write;
- the action journal and its approve and reject decisions;
- the approval bridge (interrupt, caller binding, answer validation, receipt replay);
- the stock client.

Nothing here is per-person live identity or a live InferOps.

## Fixtures and initial state

Each case starts from a fresh account and workspace, with InferOps connected as a fake person
holding `operations` and the board `inferops://acme.operations/project/board/ENG` bound. Its board
session proposes moving `ENG-1` to another state at the issue's current revision. That is checked
before the case starts: one pending action, no provider write, and the issue not moved. `ENG-1` is
shared seeded data, so each approval moves it from wherever the last one left it. The report records
no state ids.

## Cases and expected results

1. `loopback-only`: the helper refuses any target that is not plain HTTP on `127.0.0.1`,
   `localhost` or `[::1]`, and the harness target passes.
2. `approve`:
   - The first run gives `RUN_STARTED`, `STATE_SNAPSHOT`, `MESSAGES_SNAPSHOT`, `RUN_FINISHED`.
   - It carries one interrupt with reason `inferos.gatekeeper.approval.v1`, a response schema
     requiring `approved`, metadata naming the pending action, and an expiry more than 500 s away.
   - The approval state is `pending`. Nothing is written and the issue is unchanged.
   - Answering `{approved: true}` gives `applied`, with exactly one provider write, committed as the
     fixture person, and the issue in the proposed state.
   - The identical answer again, and a reload into a fresh client, give `applied` with no further
     write.
3. `approve-repeat`: the same from another fresh fixture gives identical observed results.
4. `deny`:
   - After the same interrupt, `{approved: false}` gives `rejected` with no provider write and the
     issue unchanged.
   - The identical answer and a reload stay `rejected`.
5. `refusals`:
   - Another signed-in person sending the approver's answer is refused 403 `APPROVAL_REFUSED`, with
     no write, and the action is still `pending`.
   - After the approver approves (one write), a conflicting `{approved: false}` to the same
     interrupt is refused 403, with no further write, and the action is still `applied`.

Every check is an assertion on the run itself. Only the report's comparison leaves dynamic ids out.

## Not covered

The bridge's other paths stay with `operate-agui-approval.test.ts`:
- edits and replacements;
- partial or forged answers;
- stale or revoked provider authority;
- concurrent and lost responses, unknown outcomes;
- disconnect and restart.

Also out of scope:
- use-only callers, who keep the existing hide/deny behaviour; there is no visible non-approver role;
- a browser or the Workshop UI, widgets, a deployed instance, a live InferOps or InferLab;
- any implicit approval.
