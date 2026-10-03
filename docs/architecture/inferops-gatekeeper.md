---
title: InferOps gatekeeper
covers:
  - custom-gatekeepers/gatekeeper-inferops
  - packages/bundled-blueprints/blueprints/inferops-kanban
  - packages/gatekeeper-kit
  - packages/workshop-shared/src/gatekeeper.ts
  - packages/workshop-backend/src/user.ts
  - scripts/release/manifest-lib.ts
  - scripts/run-dev-server.ts
updated: 2026-10-02
---

# InferOps gatekeeper

## Overview

`custom-gatekeepers/gatekeeper-inferops` (package `@inferos/gatekeeper-inferops`, vendor id
`inferops`) implements the reviewed agent-facing API from the
[design](../design/inferops-gatekeeper.md). Its `src/types.d.ts` is the design's
`inferops-gatekeeper-api.d.ts` verbatim: `InferOpsProjectSession` (`readBoard`, `openIssue`) and
`InferOpsIssueSession` (`read`, `transition`). The gatekeeper code is written against a data-source
contract (`src/inferops-client.ts`) with two implementations: `src/mock-inferops.ts` (**demo data**,
the default, and what the tests and the demo use) and `src/http-inferops.ts` (the InferOps HTTP
API). The HTTP client is reachable only through a **local-development stopgap**: one connection
configured in worker vars and shared by every account. Per-user InferOps sign-in
([#66](https://github.com/factory-level/inferos/issues/66)) is not built. The bundled
`inferops.kanban` blueprint renders a bound board as a Kanban gadget.

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | Vendor (auto-provisioned accounts, no OAuth), account (`GatekeeperUser`), verifier, project-board gatekeeper facet, sessions, configurator RPC. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-client.ts` | `InferOpsClient` data-source contract and `InferOpsError` codes (`NOT_FOUND`, `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `CONFLICT`, `UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`). |
| `custom-gatekeepers/gatekeeper-inferops/src/mock-inferops.ts` | `MockInferOps` Durable Object per (host, account), seeded from `src/fixtures/demo-board.json`; the only module that holds project data. Serves host `demo.local` only. |
| `custom-gatekeepers/gatekeeper-inferops/src/http-inferops.ts` | `openHttpInferOpsClient`: `InferOpsClient` over `fetch`, with field-by-field response parsing, the project-scope check and the error mapping. `connectionFromEnv` reads the stopgap connection from worker vars. The only module that talks HTTP. |
| `custom-gatekeepers/gatekeeper-inferops/src/resources.ts` | Resource grammar `inferops://<host>/project/board/<KEY>` (default host `demo.local`). |
| `custom-gatekeepers/gatekeeper-inferops/src/simulation.ts` | Board ordering and read-time overlay of an issue's live pending transition. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/project-ui.tsx` | Project picker built by the shared `build:configurator` task. It asks the gatekeeper for the default host instead of assuming `demo.local`. |
| `scripts/run-dev-server.ts` | Passes `INFEROPS_BASE_URL`, `INFEROPS_API_TOKEN` and `INFEROPS_WORKSPACE_ID` from the shell or root `.dev.vars` into the gatekeeper's generated dev config. |
| `packages/bundled-blueprints/blueprints/inferops-kanban` | Kanban gadget expecting a `board` binding of type `InferOpsProjectSession`. |
| `scripts/release/manifest-lib.ts` | Lists the gatekeeper as taking no default OAuth inputs and as install-once. |

## Data and Control Flow

- **Accounts.** `GatekeeperVendor.describe()` sets `autoProvisionsAccount`; `createAccount()` mints
  an `InferOpsAccount` whose only prop is a random `accountId`. It declares no singleton and no
  management UI, so the Workshop reaches it only through URL-addressed resources. Provisioning
  follows the admin's per-vendor mode; the gatekeeper asserts no ambience.
- **Binding.** `InferOpsAccount.getGatekeeperClassFor(url)` parses the URL, checks the project
  exists for the account, and returns `InferOpsProjectGatekeeper` with props
  `{accountId, host, projectKey}`. Sessions read scope only from those props; no method takes a
  project, host or account.
- **Data source.** `clientFor` in `inferops.ts` is the one place a client is chosen. When a
  connection is configured and the binding's host equals the host of its base URL, it returns the
  HTTP client; otherwise the mock, which serves only `demo.local` and refuses other hosts. The host
  only selects a configured connection: no address or credential is taken from a URL.
- **HTTP client.** Each call sends `Authorization: Bearer`, `X-Workspace-Id` and, on a
  transition, `X-Idempotency-Key`, with a 15 s timeout and redirects not followed. A project key is
  resolved to its UUID through `GET /project/projects` on every use. `readProject` requests
  `GET /project/board?projectId=<uuid>`, requires the response's `projectId` to match, and keeps
  only states and the `Issue` fields, dropping the workspace `projects[]`, leases and runs.
  `readIssue` requests `GET /project/issues/<id>` and answers
  `NOT_FOUND: No such issue in this project.` for a 404, for an issue whose `projectId` is another
  project's, and for an id that is not a UUID. `transition` makes that same scope check first, then
  `POST /project/issues/<id>/transition` with `{toStateId, expectedRevision}`. A response that
  fails parsing, a non-JSON body, a redirect, a 5xx or a network failure is `UNAVAILABLE`; 401 is
  `UNAUTHORIZED`; 403 `FORBIDDEN`; 404 `NOT_FOUND`; 409 `STALE_REVISION` or `WORKFLOW_MISMATCH` by
  code and otherwise `CONFLICT`; 400 `INVALID_REQUEST`. InferOps' message text is not passed on,
  and logs carry only the operation name, status and code.
- **Reads.** `readBoard()` and `InferOpsIssueSession.read()` overlay pending transitions, then call
  `authorizeObservation` before returning. `openIssue(id)` is not an observation (UUID existence) and
  fails with the same `NOT_FOUND: No such issue in this project.` for an unknown issue and for an
  issue of another project.
- **Transitions.** `transition(toStateId, expectedRevision)` checks state membership
  (`INVALID_STATE`), workflow (`WORKFLOW_MISMATCH`) and the simulated revision (`STALE_REVISION`),
  records a pending action in the facet's KV, then calls `submitAction` (no auto-approvable kinds).
  Until decided, reads show the issue in the target state at its unchanged revision. The revision
  is opaque (InferOps' is a ledger position shared by all issues), so moves do not chain: a second
  move of an issue whose pending move still applies fails with `CONFLICT`, while proposing the
  same target again is a no-op. A pending move made stale by an outside change is no longer
  simulated and does not block a new one.
  `applyAction` calls the data source with idempotency key `<facet instance id>:<action id>`; the
  data source rechecks scope, state, workflow and revision, and a replayed key returns the issue
  without re-applying. A stale apply fails with a message telling the approver to discard the
  move. `rejectAction` deletes the record, which ends the simulation. `revertAction` moves the issue
  back only if it is still where the move left it.
- **Observers.** Strategy B: `addObserver` asks the collaborator's own `InferOpsVerifier` whether
  their account can open the bound project; `removeObserver` is a no-op. `NOT_FOUND`,
  `UNAUTHORIZED` and `FORBIDDEN` mean no access; any other failure fails the open.
- **Kanban gadget.** Its Durable Object proxies `loadBoard()` to `env.board.readBoard()` and
  `moveIssue()` to `env.board.openIssue(id).transition(stateId, revision)` (pipelined, then
  disposed), returning failure codes as data. The client renders columns, drag and drop, and a
  per-card "Move to…" select, reloads on `STALE_REVISION`, and shows a not-connected notice when the
  binding is absent.

## Configuration

`cloudflare.config.ts` uses the shared gatekeeper factory (`allow_irrevocable_stub_storage`,
migration `v0`: `MockInferOps`, `InferOpsProjectGatekeeper`); `wrangler.jsonc` is generated. The
worker needs no secrets or vars for demo data. Discovery under `custom-gatekeepers/` binds it as
`GATEKEEPER_INFEROPS`. The release manifest gives it no deploy inputs and marks it install-once.

A live connection is configured by three worker vars, declared in `src/env.d.ts` and left unset in
the committed `wrangler.jsonc`:

| Var | Meaning |
| --- | --- |
| `INFEROPS_BASE_URL` | InferOps API base URL. Its host (with port) is the `<host>` a resource URL must name, for example `inferops://localhost:8080/project/board/ENG`. Unset means demo data only. |
| `INFEROPS_API_TOKEN` | Bearer token: a user access token or an `iex_` service-account key. |
| `INFEROPS_WORKSPACE_ID` | The InferOps workspace UUID sent as `X-Workspace-Id`. |

`pnpm dev-server` passes them through from the shell or the root `.dev.vars`
(`PASSTHROUGH_GATEKEEPER_VARS`). A base URL without its token or workspace id is an error naming
the missing variable. With a connection configured the project picker defaults to its host and
lists its projects; `demo.local` bindings keep working beside it.

**This is a local-development stopgap.** The token is one credential for the whole dev server, so
every account acts with it and observer verification cannot tell people apart. The release
manifest offers no input for these vars, so a deployed instance cannot be given them through the
deploy wizard. [#66](https://github.com/factory-level/inferos/issues/66) replaces the token with
each connected person's own credential.

## Divergences from Design

- Authentication is not implemented. Accounts are auto-provisioned per user rather than connected
  to an InferOps identity, so there is no connect, reconnect or revocation of an InferOps
  credential, and for demo data "permission mapping" is the mock's per-account project list.
- A live connection uses one deployment-wide token from worker vars, not each person's own
  authority as the design requires. It exists for local development only, pending #66.
- The transition endpoint's 404 does not say whether the issue or the target state is missing, so
  the HTTP client reports both as `NOT_FOUND`. `INVALID_STATE` is decided from the board when a
  move is proposed.
- The scope check and the transition are two requests; InferOps does not enforce the project.
- InferOps does not reject an idempotency key reused for a different move; only the mock does
  (`IDEMPOTENCY_CONFLICT`). The gatekeeper never reuses a key.
- The mock still advances a revision by one per transition. Nothing depends on that.
- InferOps accepts mixed-case project identifiers; the resource grammar accepts uppercase keys
  only, so such a project is listed by the picker but cannot be bound.
- No "pending" marker is exposed on `Issue`; the Kanban gadget marks moves it requested itself
  until the next refresh.

## Open Questions

- InferOps has not confirmed the contract or the companion changes
  ([factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326)).
- The HTTP client has not been run against a live InferOps; its evidence is a fake `fetch`.
- Nothing is cached, so an issue read costs two requests and a transition three.

## Evidence

`custom-gatekeepers/gatekeeper-inferops/__tests__/gatekeeper.test.ts` (workerd, over the mock)
covers board reads and observations, cross-project denial, invalid state, workflow mismatch, stale
revision at proposal and at apply, refusal of a second move while one is pending, duplicate apply
replay, rejection clearing the simulation, revert, and observer admission.
`__tests__/http-inferops.test.ts` drives the HTTP client against a fake `fetch`: board mapping and
stripping, cross-project issue refused identically to an unknown one, stale revision, workflow
mismatch, replay of one idempotency key, rejected credential, 5xx, redirect, non-JSON and
malformed responses, and connection configuration. The gatekeeper has no test that runs its
sessions over the HTTP client.
`packages/bundled-blueprints/blueprints/inferops-kanban/__tests__/` covers the gadget's server and
board rules. See [source ledger](../wiki/research-sources.md) for sibling repository revisions.
