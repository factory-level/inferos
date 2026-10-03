---
title: InferOps gatekeeper
covers:
  - custom-gatekeepers/gatekeeper-inferops
  - packages/bundled-blueprints/blueprints/inferops-kanban
  - packages/gatekeeper-kit
  - packages/workshop-shared/src/gatekeeper.ts
  - packages/workshop-backend/src/user.ts
  - packages/workshop-backend/src/auth/config.ts
  - packages/integration-tests/__tests__/inferops-isolation.test.ts
  - packages/integration-tests/src/inferops-fake.ts
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
`inferops-gatekeeper-api.d.ts` verbatim: `InferOpsProjectSession` (`readBoard`, `openIssue`,
`createIssue`) and `InferOpsIssueSession` (`read`, `transition`, `update`), with `Issue.pending`
marking simulated changes. The gatekeeper code is written against a data-source
contract (`src/inferops-client.ts`) with two implementations: `src/mock-inferops.ts` (**demo data**,
the default, and what the tests and the demo use) and `src/http-inferops.ts` (the InferOps HTTP
API). With `INFERLAB_AUTH_ORIGIN` set, the vendor provides "Sign in with InferLab" and every
account is **connected through an InferLab PKCE sign-in**: the person's own session is held per
account and every InferOps request carries their token and one of their workspaces
([ADR 0004](../adr/0004-inferops-gatekeeper-user-authority.md)). Boards are addressed with
InferOps' own URI grammar, `inferops://<tenant>.<workspace>/project/board/<KEY>`, whose workspace
slug is resolved against the person's own workspaces
([ADR 0005](../adr/0005-inferops-uri-authority.md)). Without it, accounts are
auto-provisioned demo accounts, and the HTTP client is reachable only through a
**local-development stopgap** connection in worker vars. The bundled `inferops.kanban` blueprint
renders a bound board as a Kanban gadget.

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | Vendor (connected accounts with an InferLab origin, auto-provisioned demo accounts without), account (`GatekeeperUser`: bind, configurator, revoke, reconnect), verifier, project-board gatekeeper facet, sessions, `clientFor` (which data source and whose authority), HTTP entry for the sign-in legs. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts` | InferLab PKCE flows: `INFERLAB_AUTH_ORIGIN` validation, `inferOpsApiEndpoint` (the one place the API base URL comes from), `InferLabLogin` Durable Object per attempt (sign-in, connect or reconnect), `/authorize` redirect, `/oauth` callback, server-side code exchange, the workspace-slug read, and what each purpose does with the session. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-credentials.ts` | `InferOpsCredentials` Durable Object per connected account: the InferLab session (access and refresh token) under gatekeeper-kit's `CredentialCoordinator`, the identity and InferOps workspaces InferLab reported with each one's slug, slug resolution (`resolveWorkspace`), refresh (`POST /auth/refresh`), logout (`POST /auth/logout`), staged reconnects, and the once-only expiry notice. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-client.ts` | `InferOpsClient` data-source contract and `InferOpsError` codes (`NOT_FOUND`, `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `CONFLICT`, `UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`). |
| `custom-gatekeepers/gatekeeper-inferops/src/mock-inferops.ts` | `MockInferOps` Durable Object per (host, account), seeded from `src/fixtures/demo-board.json`; the only module that holds project data. Serves host `demo.local` only. Implements transition, create and update with InferOps' checks and per-key replay, and refuses a key reused for a different request (`IDEMPOTENCY_CONFLICT`). |
| `custom-gatekeepers/gatekeeper-inferops/src/http-inferops.ts` | `openHttpInferOpsClient`: `InferOpsClient` over `fetch` for a fixed connection or an endpoint whose authority (token and workspace) is fetched per request, with field-by-field response parsing, the project-scope check and the error mapping. `listWorkspaceSlugs` reads `GET /workspaces` for the connect flow. `endpointFromEnv` reads the API base URL and `connectionFromEnv` the stopgap connection from worker vars. The only module that talks InferOps HTTP. |
| `custom-gatekeepers/gatekeeper-inferops/src/resources.ts` | Resource grammar `inferops://<tenant>.<workspace>/project/board/<KEY>` (two lowercase slug labels; `demo.local` is the demo data), `parseHost`, `isSlug`. |
| `custom-gatekeepers/gatekeeper-inferops/src/actions.ts` | The stored action records, a tagged union (`kind`: `transition`, `create`, `update`) each carrying the exact request it sends; `readAction` reads a record without `kind` (written before creates and updates) as a transition; `fingerprintOf`/`matchesFingerprint` hash the normalized request with the project key (SHA-256 over canonical JSON). |
| `custom-gatekeepers/gatekeeper-inferops/src/simulation.ts` | Board ordering and read-time overlay of pending actions: an issue's live pending transition or update (`pending` `transition` or `update`), and pending creates as provisional cards (`pending: "create"`). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/project-ui.tsx` | Organization, workspace and project picker built by the shared `build:configurator` task. It builds `inferops://<organization>.<workspace>/project/board/<KEY>` from an organization label, a workspace slug from the account's list and a project; with both left empty it asks the gatekeeper for a default host, which only a demo account has (`demo.local`). It duplicates the URL grammar for prefilling, kept in step by `__tests__/resources.test.ts`. |
| `scripts/run-dev-server.ts` | Passes `INFEROPS_BASE_URL`, `INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID` and `INFEROPS_WORKSPACE_SLUG` from the shell or root `.dev.vars` into the gatekeeper's generated dev config, resolves `INFERLAB_AUTH_ORIGIN` and `AUTH_GATEKEEPERS` for a wrapper's sign-in flag, and refuses to start when InferOps sign-in is asked for without the gatekeeper or an InferLab origin. |
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
  `tenantId`, the `product: "inferops"` entries of `user.workspaces`, `emailVerified`). A connect
  or reconnect then reads `GET <api>/workspaces` with the new token (no `X-Workspace-Id`) and
  stores each membership's `slug` beside it; a listed workspace that is not a membership is
  ignored, and a failed or malformed list fails the attempt and signs the new session out. Then,
  by purpose:
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
  `CredentialCoordinator`. `getCredentials(workspaceId)` refreshes the access token ahead of its
  `exp` claim (`POST /auth/refresh {refreshToken}`, which rotates both tokens) and serves the token
  with the requested workspace id, which must be one InferLab listed the person in; anything else
  is refused before a request is made. `resolveWorkspace(slug)` returns the id of the person's
  workspace with that stored slug, or null. A 401 from
  the refresh is the session's death: it is recorded, announced once through the callback's
  `credentialsExpired()`, and the account is refused until a reconnect. A token InferOps rejects
  (401) is reported back through `reportCredentialsRejected`, which heals by refreshing and lets the
  request retry once. The refresh token never leaves the object. `revoke()` signs the session out
  and wipes the object.
- **Binding.** `InferOpsAccount.getGatekeeperClassFor(url)` parses
  `inferops://<tenant>.<workspace>/project/board/<KEY>` (exactly two lowercase slug labels, no
  port; anything else is not a board URL), resolves the workspace, checks the project exists there
  for the account, and returns `InferOpsProjectGatekeeper` with props
  `{accountId, connected, host, projectKey, workspaceId}`, where `host` is `<tenant>.<workspace>`.
  For a connected account the workspace is `resolveWorkspace(<workspace>)`; a slug the person does
  not hold, a host no data source serves and a missing project all fail with the one message
  `No InferOps project <KEY> is available on <host>.`, before any request for the first two. The
  tenant label is not compared with anything: the identity carries the tenant id, never its slug.
  Sessions read scope only from those props; no method takes a project, host, account or
  workspace. The configurator lists the person's workspaces by slug and their projects for the
  host the form would name; nothing is stored on the account.
- **Data source.** `clientFor` in `inferops.ts` is the one place a client is chosen. `demo.local`
  always gets the mock. A connected account with a resolved workspace gets the HTTP client against
  `inferOpsApiEndpoint` (`INFEROPS_BASE_URL`, or the InferLab origin when only that is set) with
  its own authority, fetched per request through the kit's `CredentialSource`; a dead session
  surfaces as `UNAUTHORIZED`, a session replaced mid-request as `UNAVAILABLE`. An account with no
  identity whose binding's workspace label is the stopgap's `INFEROPS_WORKSPACE_SLUG` gets the HTTP
  client with that fixed credential. Everything else gets the mock, which refuses any host but
  `demo.local` as `NOT_FOUND`. No address or credential is taken from a URL, and the stopgap never
  backs a connected person.
- **HTTP client.** Each call sends `Authorization: Bearer`, `X-Workspace-Id` and, on a
  write, `X-Idempotency-Key`, with a 15 s timeout and redirects not followed. A project key is
  resolved to its UUID through `GET /project/projects` on every use. `readProject` requests
  `GET /project/board?projectId=<uuid>`, requires the response's `projectId` to match, and keeps
  only states and the `Issue` fields, dropping the workspace `projects[]`, leases and runs.
  `readIssue` requests `GET /project/issues/<id>` and answers
  `NOT_FOUND: No such issue in this project.` for a 404, for an issue whose `projectId` is another
  project's, and for an id that is not a UUID. `transition` makes that same scope check first, then
  `POST /project/issues/<id>/transition` with `{toStateId, expectedRevision}`. `updateIssue` makes
  the same scope check, then `PATCH /project/issues/<id>` with only `title`, `description` (null
  clears), `priority` and the required `expectedRevision`, and requires the returned card to be the
  same issue. `createIssue` resolves the project's UUID and `POST /project/issues` with
  `{projectId, title, description?, priority?, stateId, workflow?}`; a 404 is reported as the
  project or state being gone. A 403 whose body carries `error.details.decision` is still
  `FORBIDDEN`, with a message naming the workflow policy. A response that
  fails parsing, a non-JSON body, a redirect, a 5xx or a network failure is `UNAVAILABLE`; 401 is
  `UNAUTHORIZED`; 403 `FORBIDDEN`; 404 `NOT_FOUND`; 409 `STALE_REVISION` or `WORKFLOW_MISMATCH` by
  code and otherwise `CONFLICT`; 400 `INVALID_REQUEST`. InferOps' message text is not passed on,
  and logs carry only the operation name, status and code.
- **Reads.** `readBoard()` and `InferOpsIssueSession.read()` overlay pending transitions, then call
  `authorizeObservation` before returning. `openIssue(id)` is not an observation (UUID existence) and
  fails with the same `NOT_FOUND: No such issue in this project.` for an unknown issue and for an
  issue of another project.
- **Writes.** Every write is staged in the facet's KV as an `ActionRecord` (actions.ts) with the
  request it will send and its fingerprint, then submitted with `submitAction`; if submission
  throws, the record is deleted. None is auto-approvable.
- **Transitions.** `transition(toStateId, expectedRevision)` checks state membership
  (`INVALID_STATE`), workflow (`WORKFLOW_MISMATCH`) and the simulated revision (`STALE_REVISION`),
  records a pending action in the facet's KV, then calls `submitAction` (no auto-approvable kinds).
  Until decided, reads show the issue in the target state at its unchanged revision. The revision
  is opaque (InferOps' is a ledger position shared by all issues), so moves do not chain: a second
  move or update of an issue whose pending change still applies fails with `CONFLICT`, while
  proposing the same target again is a no-op. A pending change made stale by an outside change is
  no longer simulated and does not block a new one.
- **Updates.** `update({title?, description?, priority?}, expectedRevision)` requires a decimal
  revision (`INVALID_REQUEST`), trims the title and refuses an empty or overlong one (1 to 500) or
  a description over 20000 characters (`INVALID_REQUEST`), checks the simulated revision
  (`STALE_REVISION`), drops a title or priority equal to the current one (a change of nothing is a
  no-op), refuses a second pending change (`CONFLICT`), and records the previous title and
  priority. Until decided, reads show the new title and priority with `pending: "update"` at the
  unchanged revision. The approval shows an inline `Issue` field (as transitions do), the current
  and new title, `old → new` priority, the new description in full (or that it is cleared) and the
  expected revision; its title is `Update <KEY>-<n>: <fields>`.
- **Creates.** `createIssue({title, description?, priority?, stateId?})` validates the fields the
  same way, resolves the state from the board (`INVALID_STATE` outside the project; default the
  first `software` state in board order, or the first state when there is none) and sends it
  explicitly, with `workflow: "content"` only for a content state. Until decided, `readBoard()`
  shows a provisional card at the end of that column: id `pending-<action id>`, identifier
  `<KEY>-new`, revision `"0"`, `pending: "create"`; `openIssue` does not accept it. The approval
  shows project, title, state, workflow, priority and description; its title is
  `Create issue: <title>`.
- **Applying.** `applyAction` reads the record (a record without `kind` is a transition and has no
  fingerprint to check), recomputes the fingerprint of the request it is about to send and refuses
  a mismatch without sending anything, then calls the data source with idempotency key
  `<facet instance id>:<action id>`; the data source rechecks scope, state, workflow and revision,
  and a replayed key returns the original result without writing again, so a create whose
  response was lost is retried into the same issue. An applied create records the new identifier,
  an applied update the revision it produced. A failed apply names the action and the reason
  (stale, invalid state, gone, refused, not permitted, fingerprint mismatch) and keeps the record
  pending. `rejectAction` deletes the record, which ends the simulation.
- **Reverting.** A transition moves the issue back only if it is still where the move left it. A
  title or priority update restores the previous values with the then-current revision only if
  the issue is still at the revision the update produced and still shows its values. Creates and
  description updates are submitted with `implementsRevert: false`, and `revertAction` explains
  instead of acting.
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
| `INFEROPS_ENABLED` | `"true"` or `"false"`: the integration switch (below). Unset counts as on, so deployments that predate it keep working; anything else is off. `pnpm dev-server` always sets it. |
| `INFERLAB_AUTH_ORIGIN` | InferLab central-auth origin (bare HTTPS, or HTTP on loopback). Set, it turns on sign-in and makes every account a connected person; the exchange, refresh and logout go here. Unset means demo accounts. |
| `INFEROPS_BASE_URL` | InferOps API base URL connected people call with their own session. It never appears in a resource URL; the account's display name shows its host. Unset, the InferLab origin serves as the API too (locally one server serves both). |
| `INFEROPS_API_TOKEN` | Stopgap bearer token (a user access token or an `iex_` service-account key) for accounts with no identity. Requires the base URL, the workspace id and the workspace slug, else an error names the missing variable. |
| `INFEROPS_WORKSPACE_ID` | The workspace UUID the stopgap sends as `X-Workspace-Id`. |
| `INFEROPS_WORKSPACE_SLUG` | The stopgap workspace's slug: a resource URL whose `<workspace>` is this slug (for example `inferops://acme.operations/project/board/ENG` with `operations`) uses the stopgap connection. |

`demo.local` bindings keep working beside a configured API.

**The stopgap is for local development.** Its token is one credential for the whole dev server,
so every account that has no identity acts with it and observer verification cannot tell those
people apart. It never backs a connected person, and the release manifest offers no input for any
of these vars, so a deployed instance cannot be given them through the deploy wizard.

### Integration switch

`src/enablement.ts` enforces the `INFEROPS_ENABLED` capability ([#33](https://github.com/factory-level/inferos/issues/33)) inside the gatekeeper, so it does not depend on the UI. While the var is off:

- `InferOpsAccount.getGatekeeperClassFor` refuses before reading the URL, so no new binding is created.
- `clientFor` returns a client that checks the switch on **every call**, not when a binding or session is made (`whileInferOpsEnabled`). Every call through an existing binding or session (`readBoard`, `openIssue`, `read`, `transition`), observer admission (`addObserver` through the verifier), the project picker and `revertAction` fail with `DISABLED: InferOps is turned off for this deployment.` The proxy guards every client method except `forget`, including methods added later, so an account can still delete its own data (`revoke`).
- `applyAction` of a queued move fails with a message saying InferOps is turned off; the move is not applied and its record stays pending. `rejectAction` still works, since it only discards.
- Nothing is deleted: bindings, queued moves, credentials and accounts are kept. Turning it back on restores exactly those; it creates no binding, grant or account. Sign-in (`connectAccount`), account description and `createAccount` are unaffected: an account is an id with no data until a binding is made, and bindings are refused.

`DISABLED` is an `InferOpsErrorCode` (`inferops-client.ts`) the gatekeeper raises itself; no InferOps response maps to it. The agent-facing types (`src/types.d.ts`, the design's API verbatim) do not list it; the error message names it. The canvas board card shows it as its own state ([canvas](inferops-canvas.md#board-data-adapter)). `__tests__/enablement.test.ts` covers a refused binding, every session call on an existing binding refused and served again once on, a queued move never applied while off and applied once on, revocation while off and observer admission refused.

Who sets the var: `run-dev-server.ts` resolves it with `resolveInferOpsEnabled` (`scripts/dev-server-config.ts`). A version 2 wrapper sets it from its capability, whatever the shell says, and turning the capability on while `inferos.canvas.json` leaves the gatekeeper out is a startup error. A version 1 wrapper, or this checkout without a wrapper, keeps today's behaviour (on), unless the shell sets `INFEROPS_ENABLED=false` to try the off state; any other shell value fails startup. `inferos.canvas.json` still decides whether the gatekeeper is installed at all; installed and off, it keeps running so its sign-in works and existing board cards say InferOps is off instead of losing their connection. The release manifest does not set the var, so a cloud install is on (see Divergences).

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
- The release manifest has no deploy input for `INFEROPS_ENABLED` and leaves it unset, so a cloud
  install always has the integration on. Turning it off there needs the var set on the deployed
  worker by hand until the deploy service carries the wrapper's resolved capability.
- The tenant label of a resource URL is checked for syntax only. The design asks for it to match
  the identity's tenant slug when the identity carries one; InferLab's identity carries only the
  tenant id, so that comparison never applies today.
- Workspace slugs are read once per connect or reconnect, so a workspace joined or renamed later
  cannot be named until the person reconnects. An identity stored before slugs were kept has none,
  so every non-demo URL is refused for it until a reconnect.
- Bindings minted before the URI grammar changed keep working when they carry a workspace id
  (connected accounts) or name `demo.local`; a stopgap binding that named the API host does not.
- The transition endpoint's 404 does not say whether the issue or the target state is missing, so
  the HTTP client reports both as `NOT_FOUND`. `INVALID_STATE` is decided from the board when a
  move is proposed.
- The scope check and the transition or update are two requests; InferOps does not enforce the
  project.
- InferOps does not reject an idempotency key reused for a different request; only the mock does
  (`IDEMPOTENCY_CONFLICT`). The gatekeeper never reuses a key, and its stored fingerprint refuses
  to send a request that differs from the one approved.
- The mock still advances a revision by one per transition. Nothing depends on that.
- InferOps accepts mixed-case project identifiers; the resource grammar accepts uppercase keys
  only, so such a project is listed by the picker but cannot be bound.
- The Kanban gadget and the canvas do not read `Issue.pending` yet; they mark moves they requested
  themselves until the next refresh, and a provisional create card is draggable like any other
  (a move of it fails `NOT_FOUND`).
- The mock starts a created issue at revision 1 and numbers it after the highest existing key.

## Open Questions

- InferOps has not confirmed the contract or the companion changes
  ([factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326)).
- The HTTP client and the InferLab flows have not been run against a live InferOps; their
  evidence is a fake `fetch`.
- Nothing is cached, so an issue read costs two requests and a transition or update three (plus
  the board read at proposal).
- The content-only default state for a create (a board without software states) has no test: the
  demo fixture has no such project.

## Evidence

`custom-gatekeepers/gatekeeper-inferops/__tests__/gatekeeper.test.ts` (workerd, over the mock)
covers board reads and observations, cross-project denial, invalid state, workflow mismatch, stale
revision at proposal and at apply, refusal of a second move while one is pending, duplicate apply
replay, rejection clearing the simulation, revert, and observer admission; for creates and
updates, approval queued and not applied, the provisional card and update overlay, field
validation, change-of-nothing, conflict with a pending move or update, denial leaving nothing,
duplicate apply writing once, stale apply, update revert and its refusals, creates not revertible,
a legacy record without `kind` applied as a transition, and a tampered record refused by its
fingerprint.
`__tests__/http-inferops.test.ts` drives the HTTP client against a fake `fetch`: board mapping and
stripping, cross-project issue refused identically to an unknown one, stale revision, workflow
mismatch, replay of one idempotency key, create and update request shapes and headers, a create
whose response was lost retried under the same key into one issue, update replay, no PATCH for an
issue of another project, error mapping (400, 404, 409 conflict and workflow mismatch, 5xx, 403
workflow-policy refusal), rejected credential, 5xx, redirect, non-JSON and
malformed responses, and connection configuration. The gatekeeper's own tests never run its
sessions over the HTTP client; the integration suite below does. `__tests__/inferlab-login.test.ts` covers origin validation,
`providesAuth`, the authorize redirect, the PKCE exchange, the sign-in's logout and handoff,
single-use links and states, forged states, InferLab errors, rejected exchanges and unverified
emails. `__tests__/account.test.ts` drives connected accounts against a fake InferLab and InferOps
behind one `fetch`: the connect keeps the session, every request carries the person's token and
workspace, refresh ahead of expiry, healing a rejected token, a dead session reported once, revoke
signing out, a staged reconnect committed by the Workshop, workspace slugs stored at connect and
offered by slug, a URL's workspace slug resolving to the person's own workspace and credentials,
several workspaces each bound by its own slug, a workspace the person does not hold refused
exactly like a missing project before any request, a tampered tenant label granting nothing,
malformed authorities rejected without a request, `demo.local` staying demo data, a failed
workspace list failing the connect and signing the session out, InferOps denying a workspace
without expiring the account, observer admission by the collaborator's own membership, and a
create and an update proposed before the session ended not applied after it.
`__tests__/resources.test.ts` covers the grammar (two lowercase slug labels, no port, user info,
or third label) and keeps the configurator's copy in step, and `http-inferops.test.ts` the
`GET /workspaces` parsing and the stopgap's workspace slug.
`packages/bundled-blueprints/blueprints/inferops-kanban/__tests__/` covers the gadget's server and
board rules.

`packages/integration-tests/__tests__/inferops-isolation.test.ts` is the end-to-end isolation suite
(#23): the real Workshop and the real gatekeeper Worker under `createTestHarness`, driven over the
Workshop's RPC API, against a fake InferLab and InferOps (`packages/integration-tests/src/inferops-fake.ts`)
behind the network interceptor, with no request escaping it. The gatekeeper runs with
`INFERLAB_AUTH_ORIGIN` and `INFEROPS_BASE_URL` set and no stopgap token, so every case uses a
person's own account from the real connect flow: `connectAccount`, the gatekeeper's redirect to
`/authorize`, the `/oauth` callback whose PKCE exchange the fake verifies, `GET /workspaces`, and
the handoff ticket redeemed with `completeConnectHandoff` (a reconnect redeems it over a second
session, as the popup does). The fake has two workspaces of tenant `acme` (`operations` with ENG
and WEB, `knowledge` with OPS), people with mutable memberships, decimal-string revisions, writes
replayed by idempotency key, revocable sessions, a 503 switch for reads and for writes, and a
switch that commits a write and then drops the connection. It covers: a board read recorded as an
observation, with only the person's token and resolved workspace on every request and no
description on the wire to the caller; a workspace the person lacks, a missing workspace and a
missing project refused with one message shape and no request for the unheld workspace; another
workspace's project key, a changed tenant label (resolves only to the person's own workspace, per
ADR 0005), the API host as authority, and malformed authorities; a session bound to ENG unable to
open an issue of WEB (same workspace) or OPS; a collaborator without the project refused at
`openGadget` before any request with their token, and one with it verified with their own token
and seeing board data but no credential; writes queued without a request, one write per approval
with an idempotency key, a second approval refused, a stale revision refused at proposal and at
apply with nothing written; a create and an update whose responses were lost after commit retried
under the same key into one write; a session revoked at InferLab failing reads (`UNAUTHORIZED`)
and applies with nothing written, the account marked expired, and a reconnect restoring both; a
5xx surfacing `UNAVAILABLE` with nothing committed and a retry succeeding; a membership dropped in
InferOps refused by InferOps (`FORBIDDEN`) and, after a reconnect, by the gatekeeper before any
request, for old and new bindings alike; a disconnect signing the session out and failing the
account's bindings without a request; and no access token, refresh token, `Bearer` header or
issue description in any Workers runtime log (`TestHarness.getLogs()`) or failure message of the
run. With `INFEROPS_ENABLED` turned off by a harness reload, a read through an existing binding
fails `DISABLED`, a queued move is not applied and stays pending, and a new binding is refused,
all without a request; turned back on, the read works and the queued move applies. Remaining
gaps: it is fake-backed, so neither a live local InferOps run (#23's walkthrough) nor a cloud
smoke has been recorded, and the stopgap connection and `use`-role viewers are not exercised by
it. See [source ledger](../wiki/research-sources.md) for sibling repository revisions.
