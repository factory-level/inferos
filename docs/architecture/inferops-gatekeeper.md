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
  - packages/integration-tests/__tests__/inferops-live.test.ts
  - packages/integration-tests/src/inferops-fake.ts
  - packages/workshop-backend/src/server.ts
  - scripts/release/manifest-lib.ts
  - scripts/run-dev-server.ts
updated: 2026-10-06
---

# InferOps gatekeeper

## Overview

`custom-gatekeepers/gatekeeper-inferops` (package `@inferos/gatekeeper-inferops`, vendor id
`inferops`) implements the reviewed agent-facing API from the
[design](../design/inferops-gatekeeper.md). Its `src/types.d.ts` is the design's
`inferops-gatekeeper-api.d.ts` verbatim, plus `findBoards` (below): `InferOpsProjectSession` (`readBoard`, `openIssue`,
`createIssue`, `findBoards`) and `InferOpsIssueSession` (`read`, `transition`, `update`), with `Issue.pending`
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

A second resource kind, `inferops://<tenant>.<workspace>/project/dispatch/<KEY>`, binds the same
way to an `InferOpsDispatchGatekeeper` whose `InferOpsDispatchSession` (`listRepos`, `listRuns`,
`getRun`, `dispatch`, `cancel`) hands the project's software issues to the InferOps coding runner
through approved actions. It is a separate grant from the board, offered and served only while
`CODING_WORKBENCH_ENABLED` is on, and dispatches only the wrapper's allowlisted repositories; see
[local coding workflows](local-coding-workflows.md).

A third kind, `inferops://<tenant>.<workspace>/knowledge/wiki`, binds one workspace's InferMind Wiki
to an `InferOpsWikiGatekeeper` whose `InferOpsWikiSession` (`listDocuments`, `readDocument`,
`readDocumentText`, `updateSection`) reads pages as observations and proposes section edits as
approved actions ([#87](https://github.com/factory-level/inferos/issues/87)). Its workspace slug
resolves only among the person's InferMind workspaces. A page is referenced as
`…/knowledge/document/<slug>`, which `parseWikiDocumentUrl` parses for the canvas; a reference is
never bound.

The package is the reference [connection package](connection-extensions.md): `connection.json`
states its contract (resource kinds, reads and writes, approval, provider errors, simulation limits,
configuration names, the pinned InferOps revision), and `__tests__/conformance.test.ts` runs
gatekeeper-kit's shared conformance suite against a `project/board` binding.

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | Vendor (connected accounts with an InferLab origin, auto-provisioned demo accounts without), account (`GatekeeperUser`: bind, configurator, revoke, reconnect), verifier, project-board gatekeeper facet, sessions, `clientFor` (which data source and whose authority), HTTP entry for the sign-in legs. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts` | InferLab PKCE flows: `INFERLAB_AUTH_ORIGIN` validation, `inferOpsApiEndpoint` (the one place the API base URL comes from), `InferLabLogin` Durable Object per attempt (sign-in, connect or reconnect), `/authorize` redirect, `/oauth` callback, server-side code exchange, the workspace-slug read, and what each purpose does with the session. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-credentials.ts` | `InferOpsCredentials` Durable Object per connected account: the InferLab session (access and refresh token) under gatekeeper-kit's `CredentialCoordinator`, the identity and the InferOps and InferMind workspaces InferLab reported with each one's slug (an InferMind one marked `product: "infermind"`), slug resolution per product (`resolveWorkspace(slug, product)`, InferOps by default), refresh (`POST /auth/refresh`), logout (`POST /auth/logout`), staged reconnects, and the once-only expiry notice. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-client.ts` | `InferOpsClient` data-source contract (board, issues, and the coding calls `listRepos`, `listRuns`, `readRun`, `dispatchIssue`, `cancelRun`) and `InferOpsError` codes (`NOT_FOUND`, `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `CONFLICT`, `RUN_ACTIVE`, `UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`, `DISABLED`). |
| `custom-gatekeepers/gatekeeper-inferops/src/wiki.ts` | The Wiki's pure read projections, ported from InferOps: `[[target#tag]]` wikilinks, the standalone-paragraph `inferops://` references, and the agent text (`# <title>` and the section bodies). |
| `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts` | The `CODING_WORKBENCH_ENABLED` switch and `CODING_WORKBENCH_REPOS` allowlist for dispatch bindings ([local coding workflows](local-coding-workflows.md)). |
| `custom-gatekeepers/gatekeeper-inferops/src/mock-inferops.ts` | `MockInferOps` Durable Object per (host, account), seeded from `src/fixtures/demo-board.json`; the only module that holds project data. Serves host `demo.local` only. Implements transition, create and update with InferOps' checks and per-key replay, and refuses a key reused for a different request (`IDEMPOTENCY_CONFLICT`). Also two demo repositories and a run ledger with InferOps' dispatch guards and replay, and `setRunStatus` standing in for the runner. A synthetic Wiki (`src/fixtures/demo-wiki.json`: four pages, one without sections) with InferOps' section semantics (a write advances the version by one, takes no expected version and replays nothing), and `setInferMindEnabled` to make the demo workspace one without InferMind. `forget` (an account's `revoke`) deletes the account's data and leaves a tombstone, so every later call is refused `UNAUTHORIZED` rather than re-seeding demo data under a binding that outlived its account. Development only ([#28](https://github.com/factory-level/inferos/issues/28)): `MOCK_INFEROPS_SYNTHETIC_ISSUES=<n>` (1 to 2000, passed through by the dev server from the shell or `.dev.vars`) adds a deterministic synthetic project `PERF` of n issues over six states when an account's data is first seeded, for measuring the Kanban against a large board; unset or out of range it adds nothing (`__tests__/synthetic.test.ts`). |
| `custom-gatekeepers/gatekeeper-inferops/src/http-inferops.ts` | `openHttpInferOpsClient`: `InferOpsClient` over `fetch` for a fixed connection or an endpoint whose authority (token and workspace) is fetched per request, with field-by-field response parsing, the project-scope check and the error mapping. `listWorkspaceSlugs` reads `GET /workspaces` for the connect flow. `endpointFromEnv` reads the API base URL and `connectionFromEnv` the stopgap connection from worker vars. Its coding calls read `GET /project/repos` (dropping `gitUrl`), `GET /project/runs` (filtered to the bound project's issues), `GET /project/runs/<id>`, and send `POST /project/issues/<id>/dispatch` and `POST /project/runs/<id>/cancel`, each after the issue's or run's scope check. Its Wiki calls read `GET /knowledge/documents`, `/knowledge/documents/<id>`, `/knowledge/sections?documentId=<id>` (after finding the page) and `/knowledge/sections/<id>`, and send `PATCH /knowledge/sections/<id>` with `{body}` only (after finding the section), parsing InferOps' bare responses, answering `null` or an empty body as `NOT_FOUND`, and mapping every 403 to one `FORBIDDEN` message (`WIKI_FORBIDDEN`). The only module that talks InferOps HTTP. A run's result keeps `patch`, `tests` (the runner's test commands, counts and artifact paths) and `reasonCode` only when well formed, leaving out a malformed or unknown one whole (`parsePatch`, `parseTests`). |
| `custom-gatekeepers/gatekeeper-inferops/src/resources.ts` | Resource grammar `inferops://<tenant>.<workspace>/project/<kind>/<KEY>` with `<kind>` `board` or `dispatch`, and `inferops://<tenant>.<workspace>/knowledge/wiki` (two lowercase slug labels; `demo.local` is the demo data), the three `SupportedResource`s (the Wiki's with `excludeFromOperateChat`), `resourceKind`, `projectResourceKind`, `parseHost`, `isSlug`; the page reference `…/knowledge/document/<slug>` (`parseWikiDocumentUrl`, `wikiDocumentUrl`, slugs of URL-unreserved characters). |
| `custom-gatekeepers/gatekeeper-inferops/src/actions.ts` | The stored action records, a tagged union (`kind`: `transition`, `create`, `update` on a board binding; `dispatch`, `cancel` on a dispatch binding; `section-update` on a Wiki binding) each carrying the exact request it sends; `readAction` reads a record without `kind` (written before creates and updates) as a transition; `fingerprintOf`/`matchesFingerprint` hash the normalized request with the binding's scope, its project key or `knowledge/wiki` (SHA-256 over canonical JSON). |
| `custom-gatekeepers/gatekeeper-inferops/src/simulation.ts` | Board ordering and read-time overlay of pending actions: an issue's live pending transition or update (`pending` `transition` or `update`), and pending creates as provisional cards (`pending: "create"`). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/wiki-ui.tsx` | The Wiki picker: organization and workspace only, building `…/knowledge/wiki`; the account lists only the person's InferMind workspaces for it (and only InferOps ones for the project pickers). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx` | The same picker for a dispatch binding, building `…/project/dispatch/<KEY>`; offered only while coding dispatch is on. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/project-ui.tsx` | Organization, workspace and project picker built by the shared `build:configurator` task. It builds `inferops://<organization>.<workspace>/project/board/<KEY>` from an organization label, a workspace slug from the account's list and a project; with both left empty it asks the gatekeeper for a default host, which only a demo account has (`demo.local`). It duplicates the URL grammar for prefilling, kept in step by `__tests__/resources.test.ts`. |
| `scripts/run-dev-server.ts` | Passes `INFEROPS_BASE_URL`, `INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID` and `INFEROPS_WORKSPACE_SLUG` from the shell or root `.dev.vars` into the gatekeeper's generated dev config, resolves `INFERLAB_AUTH_ORIGIN` and `AUTH_GATEKEEPERS` for a wrapper's sign-in flag, and refuses to start when InferOps sign-in is asked for without the gatekeeper or an InferLab origin. |
| `packages/bundled-blueprints/blueprints/inferops-kanban` | Kanban gadget expecting a `board` binding of type `InferOpsProjectSession`. |
| `scripts/release/manifest-lib.ts` | Lists the gatekeeper as taking no default OAuth inputs and as install-once. It ships because its `connection.json` status is `reference`; an unreleased connection package does not. |

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
  backs a connected person. `getGatekeeperClassFor` reports a `demo.local` board, dispatch or Wiki
  URL as `mock` (the `GatekeeperUser` contract in `workshop-shared/src/gatekeeper.ts`), so the
  Workshop refuses it in an install into a workspace that is not test-only (see
  [Operate mode](operate-mode.md#pinned-installs-and-upgrades)); `__tests__/account.test.ts`
  checks the demo host is reported and a connected workspace is not.
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
  `Create issue: <title>`. One intent is one create: the binding stages it with `stageOnce`, which
  looks for a pending action with the same fingerprint (same normalized request in the same
  project) in the same synchronous step that would write the new record, and joins it instead, so
  a second tab or a retried submit proposing the same issue while it is pending queues nothing and
  returns as the first did
  ([#63](https://github.com/factory-level/inferos/issues/63)). Once it is applied or rejected the
  same proposal is a new intent. Edits and moves need no such step: a pending change already
  refuses another of the same issue (`CONFLICT`), and the same edit again sends nothing because the
  overlaid issue already shows it.
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
- **Board discovery** ([#61](https://github.com/factory-level/inferos/issues/61)).
  `findBoards(query)` (1-200 characters, else `INVALID_REQUEST`) lists the projects of the
  binding's InferOps workspace and, for a connected person, of every other InferOps workspace their
  stored identity names with a slug (`#otherWorkspaces`: InferLab's list at connect time, InferMind
  workspaces left out), each with the person's own token in that workspace
  (`GET /project/projects`; the credentials object refuses any workspace that is not theirs). The
  tenant label of the other workspaces is the binding's. The stopgap connection and the demo serve
  one workspace and search only the binding's. A failure in the binding's own workspace fails the
  call; another workspace InferOps now refuses (`FORBIDDEN` or `NOT_FOUND`: membership removed
  since connect) is left out. It keeps the bindable keys, reads the open issues of the first 20
  across all of them (`MAX_DISCOVERY_SCANNED_PROJECTS`; a board that cannot be read is matched on
  key and name only), and ranks them with the pure
  `rankBoards` in `src/board-discovery.ts`: query words, lowercased, crudely stemmed and with
  common words dropped, are matched against the project key, its name and its open issue titles.
  It returns at most 8 candidates `{tenant, workspace, projectKey, boardRef, title, reasons}`, best
  first, and only those that matched something, so an empty list means no match and ties are kept
  for the caller to disambiguate; equal scores are ordered by key, then workspace. Each candidate
  names its own workspace and `boardRef`. Issue titles never leave the gatekeeper; reasons quote
  only the query's own words and counts. The search is one observation (`Searched InferOps boards
  on <host>`, or `on <host> and <n> other workspaces`, with the workspaces searched and the project
  and candidate counts) whose `excludeObservers` names every observer of
  the binding, since they were admitted for its one project only; the overseer therefore refuses
  the search in a workspace shared with others, and it works in a person's own operate session
  workspace. A refused or revoked listing (`FORBIDDEN`, `UNAUTHORIZED`) fails the call, naming
  nothing. A candidate grants nothing: it is opened only through a connection made for its
  `boardRef` from the person's own account (see [operate mode](operate-mode.md)). Discovery is
  local and explainable; there is no index or embedding.
- **Observers.** Strategy B: `addObserver` asks the collaborator's own `InferOpsVerifier` whether
  their account can open the bound project in the binding's workspace, with their own token. A
  board binding remembers each admitted observer id (`observer:<id>`) only for `findBoards`'
  exclusions, and `removeObserver` forgets it; a dispatch binding tracks nothing. `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN` and no membership of that
  workspace mean no access; any other failure fails the open.
- **Coding dispatch.** A dispatch binding's facet, `InferOpsDispatchGatekeeper`, reuses the board's
  binding state (instance id, action records, fingerprints, idempotency keys) and observer strategy
  B, but its data source is guarded by `CODING_WORKBENCH_ENABLED` as well as `INFEROPS_ENABLED`.
  `dispatch` and `cancel` are staged and submitted like board writes, with action kinds
  `inferops.code-dispatch` and `inferops.run-cancel`; `applyAction` rechecks the switch, the
  allowlist and the fingerprint before sending. A 409 `RUN_ACTIVE` maps to `RUN_ACTIVE` (it was
  `CONFLICT`, which only a dispatch can receive), and a refused apply names the missing
  `issue:delegate`, an active run, a stale revision or the switch. The full flow is in
  [local coding workflows](local-coding-workflows.md#data-and-control-flow).
- **InferMind Wiki.** At connect, InferLab's InferMind memberships are now kept beside the InferOps
  ones (`product: "infermind"`; an identity stored before has none, so its Wiki needs a
  reconnect). `getGatekeeperClassFor` parses `…/knowledge/wiki`, resolves the slug among the
  person's InferMind workspaces (one of their InferOps workspaces is refused with
  `FORBIDDEN: <host> is an InferOps workspace without InferMind, so it has no Wiki.` before any
  request), lists the pages once to check the Wiki answers, and returns `InferOpsWikiGatekeeper`
  with props `{accountId, connected, host, workspaceId}`. A workspace the person lacks and a host
  no data source serves fail with `No InferMind Wiki is available on <host>.`; InferOps' 403 is
  passed on as `FORBIDDEN`. The data source is `clientFor`'s, so `INFEROPS_ENABLED` guards every
  call. The facet shares the action store (`ActionBinding`) with the project facets.
  `readDocument(slugOrId)` resolves a slug through the page list, reads the page and its sections,
  overlays a pending edit on a section still at the version it was proposed at, and adds the
  wikilinks and references (wiki.ts); `readDocumentText` joins the same sections and answers a
  page without sections `NOT_FOUND`. Each read is an observation; `listDocuments` returns the tree
  fields only. `updateSection` checks the version (decimal integer, `INVALID_REQUEST` otherwise),
  the body length (at most 100000), the section's current version (`STALE_REVISION`), a body equal
  to the shown one (no-op) and a live pending edit (`CONFLICT`), reads the page title, stages a
  `section-update` with the previous body, and submits it with action kind
  `inferops.wiki-section-update`, showing page, section, expected version and the current and new
  text. `applyAction` requires the fingerprint (a record without one is refused), reads the
  section, PATCHes under `<instance>:<action>` only while it is at the expected version, counts a
  section already showing the approved body as applied without writing, and otherwise refuses it
  as stale; it records the version InferOps reported. `revertAction` restores the previous body
  under `<instance>:<action>:revert` only while the section is at that version with that body.
  Observers: strategy B through the verifier's `hasWikiAccess(host, workspaceId)`, a page list with
  the collaborator's own token.
  The Wiki's `SupportedResource` sets `excludeFromOperateChat`
  ([#61](https://github.com/factory-level/inferos/issues/61)), so the Workshop keeps it out of
  operate chats: not offered, not requestable, left out of the agent's env and refused to its
  `describeBinding` and sessions there (see [operate mode](operate-mode.md)). The person's own use
  of a Wiki connection, Build chats and the canvas Wiki widget are unaffected.
- **Kanban gadget.** Its Durable Object proxies `loadBoard()` to `env.board.readBoard()` and
  `moveIssue()` to `env.board.openIssue(id).transition(stateId, revision)` (pipelined, then
  disposed), returning failure codes as data. The client renders columns, drag and drop, and a
  per-card "Move to…" select, reloads on `STALE_REVISION`, and shows a not-connected notice when the
  binding is absent.

## Configuration

`cloudflare.config.ts` uses the shared gatekeeper factory (`allow_irrevocable_stub_storage`,
migrations `v0`: `MockInferOps`, `InferOpsProjectGatekeeper`, `v1`: `InferLabLogin`,
`InferOpsCredentials`, `v2`: `InferOpsDispatchGatekeeper`, and `v3`: `InferOpsWikiGatekeeper`); `wrangler.jsonc` is generated. The worker needs no secrets. `BASE_URL` is
set per deployment like every gatekeeper's. Discovery under `custom-gatekeepers/` binds it as
`GATEKEEPER_INFEROPS`. The release manifest gives it no deploy inputs and marks it install-once.

The vars below are declared in `src/env.d.ts` and left unset in the committed `wrangler.jsonc`;
`pnpm dev-server` passes the InferOps ones through from the shell or the root `.dev.vars`
(`PASSTHROUGH_GATEKEEPER_VARS`) and resolves `INFERLAB_AUTH_ORIGIN` from the shell or a wrapper's
sign-in flag (default `http://localhost:8080`, the local InferLab stack).

| Var | Meaning |
| --- | --- |
| `INFEROPS_ENABLED` | `"true"` or `"false"`: the integration switch (below). Unset counts as on, so deployments that predate it keep working; anything else is off. `pnpm dev-server` always sets it. |
| `CODING_WORKBENCH_ENABLED` | `"true"` turns coding dispatch on; anything else, or unset, is off, and it is off while `INFEROPS_ENABLED` is. `pnpm dev-server` always sets it ([local coding workflows](local-coding-workflows.md#configuration)). |
| `CODING_WORKBENCH_REPOS` | The allowlisted InferOps repository ids, comma-separated, from the wrapper's `codingWorkbench.repos`. Unset allows none. |
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

- `findBoards` is not in the design's API. It runs on a board session, so a person needs one board
  connection before they can discover the others; from it, a connected person's search covers every
  InferOps workspace they held at connect time (a workspace joined since needs a reconnect).

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
- The Kanban gadget does not read `Issue.pending` yet; it marks moves it requested itself until the
  next refresh, and a provisional create card is draggable like any other (a move of it fails
  `NOT_FOUND`). The canvas Kanban reads it (see [InferOps canvas](inferops-canvas.md#kanban-board)).
- The mock starts a created issue at revision 1 and numbers it after the highest existing key.
- A Wiki section edit's version check and its write are two requests (InferOps' `PATCH` takes no
  expected version), so an edit made in InferMind between them is overwritten; and a section that
  someone else set to exactly the approved body counts as the edit applied.
- InferOps' 403 on a Wiki call does not say whether the product or the permission refused it, so
  InferOS reports both with one message. Only a connected account's own InferOps workspace is
  told apart before any request; a stopgap or demo binding learns it from InferOps.

## Open Questions

- InferOps has not confirmed the contract or the companion changes
  ([factory-level/inferops#2326](https://github.com/factory-level/inferops/issues/2326)).
- The HTTP client and the InferLab flows have not been run against a live InferOps; their
  evidence is a fake `fetch`.
- Nothing is cached, so an issue read costs two requests and a transition or update three (plus
  the board read at proposal).
- The content-only default state for a create (a board without software states) has no test: the
  demo fixture has no such project.
- The Wiki client has not been run against a live InferOps knowledge API. That a missing page or
  section is answered `200 null` is read from InferOps' route code (`getDocument`/`getSection`
  return null), and the client accepts an empty body the same way.

## Evidence

`custom-gatekeepers/gatekeeper-inferops/__tests__/gatekeeper.test.ts` (workerd, over the mock)
covers board reads and observations, cross-project denial, invalid state, workflow mismatch, stale
revision at proposal and at apply, refusal of a second move while one is pending, duplicate apply
replay, rejection clearing the simulation, revert, and observer admission; for creates and
updates, approval queued and not applied, the provisional card and update overlay, field
validation, change-of-nothing, conflict with a pending move or update, denial leaving nothing,
duplicate apply writing once, stale apply, update revert and its refusals, creates not revertible,
a legacy record without `kind` applied as a transition, a tampered record refused by its
fingerprint, and two sessions proposing the same create at once queueing one action (a different
priority is its own, and an applied one no longer joins).
`__tests__/conformance.test.ts` runs the shared connection conformance suite
([connection packages](connection-extensions.md)) on a `DEMO` board binding: scope, observation and
sharing, approval and apply-once, stale revision at apply, retry after a 503 and after a lost
response (from the test worker's fault-injecting `MockInferOps`), and revocation stopping reads and
an already-approved write.
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
`__tests__/wiki.test.ts` (workerd, over the mock) covers the Wiki: its grammar and the page
reference, binding the demo Wiki and refusing another workspace or tenant, a workspace without
InferMind refused at binding, on every read and at apply, the page list and page reads as
observations with versions, wikilinks and only standalone references, the agent text, unknown,
malformed and section-less pages, an edit queued and shown pending and written once on approval,
stale, unknown and malformed edits refused at proposal, an unchanged body and a second pending
edit, an edit made stale in InferOps refused at apply, an edit already in effect counted as
applied without a second write, a tampered or unsigned record refused by its fingerprint,
rejection, revert and its refusal, `INFEROPS_ENABLED` off and on, and observer admission.
`account.test.ts` adds a connected person's InferMind workspace bound by slug with their own token
there, one of their InferOps workspaces refused as having no Wiki and an InferMind one refused as
a board (both before any request), an unheld workspace refused like a missing Wiki, a tampered
tenant label, InferOps' product or permission refusal as one `FORBIDDEN`, and Wiki observer
admission; `http-inferops.test.ts` the knowledge requests, `null` and empty answers, the 403
message, a section of another page, and malformed responses; `resources.test.ts` the Wiki
picker's copy of the grammar.
`__tests__/resources.test.ts` covers the grammar (two lowercase slug labels, no port, user info,
or third label) and keeps the configurator's copy in step, and `http-inferops.test.ts` the
`GET /workspaces` parsing and the stopgap's workspace slug.
`packages/bundled-blueprints/blueprints/inferops-kanban/__tests__/` covers the gadget's server and
board rules.

`packages/integration-tests/__tests__/inferops-isolation.test.ts` is the end-to-end isolation suite
(#23): the real Workshop and the real gatekeeper Worker under `createTestHarness`, driven over the
Workshop's RPC API, against a fake InferLab and InferOps (`packages/integration-tests/src/inferops-fake.ts`)
behind the network interceptor (the fake also has a runner lane, `runnerKey` and `serve()`, used by
the mocked coding-runner suite; see [local coding workflows](local-coding-workflows.md#evidence)), with no request escaping it. The gatekeeper runs with
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
all without a request; turned back on, the read works and the queued move applies. Coding dispatch
(run with `CODING_WORKBENCH_ENABLED` on and one allowlisted repository) is covered by its own cases,
listed under [local coding workflows](local-coding-workflows.md#evidence). The fake also serves an
InferMind Wiki in two InferMind workspaces (`mind`, `notes`) with InferOps' product gate,
`knowledge:read`/`write`, `null` for another workspace's page or section and an unversioned,
unreplayed section `PATCH`; the Wiki cases cover reads with the person's own token in their
InferMind workspace recorded as observations, a text projection carrying no board data and nothing
of the other workspace, another workspace's page never readable or editable by UUID or slug, its
Wiki and an InferOps workspace's refused before any request, an approved edit written once and a
lost response not written twice, an edit made stale refused at apply, a read-only person refused
the edit by InferOps, and no seeded section body in any log or failure message. Remaining
gaps: it is fake-backed (a live local run is recorded below, through the stopgap connection), no
cloud smoke has been recorded, and `use`-role viewers are not exercised by it. See [source ledger](../wiki/research-sources.md) for sibling repository revisions.

### Live run

`packages/integration-tests/__tests__/inferops-live.test.ts` is an opt-in suite, skipped unless
`INFEROPS_LIVE_BASE_URL` is set (so CI never runs it), that drives the same real Workshop and
gatekeeper Worker against a running InferOps and checks every step by also reading InferOps
directly with the same token. It uses the local-development stopgap connection
(`INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID`, `INFEROPS_WORKSPACE_SLUG`, no
`INFERLAB_AUTH_ORIGIN`) on an auto-provisioned account, because InferOps refuses SSO codes for
non-Google sessions (inferops ADR 0012) and so the per-person connect cannot complete against a
stub-auth InferOps. Its file header lists the variables and the run command.

Run on 2026-10-03 against InferOps `develop` at `9bc02d68` (`bun run dev up`, stub auth, seeded:
tenant `acme`, workspace `operations`, project ENG) from InferOS `4a4504c` (main after #107) plus
this suite, with an `owner` persona bearer token. All eight steps passed:

| Step | Result |
| --- | --- |
| Bind and read | `inferops://acme.operations/project/board/ENG` bound; its five columns (Backlog, Todo, In Progress, Done, Cancelled) and every card at its revision match InferOps' own board; the read is recorded as an observation. |
| Create | `createIssue` queued an action and nothing in InferOps; on approval ENG-12 (`d908ec1b-6fac-4043-a67a-121c458e4080`) existed exactly once, in Todo, at revision 221, and the board showed it at that revision. |
| Update | Title and priority proposed at 221, InferOps unchanged until approval, then new values at revision 223. |
| Transition | Move to In Progress at 223, applied on approval, revision 224. |
| Stale revision | An update at revision 221 refused at proposal with `STALE_REVISION`; InferOps stayed at 224. |
| Duplicate | Approving each of the three applied actions again refused (`not pending`); revision 224, one issue. |
| Reload | After a harness configuration update restarted the Workers, the same binding read ENG-12 at revision 224. |
| Policy refusal (content issue) | The suite created project CPOL (`94809123-d93d-4d87-bcc8-5f5bac2877f9`, reused on later runs) and published content workflow policy revision 1: every user may take every action and any edge (`*` to `*`), except that the Draft to Published edge denies `move-in` to every user (`workflow/validate` clean, `workflow/explain` answers `EXPLICIT_DENY` for that edge and allows Draft to Review). Bound `inferops://acme.operations/project/board/CPOL`, created content issue CPOL-3 (`956b0e27-79a0-49d7-89fa-4df827da5fdd`) in Idea at revision 235 through approval, and moved it to Draft (applied, revision 236). Draft to Published was proposed and approved; proposing only simulates, so InferOps was first asked at apply and refused it. The approval failed with "CPOL-3 → Published was not applied: InferOps does not permit it for this connection (its access or the workflow policy refused it)." The issue stayed in Draft at revision 236, and the same move made directly answered 403 `FORBIDDEN` with `EXPLICIT_DENY`. Draft to Review then applied (revision 237). |

Revisions are InferOps' own and are treated as opaque (an update advanced ENG-12 by two). A run with
an expired persona token failed the first read with `UNAUTHORIZED` and wrote nothing. Each run
leaves its `InferOS live <timestamp>` issue in ENG and its content issue in CPOL in place, since
InferOps has no issue delete. The policy step needs a token that holds `project:manage` (the seed's
`owner` does) for the first publish. A later publish of the same document is a no-op. Not proven
by this run: per-person identity (every request carried one shared persona token; the live Google
sign-in of #66 remains a manual step), a role-scoped refusal (the policy denies the edge to every
user, because the stopgap connection carries one persona), and a cloud deployment.

### Wave 3 live run (2026-10-03)

The same suite gained two opt-in steps, each skipped with its reason when its variables are unset:
step i (coding dispatch, `INFEROPS_LIVE_REPO_ID`) and step j (the InferMind Wiki,
`INFEROPS_LIVE_WIKI_WORKSPACE_ID` and `INFEROPS_LIVE_WIKI_WORKSPACE_SLUG`). With the repository
set, the harness runs the gatekeeper with `CODING_WORKBENCH_ENABLED=true` and that id alone on
`CODING_WORKBENCH_REPOS`. Step j reconfigures the stopgap connection's workspace to the InferMind
one through a harness restart, because the stopgap names one workspace. No product code changed.

**Stub-token evidence.** Every request carried one `owner` persona bearer token from
`POST /auth/inferlab-login` (stub auth). This is not per-person Google identity: the Google sign-in
(#66) and the Codex ChatGPT sign-in were deferred by the owner and not attempted.

Run against InferOps `develop` at `abeca60a4979186a674994091673121a937bdb8b` (the
`inferops-wave2-live` worktree, offset 2, API `:8280` started without the file watcher, migrated
and seeded) from InferOS `3eaaf69` (main after #123) plus this change. All ten steps passed in the final run, recorded here.
Steps a to h repeated the run above (ENG-18 `b351c7aa-86ae-4a21-b24f-4022ebec78d6`, revisions
496 to 499; CPOL-8 `58dfcae7-43e2-4f4a-a4dc-743bd92d2953`, revisions 510 to 512).

| Step | Result |
| --- | --- |
| i. Coding dispatch | Repository `live-fork` (`044a6a45-456e-4e43-9d6d-9a6f6253fb22`) was enrolled beforehand with `POST /project/repos`. Its `gitUrl` is `ssh://localhost/<path>` naming a throwaway local git repository, because InferOps accepts only `https`, `ssh` or `git@` URLs. The suite created project CODE (`68b9d056-60f9-4a44-878d-a8a1aee5551f`, from the workflow templates) and issue CODE-4 (`14080952-cc5d-489f-ada3-936b59b82d80`) in Ready through approval. A board binding's `dispatch` failed ("The RPC receiver does not implement the method "dispatch"."), and InferOps had no run. `inferops://acme.operations/project/dispatch/CODE` was bound. `listRepos` returned 1 repository, the only one allowed. An off-allowlist repository was refused `FORBIDDEN` before any proposal. A dispatch at revision 523 showed a provisional run, and InferOps had none. On approval, run `a7719215-5b69-4ded-9717-0b04655b0c3b` was queued in InferOps: `GET /project/runs/:id` and `getRun` agree, and the issue moved to Queued at revision 524. A second dispatch was refused `RUN_ACTIVE` by the gatekeeper, and the same request made directly got 409 `RUN_ACTIVE`. A dispatch at revision 523 was refused `STALE_REVISION`. A cancel stayed pending, with the run still queued, until it was approved. Then the run was `cancelled` in InferOps, and the issue was at revision 525. A dispatch was proposed at 525, and the issue was then edited directly (revision 529). On approval, InferOps refused it with 409 `STALE_REVISION` ("…the issue changed in InferOps after this dispatch was proposed…"), and no second run was made. No runner was started, so no run was claimed or executed. |
| j. Wiki | `inferops://acme.operations/knowledge/wiki` was refused while the stopgap was the InferOps workspace. InferOps' product gate answered `GET /knowledge/documents` with 403 "Wrong product for this route", and the gatekeeper passed it on as `FORBIDDEN` ("…the workspace is not an InferMind workspace…"). Restarted on workspace `knowledge` (`00000000-0000-4000-8000-000000000012`, product `infermind`), `inferops://acme.knowledge/knowledge/wiki` was bound. `listDocuments` returned InferOps' 10 pages. `readDocument("gripper-feedback")` (`00000000-0000-4000-8000-000000000363`, 1 section, 0 references) matched InferOps' sections, and `readDocumentText` equalled `# <title>` plus the section bodies. An edit of section `gripper` (`00000000-0000-4000-8000-000000000385`) proposed at version 9 read back as pending while InferOps kept the old body. On approval it was written, and the version went from 9 to 10 (`GET /knowledge/sections/:id`). An edit at version 9 was refused `STALE_REVISION` at proposal. An edit proposed at version 10 and overtaken by a direct `PATCH` (version 11) was refused at apply ("…the section changed in InferOps after this edit…"), and the section stayed at version 11. InferOps' `PATCH` takes no expected version, so this apply-time check is the gatekeeper's own. |

Findings:

- **The seeded ENG project cannot be dispatched.** Its states (Backlog, Todo, In Progress, Done,
  Cancelled) predate InferOps' workflow templates and have no software `Queued` state. InferOps'
  `dispatchCode` then answers `POST /project/issues/:id/dispatch` with 404 `NOT_FOUND` ("Resource
  not found"), the error it uses for a missing issue. The gatekeeper proposes such a dispatch, since
  it checks the issue, repository and runs but not the target state. At apply it now says InferOps found
  no issue to dispatch or the project's workflow has no Queued state, since the two share one 404. The first live attempt, on ENG-14, failed this
  way, which is why step i uses a templated project (`INFEROPS_LIVE_DISPATCH_PROJECT`, default
  `CODE`).
- Four earlier runs on the same database, while the suite was being written, made ENG-14 to
  ENG-17, CPOL-4 to CPOL-7, CODE-1 to CODE-3 with cancelled runs
  `9c6b0821-dfd4-4066-9d7d-d6b31ee3daed`, `63e40a7d-5d7e-44c6-935c-51a69b8d9160` and
  `868b763e-a48f-40d6-ad98-ce3d8c428e16`, and edits of section `gripper` (versions 1 to 9).

Left in InferOps, none of it deletable through the API: the issues above, repository `live-fork`,
project CODE, the cancelled runs, and section `gripper` at version 11 with the runs' marker lines.
