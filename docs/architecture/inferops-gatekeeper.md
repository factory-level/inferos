---
title: InferOps gatekeeper
covers:
  - custom-gatekeepers/gatekeeper-inferops
  - packages/bundled-blueprints/blueprints/inferops-kanban
  - packages/gatekeeper-kit
  - packages/workshop-shared/src/gatekeeper.ts
  - packages/workshop-backend/src/user.ts
  - packages/workshop-backend/src/auth/config.ts
  - packages/workshop-backend/src/server.ts
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
API). With `INFERLAB_AUTH_ORIGIN` set, the vendor provides "Sign in with InferLab" and every
account is **connected through an InferLab PKCE sign-in**: the person's own session is held per
account and every InferOps request carries their token and one of their workspaces
([ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md)). Without it, accounts are
auto-provisioned demo accounts, and the HTTP client is reachable only through a
**local-development stopgap** connection in worker vars. The bundled `inferops.kanban` blueprint
renders a bound board as a Kanban gadget.

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | Vendor (connected accounts with an InferLab origin, auto-provisioned demo accounts without), account (`GatekeeperUser`: bind, configurator, revoke, reconnect), verifier, project-board gatekeeper facet, sessions, `clientFor` (which data source and whose authority), HTTP entry for the sign-in legs. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts` | InferLab PKCE flows: `INFERLAB_AUTH_ORIGIN` validation, `InferLabLogin` Durable Object per attempt (sign-in, connect or reconnect), `/authorize` redirect, `/oauth` callback, server-side code exchange and what each purpose does with the session. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-credentials.ts` | `InferOpsCredentials` Durable Object per connected account: the InferLab session (access and refresh token) under gatekeeper-kit's `CredentialCoordinator`, the identity and InferOps workspaces InferLab reported, the selected workspace, refresh (`POST /auth/refresh`), logout (`POST /auth/logout`), staged reconnects, and the once-only expiry notice. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-client.ts` | `InferOpsClient` data-source contract and `InferOpsError` codes (`NOT_FOUND`, `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `CONFLICT`, `UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`). |
| `custom-gatekeepers/gatekeeper-inferops/src/mock-inferops.ts` | `MockInferOps` Durable Object per (host, account), seeded from `src/fixtures/demo-board.json`; the only module that holds project data. Serves host `demo.local` only. |
| `custom-gatekeepers/gatekeeper-inferops/src/http-inferops.ts` | `openHttpInferOpsClient`: `InferOpsClient` over `fetch` for a fixed connection or an endpoint whose authority (token and workspace) is fetched per request, with field-by-field response parsing, the project-scope check and the error mapping. `endpointFromEnv` reads the API base URL and `connectionFromEnv` the stopgap connection from worker vars. The only module that talks InferOps HTTP. |
| `custom-gatekeepers/gatekeeper-inferops/src/resources.ts` | Resource grammar `inferops://<host>/project/board/<KEY>` (default host `demo.local`). |
| `custom-gatekeepers/gatekeeper-inferops/src/simulation.ts` | Board ordering and read-time overlay of an issue's live pending transition. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/project-ui.tsx` | Workspace and project picker built by the shared `build:configurator` task. It asks the gatekeeper for the default host instead of assuming `demo.local`, and records the chosen workspace on the account, since a resource URL never carries one. |
| `scripts/run-dev-server.ts` | Passes `INFEROPS_BASE_URL`, `INFEROPS_API_TOKEN` and `INFEROPS_WORKSPACE_ID` from the shell or root `.dev.vars` into the gatekeeper's generated dev config, resolves `INFERLAB_AUTH_ORIGIN` and `AUTH_GATEKEEPERS` for a wrapper's sign-in flag, and refuses to start when InferOps sign-in is asked for without the gatekeeper or an InferLab origin. |
| `packages/bundled-blueprints/blueprints/inferops-kanban` | Kanban gadget expecting a `board` binding of type `InferOpsProjectSession`. |
| `scripts/release/manifest-lib.ts` | Lists the gatekeeper as taking no default OAuth inputs and as install-once. |

## Data and Control Flow

- **Accounts.** `GatekeeperVendor.describe()` reports `providesAuth` and, inversely,
  `autoProvisionsAccount`, from whether `INFERLAB_AUTH_ORIGIN` is a bare HTTPS origin (or HTTP on
  loopback). Without one, `createAccount()` mints an `InferOpsAccount` whose only prop is a random
  `accountId`, provisioned under the admin's per-vendor mode; the gatekeeper asserts no ambience.
  With one, every account comes from a connect flow and carries `{accountId, connected: true,
  email?}`, where `email` is present only when InferLab marked it verified. An account declares no
  singleton and no management UI, so the Workshop reaches it only through URL-addressed resources.
- **InferLab flows.** `connectAccount(callback, options)` creates an `InferLabLogin` object holding
  the flow's purpose (`signin` for `scopes: "auth"`, else `connect`), the callback and an
  initiation nonce, and returns `<BASE_URL>/<attempt>/<nonce>`; `GatekeeperUser.reconnect()` does
  the same with purpose `reconnect` and no callback of its own. Without an InferLab origin all of
  them throw. The popup leg trades the nonce, once, for an OAuth nonce and a PKCE verifier, then
  redirects to `<origin>/authorize?client_id=inferos&redirect_uri=<BASE_URL>/oauth&state=<attempt>.<nonce>`
  with an S256 challenge. The `/oauth` leg claims the state once and POSTs
  `{clientId, code, codeVerifier, redirectUri}` to `<origin>/auth/token` (30 s timeout, capped
  body), parsing the session (`token`, `refreshToken`) and the identity (`user.id`, `email`,
  `tenantId`, the `product: "inferops"` entries of `user.workspaces`, `emailVerified`). Then, by
  purpose:
  - **Sign-in** requires `emailVerified: true` (InferLab also issues sessions for emails nobody
    proved, such as invitations and impersonation), signs the session out again with
    `POST /auth/logout`, and hands `callback.complete` an account carrying only the normalized
    email. Signing in grants nothing.
  - **Connect** installs the session and identity in the account's `InferOpsCredentials` object
    together with the callback, then calls `callback.complete` with the connected account; if
    that throws, the session is signed out and the object wiped.
  - **Reconnect** stages the session in the existing account's object and calls the stored
    callback's `reconnectComplete(stageId)`; `commitReconnect(stageId)` makes it live and signs
    the previous session out.
  Every purpose ends on the kit's handoff page. A non-2xx exchange, an InferLab `error=` redirect,
  or a replayed or forged state ends the attempt with an error page; the alarm deletes the
  attempt's object after at most 20 minutes.
- **The person's authority.** `InferOpsCredentials` keeps the session under gatekeeper-kit's
  `CredentialCoordinator`. `getCredentials(workspaceId?)` refreshes the access token ahead of its
  `exp` claim (`POST /auth/refresh {refreshToken}`, which rotates both tokens) and serves the token
  with one workspace id: the one requested, else the selected one, else the person's only one,
  always one InferLab listed them in; anything else is refused before a request is made. A 401 from
  the refresh is the session's death: it is recorded, announced once through the callback's
  `credentialsExpired()`, and the account is refused until a reconnect. A token InferOps rejects
  (401) is reported back through `reportCredentialsRejected`, which heals by refreshing and lets the
  request retry once. The refresh token never leaves the object. `revoke()` signs the session out
  and wipes the object.
- **Binding.** `InferOpsAccount.getGatekeeperClassFor(url)` parses the URL, checks the project
  exists for the account, and returns `InferOpsProjectGatekeeper` with props
  `{accountId, connected, host, projectKey, workspaceId}`, the workspace being the account's
  current one when the host is the configured API's. Sessions read scope only from those props; no
  method takes a project, host, account or workspace. The configurator lists the person's
  workspaces and stores their choice on the account (`selectWorkspace`); with several workspaces
  and no choice, binding and listing projects fail asking for one.
- **Data source.** `clientFor` in `inferops.ts` is the one place a client is chosen. A connected
  account whose binding names the configured API host (`INFEROPS_BASE_URL`, or the InferLab origin
  when only that is set) gets the HTTP client with its own authority, fetched per request through
  the kit's `CredentialSource`; a dead session surfaces as `UNAUTHORIZED`, a session replaced
  mid-request as `UNAVAILABLE`. Any other account whose binding names the stopgap connection's host
  gets the HTTP client with that fixed credential; everything else gets the mock, which serves only
  `demo.local` and refuses other hosts. The host only selects one of these: no address or
  credential is taken from a URL, and the person's own token always wins over the stopgap.
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
  their account can open the bound project in the binding's workspace, with their own token;
  `removeObserver` is a no-op. `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN` and no membership of that
  workspace mean no access; any other failure fails the open.
- **Kanban gadget.** Its Durable Object proxies `loadBoard()` to `env.board.readBoard()` and
  `moveIssue()` to `env.board.openIssue(id).transition(stateId, revision)` (pipelined, then
  disposed), returning failure codes as data. The client renders columns, drag and drop, and a
  per-card "Move to…" select, reloads on `STALE_REVISION`, and shows a not-connected notice when the
  binding is absent.

## Configuration

`cloudflare.config.ts` uses the shared gatekeeper factory (`allow_irrevocable_stub_storage`,
migrations `v0`: `MockInferOps`, `InferOpsProjectGatekeeper`, and `v1`: `InferLabLogin`,
`InferOpsCredentials`); `wrangler.jsonc` is generated. The worker needs no secrets. `BASE_URL` is
set per deployment like every gatekeeper's. Discovery under `custom-gatekeepers/` binds it as
`GATEKEEPER_INFEROPS`. The release manifest gives it no deploy inputs and marks it install-once.

The vars below are declared in `src/env.d.ts` and left unset in the committed `wrangler.jsonc`;
`pnpm dev-server` passes the InferOps ones through from the shell or the root `.dev.vars`
(`PASSTHROUGH_GATEKEEPER_VARS`) and resolves `INFERLAB_AUTH_ORIGIN` from the shell or a wrapper's
sign-in flag (default `http://localhost:8080`, the local InferLab stack).

| Var | Meaning |
| --- | --- |
| `INFERLAB_AUTH_ORIGIN` | InferLab central-auth origin (bare HTTPS, or HTTP on loopback). Set, it turns on sign-in and makes every account a connected person; the exchange, refresh and logout go here. Unset means demo accounts. |
| `INFEROPS_BASE_URL` | InferOps API base URL connected people call with their own session. Its host (with port) is the `<host>` a resource URL must name, for example `inferops://localhost:8080/project/board/ENG`. Unset, the InferLab origin serves as the API too (locally one server serves both). |
| `INFEROPS_API_TOKEN` | Stopgap bearer token (a user access token or an `iex_` service-account key) for accounts with no identity. Requires the base URL and the workspace id, else an error names the missing variable. |
| `INFEROPS_WORKSPACE_ID` | The workspace UUID the stopgap sends as `X-Workspace-Id`. |

With an API configured the project picker defaults to its host and lists its projects;
`demo.local` bindings keep working beside it.

**The stopgap is for local development.** Its token is one credential for the whole dev server,
so every account that has no identity acts with it and observer verification cannot tell those
people apart. It never backs a connected person, and the release manifest offers no input for any
of these vars, so a deployed instance cannot be given them through the deploy wizard.

Startup checks: `run-dev-server.ts` refuses to start when `DISABLE_PASSWORD_AUTH=true` leaves no
gatekeeper allowlisted, or when `AUTH_GATEKEEPERS` names `inferops` (from the shell, or from a
wrapper's `features.inferlabLogin` or `INFEROPS_AUTH`) but the gatekeeper is not enabled or
`INFERLAB_AUTH_ORIGIN` is unset or malformed, naming the problem. The
Workshop backend checks the same allowlist on its first API request
(`assertAuthGatekeepersConfigured` in `auth/config.ts`): a listed vendor that is unbound or does not
report `providesAuth` fails every request with a clear message rather than a login page quietly
missing a button.

## Divergences from Design

- Signing in and connecting are two InferLab sign-ins: the Workshop persists a sign-in account only
  for its Cloudflare vendor, so the person connects InferOps separately (InferLab's SSO cookie makes
  the second sign-in silent). The sign-in's own session is ended at once.
- Without an InferLab origin, accounts are auto-provisioned demo accounts with no identity, and
  "permission mapping" is the mock's per-account project list; a stopgap connection from worker
  vars lends those accounts one deployment-wide token, for local development only.
- The release manifest has no deploy input for `INFERLAB_AUTH_ORIGIN` or `INFEROPS_BASE_URL`, so
  cloud installs can't turn on InferLab sign-in from the wizard yet.
- The workspace a binding is made in is the account's selection at the time, recorded by the
  configurator; two configurators open at once could race over it.
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
- The HTTP client and the InferLab flows have not been run against a live InferOps; their
  evidence is a fake `fetch`.
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
sessions over the HTTP client. `__tests__/inferlab-login.test.ts` covers origin validation,
`providesAuth`, the authorize redirect, the PKCE exchange, the sign-in's logout and handoff,
single-use links and states, forged states, InferLab errors, rejected exchanges and unverified
emails. `__tests__/account.test.ts` drives connected accounts against a fake InferLab and InferOps
behind one `fetch`: the connect keeps the session, every request carries the person's token and
workspace, refresh ahead of expiry, healing a rejected token, a dead session reported once, revoke
signing out, a staged reconnect committed by the Workshop, the only workspace chosen without
asking, a choice required among several, a workspace outside the person's membership refused
locally, InferOps denying a workspace without expiring the account, and observer admission by the
collaborator's own membership.
`packages/bundled-blueprints/blueprints/inferops-kanban/__tests__/` covers the gadget's server and
board rules. See [source ledger](../wiki/research-sources.md) for sibling repository revisions.
