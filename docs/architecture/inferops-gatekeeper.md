---
title: InferOps gatekeeper
covers:
  - custom-gatekeepers/gatekeeper-inferops
  - packages/bundled-blueprints/blueprints/inferops-kanban
  - packages/bundled-blueprints/blueprints/inferops-records
  - packages/bundled-blueprints/blueprints/inferops-members
  - packages/bundled-blueprints/blueprints/inferops-workflow-policy
  - packages/gatekeeper-kit
  - packages/workshop-shared/src/gatekeeper.ts
  - packages/workshop-backend/src/user.ts
  - packages/workshop-backend/src/auth/config.ts
  - packages/integration-tests/__tests__/inferops-isolation.test.ts
  - packages/integration-tests/__tests__/inferops-live.test.ts
  - packages/integration-tests/__tests__/inferops-members-live.test.ts
  - packages/integration-tests/__tests__/inferops-workflow-policy-live.test.ts
  - packages/integration-tests/__tests__/operate-chat-no-workflow-policy.test.ts
  - packages/integration-tests/__tests__/inferops-workflow-policy-gadget.test.ts
  - packages/integration-tests/src/inferops-fake.ts
  - packages/workshop-backend/src/server.ts
  - scripts/release/manifest-lib.ts
  - scripts/run-dev-server.ts
updated: 2026-10-15
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
to an `InferOpsWikiGatekeeper` whose `InferOpsWikiSession` (`listDocuments`, `readStructure`,
`readDocument`, `readDocumentText`, `updateDocumentBody`, `updateSection`, `listProposals`,
`readProposal`, `approveProposal`) reads the Wiki's structure and pages as observations and
proposes page body and section edits as approved actions
([#87](https://github.com/factory-level/inferos/issues/87)), and reads InferOps' drafted page
proposals and approves one for publication as an owner-only approved action (MVP-40; see
[Wiki proposal approval](#wiki-proposal-approval)). Its workspace slug
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
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-client.ts` | `InferOpsClient` data-source contract (board, issues, the coding calls `listRepos`, `listRuns`, `readRun`, `dispatchIssue`, `cancelRun`, and the Wiki calls, among them `readDocument` with the page's body, version and Master role, `readStructure`, `updateDocument` and the proposal calls `listProposals`, `readProposal` and `approveProposal`, whose refusals read as `PROPOSAL_APPROVE_REFUSED` in both implementations) and `InferOpsError` codes (`NOT_FOUND`, `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `CONFLICT`, `RUN_ACTIVE`, `UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`, `DISABLED`), with the facts a failure proves: its `WriteStage` (`unsent`, or `refused` by InferOps in answer to the write: a 401, or a 400, 403, 404 or 409 carrying InferOps' error envelope) and whether a `FORBIDDEN` is a workflow-policy refusal. They hold only in the isolate that raised the error; `atStage` restores a stage across the mock's RPC boundary. |
| `custom-gatekeepers/gatekeeper-inferops/src/apply-attempts.ts` | What an unsuccessful apply proves (`classifyAttempt`), each kind's `ApplyPolicy` (`BOARD_WRITES`, `PROPOSAL_APPROVE`, `RECONCILE_ONLY`), `CheckRefused` for a gatekeeper check that refuses before sending, and which refusals can pass (`canPass`). |
| `custom-gatekeepers/gatekeeper-inferops/src/wiki.ts` | The Wiki's pure read projections, ported from InferOps: `[[target#tag]]` wikilinks, the standalone-paragraph `inferops://` references, and InferOps' page-text contract (`domains/knowledge/shared/document-text.ts`, mirrored exactly): `composeDocumentText` gives `# <title>`, a blank line, then the body without a leading H1 equal to the title (`bodyWithoutTitle`; any other heading stays), or the visible section bodies when the body is blank, then a Master's generated block (`masterStructureText`: `<!-- generated: wiki structure -->`, then `## Pillars` with a `/wiki/<encoded master slug>` link per pillar for the root, or `## Pages in <pillar>` with one per member for a pillar Master, `(none yet)` when empty), joined by blank lines, and null when nothing is left. `documentText` (title and sections) stays for the canvas test double. |
| `custom-gatekeepers/gatekeeper-inferops/src/table.ts` | Custom tables: the `INFEROPS_TABLES_ENABLED` switch (`tablesEnabled`, `assertTablesEnabled`, `whileTablesEnabled`), the read options (`tableReadOptions`: `relatedTo` an `inferops://` reference, `limit` 1 to 50) and the projection (`describeTable`, `projectRows`) that drops personal columns and link labels. See [custom tables](#custom-tables). |
| `custom-gatekeepers/gatekeeper-inferops/src/members.ts` | Workspace members: the `INFEROPS_MEMBERS_ENABLED` switch (`membersEnabled`, `assertMembersEnabled`, `whileMembersEnabled`), the one refusal (`membersNotFound`) and the projection (`projectMembers`) that drops the email. See [workspace members](#workspace-members). |
| `custom-gatekeepers/gatekeeper-inferops/src/host-board.ts` | Host boards: the `INFEROPS_HOST_BOARDS` switch (`hostBoardsEnabled`), the canonical reference built from a board binding's props (`hostBoardRef`: an uppercase key of at most ten) and the normalized answers. The facet methods are on `InferOpsProjectGatekeeper` (`readHostBoard`, `hostBoardFence` in `inferops.ts`), and the request and parser in `http-inferops.ts` (`fetchBoardSnapshot`, `parseBoardSnapshotResponse`). See [host boards](#host-boards). |
| `packages/gatekeeper-kit/src/host-board.ts` | The kernel-only facet contract `HostBoardReader` (`readHostBoardSnapshot()`) and `HostBoardConnectionFence` (`connectionIdentity()`), the `HostBoardRead` statuses (`ok`, `not-connected`, `unavailable` with a bounded reason, `stale`) and `HOST_BOARD_LIMITS`. Types and constants only; no kernel code imports it yet. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/table-ui.tsx` | The custom-table picker: organization, workspace and table, building `…/object/table/<tableId>`; offered only while custom tables are on. |
| `custom-gatekeepers/gatekeeper-inferops/src/workflow-policy.ts` | Workflow policy: the `INFEROPS_WORKFLOW_POLICY_ENABLED` switch (`workflowPolicyEnabled`, `assertWorkflowPolicyEnabled`, `whileWorkflowPolicyEnabled`), the one refusal (`workflowPolicyNotFound`), the strict parse of `workflow.get`'s `{head}` against the provider's own v2 schema (`readWorkflowPolicyAnswer`) and the projection that drops `publishedBy`, `agents` and every rule `reason` (`projectWorkflowHead`). See [workflow policy](#workflow-policy). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/workflow-ui.tsx` | The workflow-policy picker: the project-board picker with the `…/project/workflow/<KEY>` path; offered only while workflow policies are on. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/members-ui.tsx` | The workspace-members picker: organization and workspace only, building `…/portal/members`; offered only while workspace members are on. |
| `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts` | The `CODING_WORKBENCH_ENABLED` switch and `CODING_WORKBENCH_REPOS` allowlist for dispatch bindings ([local coding workflows](local-coding-workflows.md)). |
| `custom-gatekeepers/gatekeeper-inferops/src/mock-inferops.ts` | `MockInferOps` Durable Object per (host, account), seeded from `src/fixtures/demo-board.json`; the only module that holds project data. Serves host `demo.local` only. Implements transition, create and update with InferOps' checks and per-key replay, and refuses a key reused for a different request (`IDEMPOTENCY_CONFLICT`). Also two demo repositories and a run ledger with InferOps' dispatch guards and replay, and `setRunStatus` standing in for the runner. A synthetic Wiki (`src/fixtures/demo-wiki.json`, stored under `wiki:v2`: a company root without a body, two pillars with Masters (Engineering has neither body nor sections), a body-only SOP whose body opens with its title, a slash-slugged SOP `dispatch/dispatch-a-crew` filed in both pillars whose body opens with another heading, a page with both a body and a section, and one with nothing to read) with InferOps' section semantics (a write advances the version by one, takes no expected version and replays nothing), its page semantics (`updateDocument` is a strict compare-and-swap on the page version that replays only the same key with the same expected version and body one version on, a receipt standing in for InferOps' key, principal, expected version, operation and payload) and its structure read (pillars by position, members by title, the unfiled pages), and `setInferMindEnabled` to make the demo workspace one without InferMind. Its drafted proposals (the fixture's `proposals`, stored under `wiki:proposals:v1` and hashed over InferOps' canonical proposal document) follow InferOps' `approveProposal` exactly: the account's role (`setProposalRole`; Viewer and Member lack `knowledge:publish`), replay for the same principal and hash on a decided proposal, `CONFLICT` for another decided state or a failed integrity re-hash, stale for a superseded revision, another hash or other sources, the self-decision refusal for the requester or reviser (the demo account is principal `MOCK_PRINCIPAL`), and a new page's parent. An approval queues one publish job; the test-only `runPublishJobs` claims each approved proposal once and publishes it as InferOps' job does (an edit keeps the page's id, parent, order, Master role and pillars; a new page goes under its parent, filed in its pillar) or ends it `stale`; `reviseProposal`, `seedProposal` and `proposalCounts` serve the tests. `forget` (an account's `revoke`) deletes the account's data and leaves a tombstone, so every later call is refused `UNAUTHORIZED` rather than re-seeding demo data under a binding that outlived its account. Development only ([#28](https://github.com/factory-level/inferos/issues/28)): `MOCK_INFEROPS_SYNTHETIC_ISSUES=<n>` (1 to 2000, passed through by the dev server from the shell or `.dev.vars`) adds a deterministic synthetic project `PERF` of n issues over six states when an account's data is first seeded, for measuring the Kanban against a large board; unset or out of range it adds nothing (`__tests__/synthetic.test.ts`). |
| `custom-gatekeepers/gatekeeper-inferops/src/http-inferops.ts` | `openHttpInferOpsClient`: `InferOpsClient` over `fetch` for a fixed connection or an endpoint whose authority (token and workspace) is fetched per request, with field-by-field response parsing, the project-scope check and the error mapping. `listWorkspaceSlugs` reads `GET /workspaces` for the connect flow. `endpointFromEnv` reads the API base URL and `connectionFromEnv` the stopgap connection from worker vars. Its coding calls read `GET /project/repos` (dropping `gitUrl`), `GET /project/runs` (filtered to the bound project's issues), `GET /project/runs/<id>`, and send `POST /project/issues/<id>/dispatch` and `POST /project/runs/<id>/cancel`, each after the issue's or run's scope check. Its Wiki calls read `GET /knowledge/documents`, `/knowledge/documents/<id>` (with `body`, `version` and `masterRole`, an absent role read as none), `/knowledge/wiki/structure` (each page's `documentId`, slug, title and parent, a pillar's key, title, position, Master and members with their `source`, all checked field by field), `/knowledge/sections?documentId=<id>` (after finding the page) and `/knowledge/sections/<id>`, and send `PATCH /knowledge/sections/<id>` with `{body}` only (after finding the section) and `PATCH /knowledge/wiki/pages/<id>` with `{body, expectedVersion}` and the key, unread first (its 409 `STALE_VERSION` maps to `STALE_REVISION`, its 404 to `NOT_FOUND`), parsing InferOps' bare responses, answering `null` or an empty body as `NOT_FOUND`, and mapping every 403 to one `FORBIDDEN` message (`WIKI_FORBIDDEN`). Its proposal calls read `GET /knowledge/wiki/proposals[?state=]` and `/knowledge/wiki/proposals/<id>` (field by field, dropping every principal, the decision note, the grounding and the approved-source copy; a 404 is the one proposal `NOT_FOUND`) and send `POST /knowledge/wiki/proposals/<id>/approve` with `{proposalHash, sources}` and the key, outside the Wiki's 403 collapse: its own `approveFailure` maps 409 `STALE_PROPOSAL` to `STALE_REVISION`, any other 409 to `CONFLICT`, 403 `SELF_APPROVAL_DENIED` to `CONFLICT`, any other 403 to `FORBIDDEN`, 422 `NEEDS_PLACEMENT` to `INVALID_REQUEST` (a refusal for this request alone) and 404 to `NOT_FOUND`, and an answer that is not this proposal approved at this hash is `UNAVAILABLE`. The only module that talks InferOps HTTP. A run's result keeps `patch`, `tests` (the runner's test commands, counts and artifact paths) and `reasonCode` only when well formed, leaving out a malformed or unknown one whole (`parsePatch`, `parseTests`). |
| `custom-gatekeepers/gatekeeper-inferops/src/resources.ts` | Resource grammar `inferops://<tenant>.<workspace>/project/<kind>/<KEY>` with `<kind>` `board`, `dispatch` or `workflow` (`parseProjectWorkflowUrl`, `projectWorkflowUrl`; the InferOS-minted workflow kind's `SupportedResource` with `excludeFromOperateChat`), `inferops://<tenant>.<workspace>/knowledge/wiki`, `…/object/table/<tableId>` and `…/portal/members` (`parseMembersUrl`, `membersUrl`; its `SupportedResource` with `excludeFromOperateChat`) (two lowercase slug labels; `demo.local` is the demo data), the three `SupportedResource`s (the Wiki's with `excludeFromOperateChat`), `resourceKind`, `projectResourceKind`, `parseHost`, `isSlug`; the page reference `…/knowledge/document/<slug>` (`parseWikiDocumentUrl`, `wikiDocumentUrl`, slugs of URL-unreserved characters). |
| `custom-gatekeepers/gatekeeper-inferops/src/actions.ts` | The stored action records, a tagged union (`kind`: `transition`, `create`, `update` on a board binding; `dispatch`, `cancel` on a dispatch binding; `section-update`, `document-update` and `proposal-approve` on a Wiki binding) each carrying the exact request it sends (an approval's: the proposal id, hash and its sources sorted by section id); `readAction` reads a record without `kind` (written before creates and updates) as a transition; `fingerprintOf`/`matchesFingerprint` hash the normalized request with the binding's scope, its project key or `knowledge/wiki` (SHA-256 over canonical JSON). |
| `custom-gatekeepers/gatekeeper-inferops/src/simulation.ts` | Board ordering and read-time overlay of pending actions: an issue's live pending transition or update (`pending` `transition` or `update`), and pending creates as provisional cards (`pending: "create"`). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/wiki-ui.tsx` | The Wiki picker: organization and workspace only, building `…/knowledge/wiki`; the account lists only the person's InferMind workspaces for it (and only InferOps ones for the project pickers). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx` | The same picker for a dispatch binding, building `…/project/dispatch/<KEY>`; offered only while coding dispatch is on. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/project-ui.tsx` | Organization, workspace and project picker built by the shared `build:configurator` task. It builds `inferops://<organization>.<workspace>/project/board/<KEY>` from an organization label, a workspace slug from the account's list and a project; with both left empty it asks the gatekeeper for a default host, which only a demo account has (`demo.local`). It duplicates the URL grammar for prefilling, kept in step by `__tests__/resources.test.ts`. |
| `scripts/run-dev-server.ts` | Passes `INFEROPS_BASE_URL`, `INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID` and `INFEROPS_WORKSPACE_SLUG` from the shell or root `.dev.vars` into the gatekeeper's generated dev config, resolves `INFERLAB_AUTH_ORIGIN` and `AUTH_GATEKEEPERS` for a wrapper's sign-in flag, and refuses to start when InferOps sign-in is asked for without the gatekeeper or an InferLab origin. |
| `packages/bundled-blueprints/blueprints/inferops-kanban` | Kanban gadget expecting a `board` binding of type `InferOpsProjectSession`. |
| `packages/bundled-blueprints/blueprints/inferops-records` | Records gadget (`inferops.records`) expecting a `table` binding of type `InferOpsTableSession`: a read-only table of up to 50 rows. See [custom tables](#custom-tables). |
| `packages/bundled-blueprints/blueprints/inferops-members` | Members gadget (`inferops.members`) expecting a `members` binding of type `InferOpsMembersSession`: a read-only list of one workspace's members. See [workspace members](#workspace-members). |
| `packages/bundled-blueprints/blueprints/inferops-workflow-policy` | Workflow policy gadget (`inferops.workflow-policy`) expecting a `policy` binding of type `InferOpsWorkflowPolicySession`: one project's published content-workflow policy, read-only, drawn as written (head, lanes, rules, fragments, lane bindings, transitions) with no effective-permission evaluation. See [workflow policy](#workflow-policy). |
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
  a mismatch without sending anything, marks the record dispatched (`attempts.dispatchedAt`), then
  calls the data source with idempotency key `<facet instance id>:<action id>`; the data source
  rechecks scope, state, workflow and revision, and a replayed key returns the original result
  without writing again, so a create whose response was lost is retried into the same issue. An
  applied create records the new identifier, an applied update the revision it produced, stored
  after the success and outside the failure handling. `rejectAction` deletes the record, which ends
  the simulation.
- **Apply outcomes** (MVP-12, `binding.applyOnce`, `apply-attempts.ts`). A failure is returned to
  the overseer as `{ failed: ActionApplyFailure }` with what it proves, never thrown:
  - *Known not applied* only when its stage proves it and no earlier attempt may have reached
    InferOps: a failure before sending (a check, the scope read, the switch, a fingerprint
    mismatch, a credential that fails locally before the request is handed one), or, for board
    writes only, InferOps answering the write itself with a 401, or with a 400, 403, 404 or 409
    carrying its error envelope (a malformed or foreign body proves nothing). A refusal that will stand (stale, invalid state, gone, conflict,
    invalid, fingerprint mismatch, a workflow-policy `FORBIDDEN`) ends the record `failed` with its
    reason in `attempts.failure`; it is no longer simulated, the issue is free for another proposal,
    and every later apply replays the refusal without sending. One that can pass (`UNAUTHORIZED`,
    `DISABLED`, `UNAVAILABLE` before sending, a missing permission's `FORBIDDEN`) is reported
    `retryable` and leaves the record pending, simulated and unmarked.
  - *Unknown* otherwise: a 5xx or other status, a lost response, an unusable success, a changed
    credential, and any failure after an attempt that may have reached InferOps or of a record
    from before attempts were kept. A later refusal never clears that: it reports the earlier
    attempt may have applied. The record stays pending, marked dispatched, with the outcome stored.
    A board write may be approved again: it is resent under the same key, which InferOps applies
    at most once (`retryable` unless InferOps answered a refusal that will stand).
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
  allowlist and the fingerprint before sending, and a refusal there names the switch, the
  allowlist or the mismatch and is known not applied. A 409 `RUN_ACTIVE` maps to `RUN_ACTIVE` (it
  was `CONFLICT`, which only a dispatch can receive). Both kinds are reconcile-only: InferOps
  refusing the write (a missing `issue:delegate`, an active run, a stale revision) is not yet taken
  as proof, and no same-key replay is verified for them, so any failure after the record was marked
  dispatched is unknown, and every later apply returns that stored unknown without sending (a record
  from before attempts were kept is never sent). The full flow is in
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
  `readDocument(slugOrId)` resolves a slug (one or more `/`-separated segments, compared only with
  the listed slugs) through the page list, reads the page with its body, version and Master role
  and its sections, overlays a pending body edit on a page still at the version it was proposed at
  (`pendingBody: true`) and a pending edit on a section still at its version, and adds the
  wikilinks and the references of what the page reads as (its body, else its sections) (wiki.ts).
  `readDocumentText` returns InferOps' own page text for the account, `GET
  /knowledge/documents/:id/text` (`document.text`, inferops#2367, the same string as InferOps'
  `read_document` and the InferMind reader): the body or lens-visible sections, a Master's
  structure block and its documentation coverage block (computed with the account's own
  `project:read`, or a line saying it is unavailable or could not be loaded), and embedded widgets
  as their live text. `text: null` is `NOT_FOUND`; a 404 (an InferOps without the read) or a
  malformed answer is an error, never an empty page. While this binding has a pending edit live on
  the page (a body edit or a section edit), the text is instead composed here from the shown body
  and sections and, for a Master, the structure read (wiki.ts), so the caller reads back what it
  proposed; that text has no coverage block and leaves embeds as links. Nothing to read is
  `NOT_FOUND`. `readStructure` returns the root, pillars and unfiled pages as InferOps lists them,
  which is only pages its document list shows. Each read is an observation; `listDocuments` returns
  the tree fields only. Access boundary, as InferOps draws it: the body is document-level
  (workspace scope and `knowledge:read`), sections are lens-gated, and a page with a body reads as
  its body without its sections merged in, so no section text reaches a reader through a body.
  `updateDocumentBody(slugOrId, body, expectedVersion)` checks the version (positive integer), the
  body length (at most 200000, InferOps' bound), the page's current version (`STALE_REVISION`), a
  body equal to the shown one (no-op) and a live pending body edit (`CONFLICT`), stages a
  `document-update` with the previous body, and submits it with action kind
  `inferops.wiki-page-update`, showing page, expected version and the current and new text.
  `applyAction` sends it under `<instance>:<action>` expecting the proposed version, without
  reading first: InferOps' compare-and-swap refuses any change since (`STALE_REVISION`), including
  another writer's write of the same body, which is never counted as in effect. Page and section
  edits are reconcile-only like coding actions: InferOps' refusal of the write is reported unknown,
  and once an attempt may have reached InferOps no later apply sends it again, even where InferOps
  would replay it. `revertAction` is a fresh
  compare-and-swap write of the previous body expecting the version the edit produced, under
  `<instance>:<action>:revert` (a distinct key, since InferOps binds a key to its payload); a page
  changed since in any way (body, title or tree) is reported and keeps its content. `updateSection` checks the version (decimal integer, `INVALID_REQUEST` otherwise),
  the body length (at most 100000), the section's current version (`STALE_REVISION`), a body equal
  to the shown one (no-op) and a live pending edit (`CONFLICT`), reads the page title, stages a
  `section-update` with the previous body, and submits it with action kind
  `inferops.wiki-section-update`, showing page, section, expected version and the current and new
  text. `applyAction` requires the fingerprint (a record without one is refused), reads the
  section (a failed read or a stale version is known not applied, nothing sent), PATCHes under
  `<instance>:<action>` only while it is at the expected version, counts a section already showing
  the approved body as applied without writing on a first attempt, and records the version InferOps
  reported. `revertAction` restores the previous body
  under `<instance>:<action>:revert` only while the section is at that version with that body.
  Observers: strategy B through the verifier's `hasWikiAccess(host, workspaceId)`, a page list with
  the collaborator's own token. An admitted observer is remembered (`observer:<id>`) only so that a
  `readDocumentText` answered by InferOps excludes them (`excludeObservers`): its coverage of an
  operations workspace and its live widget state are not covered by Wiki access. The locally
  composed text (pending edits) holds only Wiki data and excludes no one.
  Proposals: see [Wiki proposal approval](#wiki-proposal-approval).
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
`InferOpsCredentials`, `v2`: `InferOpsDispatchGatekeeper`, `v3`: `InferOpsWikiGatekeeper`, `v4`: `InferOpsTableGatekeeper`, `v5`: `InferOpsMembersGatekeeper`, and `v6`: `InferOpsWorkflowPolicyGatekeeper`); `wrangler.jsonc` is generated. The worker needs no secrets. `BASE_URL` is
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
| `INFEROPS_TABLES_ENABLED` | `"true"` turns custom-table bindings on; anything else, or unset, is off, and it is off while `INFEROPS_ENABLED` is. `pnpm dev-server` always sets it ([custom tables](#custom-tables)). |
| `INFEROPS_MEMBERS_ENABLED` | `"true"` turns workspace-members bindings on; anything else, or unset, is off, and it is off while `INFEROPS_ENABLED` is. `pnpm dev-server` always sets it ([workspace members](#workspace-members)). |
| `INFEROPS_WORKFLOW_POLICY_ENABLED` | `"true"` turns workflow-policy bindings on; anything else, or unset, is off, and it is off while `INFEROPS_ENABLED` is. `pnpm dev-server` always sets it (off unless asked for); no deployed value is set ([workflow policy](#workflow-policy)). |
| `INFEROPS_HOST_BOARDS` | `"true"` turns the kernel-only host-board read on; anything else, or unset, is off, and it is off while `INFEROPS_ENABLED` is. Nothing sets it yet: `pnpm dev-server`, wrappers and the release leave it unset ([host boards](#host-boards)). |
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
- `applyAction` of a queued move returns a failure known not applied and `retryable`, saying InferOps is turned off; nothing is sent and its record stays pending and unmarked. `rejectAction` still works, since it only discards.
- Nothing is deleted: bindings, queued moves, credentials and accounts are kept. Turning it back on restores exactly those; it creates no binding, grant or account. Sign-in (`connectAccount`), account description and `createAccount` are unaffected: an account is an id with no data until a binding is made, and bindings are refused.

`DISABLED` is an `InferOpsErrorCode` (`inferops-client.ts`) the gatekeeper raises itself; no InferOps response maps to it. The agent-facing types (`src/types.d.ts`, the design's API verbatim) do not list it; the error message names it. The canvas board card shows it as its own state ([canvas](inferops-canvas.md#board-data-adapter)). `__tests__/enablement.test.ts` covers a refused binding, every session call on an existing binding refused and served again once on, a queued move never applied while off and applied once on, revocation while off and observer admission refused.

Who sets the var: `run-dev-server.ts` resolves it with `resolveInferOpsEnabled` (`scripts/dev-server-config.ts`). A version 2 wrapper sets it from its capability, whatever the shell says, and turning the capability on while `inferos.canvas.json` leaves the gatekeeper out is a startup error. A version 1 wrapper, or this checkout without a wrapper, keeps today's behaviour (on), unless the shell sets `INFEROPS_ENABLED=false` to try the off state; any other shell value fails startup. `inferos.canvas.json` still decides whether the gatekeeper is installed at all; installed and off, it keeps running so its sign-in works and existing board cards say InferOps is off instead of losing their connection. The release manifest does not set the var, so a cloud install is on (see Divergences).

### Wiki proposal approval

MVP-40, against InferOps' proposal routes (inferops#2368, at or after `5483e7cd`, mounted only
while InferOps' `knowledge.wikiPublish.enabled` is on; no InferOS switch beyond
`INFEROPS_ENABLED`). InferOps decides everything an approval means: `proposal.approve` needs
`knowledge:publish` (Owner or Admin), refuses the requester and reviser (`SELF_APPROVAL_DENIED`),
binds the exact `proposalHash` and cited sources, and queues `knowledge.wiki.publish` in the same
transaction, run as the approver.

- **Reads.** `listProposals(state?)` and `readProposal(id)` are observations naming the count, or the
  proposal, its state and freshness. A proposal with an approval waiting in this binding carries
  `pending: "approve"`; the state shown is InferOps' own. A 404 (unknown, or the routes unmounted)
  is one `NOT_FOUND` that names both.
- **The approver is the credential holder.** The apply always sends with the binding's own
  account, and InferOps records the sender as `decided_by` and compares it for self-approval. So
  `approveProposal` and its apply are refused (`FORBIDDEN`) while the Wiki facet has any admitted
  collaborator (`observer:` keys) and on the stopgap connection (no InferLab sign-in on a host
  other than the demo's): at staging, before anything is read, and again at apply inside
  `applyOnce`'s check, before anything is marked dispatched, since a collaborator can be admitted
  after staging. That refusal is `CheckRefused`: unsent, a non-policy `FORBIDDEN`, so the record
  stays pending and passes once the gadget is unshared (after an attempt that may have been sent,
  it is unknown and retryable, and sends nothing). Reads and edits of a shared Wiki are unchanged.
  Collaborators approving with their own credentials would need a kernel change (the approver's
  identity passed to `applyAction`), outside this slice.
- **Staging** reads the proposal and refuses a superseded revision (`STALE_REVISION`), any other
  state than `in_review` (`CONFLICT`), another hash or a stale proposal for this reader
  (`STALE_REVISION`), and a new page without a parent (`INVALID_REQUEST`). The card (`buildDescription`)
  says approving queues publication and publishes nothing, and that InferOps publishes only if the
  approver's access, the cited sections, grounding and the target still allow it, then shows the
  page (or "New page … under …"), revision, hash, summary and source count before the content
  verbatim. A card that would drop anything (`descriptionIsComplete` unset, the 96 KiB budget) is
  refused at staging (`INVALID_REQUEST`), so nothing is approved unseen. The stage guard joins the
  same pending approval and refuses another for the same proposal (`CONFLICT`). Action kind
  `inferops.wiki-proposal-approve`, `implementsRevert: false`, never auto-approvable, and the Wiki
  facet has no `getApprovalProposal`/`editApprovalProposal`, so an approval is of the exact bytes
  staged.
- **Apply** is `PROPOSAL_APPROVE` (`refusalsProven`, `replayable`): InferOps' refusal rolls the
  transaction back, and a same-principal, same-hash resend answers the decided proposal without
  approving or queueing it again, so a lost response is resent under `<instance>:<action>`.
  Refusals keep InferOps' meaning (`PROPOSAL_APPROVE_REFUSED`): stale and self-approval and a
  decided proposal end `failed`, a missing permission stays pending. Applied means approved and
  queued, recorded with InferOps' state (`approvedState`); nothing claims published.
  `readProposal` shows the outcome InferOps reaches (published, stale, blocked, or superseded by a
  later revision). `revertAction` answers that an approval cannot be undone here; rejecting
  forgets the pending record without calling InferOps.

### Custom tables

A fourth resource kind, `inferops://<tenant>.<workspace>/object/table/<tableId>` (lowercase UUID), binds one InferOps custom table (MVP-20, factory-level/inferops#2346) into an `InferOpsTableGatekeeper` facet whose props fix the account, host, table id and workspace id. It is **read-only** and **private-only**.

- **Switch.** `INFEROPS_TABLES_ENABLED` (`table.ts`), off unless `"true"` and only while `INFEROPS_ENABLED` is on. While off, `getSupportedResources` omits the kind, `startResourceConfigurator` refuses its picker, `getGatekeeperClassFor` refuses with `DISABLED`, and `tableClientFor` refuses every call of an existing binding or session with `DISABLED: InferOps custom tables are turned off for this deployment.` Nothing is deleted.
- **Authority.** The demo host reads the mock's table. Any other host needs a connected person (`INFEROPS_AUTH`): the client is the person's own (`accountClient` over the `InferOpsCredentials` coordinator, refreshing and adjudicating rejections as for boards). Table reads are also **fenced on success** (`assertConnectionUnchanged`): after InferOps answers, the account must still hold the identity and generation the request was sent under, or the answer is discarded before projection, observation or return. A reconnect committed or a revoke completed while the request was in flight is therefore `UNAVAILABLE` (*This InferOps connection changed*), or `UNAUTHORIZED` once the session is confirmed dead. Board, dispatch and Wiki reads keep the coordinator's behaviour. The stopgap connection never serves a table, and an account without a sign-in is refused as a missing table.
- **Binding.** The URL's workspace slug must be one of the person's InferOps workspaces (`resolveWorkspace`, which matches the slug only), and the table must answer one read for the URL's whole host. That read is InferOps' scoped `object.embed`, which resolves the reference's exact `<tenant>.<workspace>` against the reader, so a tenant label that is not the person's is refused there. Every refusal (workspace not held, missing table, wrong tenant, no sign-in) is one message: `No such InferOps custom table is available to you on <host>.` The probe returns nothing to any caller and is not an observation.
- **Reads.** `InferOpsTableSession` (`types.d.ts`): `describeTable()`, `listRecords({ relatedTo?, limit? })` (at most 50, newest first) and `getRecord(id)`. Each is exactly one `GET /object/embed?ref=…` (two when InferOps answers 409 because the definition changed during its read; a second 409 is `UNAVAILABLE`), with the reference built from the props: `inferops://<host>/object/table-view/<tableId>?limit=…[&relatedTo=…]`, or `…/object/record-card/<id>`. A row whose table is not the bound one is `NOT_FOUND`, the same as a missing one. Each read is authorized as an observation before it returns; the observation names the table's label and counts, never the `relatedTo` reference.
- **Projection.** Every answer is parsed strictly (`parseTableRead` in `http-inferops.ts`: the definition's columns with their `personal` flag, each row of that table and that version, values only strings, finite numbers, booleans or null, link kinds `project/issue`, `project/project` or `object/record`, and no more rows than the requested `limit`). An ambiguous definition is refused before anything is projected from it: a column name or key that appears twice, or a relation sharing a name with a column or another relation, could otherwise pass a value under a non-personal twin of a personal column. The answer is then projected against the definition returned **with** the rows (`projectRows`): a personal column leaves no name, label, list of values, value or count. Links keep `{relation, toKind, ref}`; their labels and hrefs are dropped, because a column's personal flag says nothing about the thing a relation points at. This is not a general guarantee that no personal data is returned: a column the table's owner did not mark personal is returned as written.
- **No filter on column values.** InferOps' embed reads the definition and the rows separately and checks their versions only when rows come back, so a filter on a column that turned personal between the two reads could be probed through what it matches, including an empty result. A `where` option needs InferOps to return the definition from the same snapshot the filter ran against, empty results included.
- **Errors.** InferOps' 403 and 404 both read as one `NOT_FOUND`; a 400 is `INVALID_REQUEST` without InferOps' text; a malformed answer is `UNAVAILABLE`, logged by operation name and field only.
- **Observers.** Strategy A: `addObserver` always throws (`…private to the person who connected it, so this gadget cannot be shared.`) and `removeObserver` does nothing; the account's verifier is not consulted. Sharing a workspace whose gadget holds a table binding is therefore refused at the collaborator's open. Observations do not set `containsRestrictedData`.
- **Writes.** None: `applyAction`, `rejectAction` and `revertAction` throw, and no session method proposes an action.
- **Display.** The bundled `inferops.records` gadget shows a table through the existing `inferos.gadget` canvas kind and the workspace's own gadget view; there is no new kernel widget kind. Its Durable Object has one call, `loadRows()` → `table.listRecords({ limit: 50 })`, and stores nothing; the client draws the rows with the definition returned with them, every label and value as a text node, and relation cells as link counts. Each load clears what was shown and only the latest load's answer is drawn (a generation per load), so of two loads in flight the earlier one's late answer is never drawn. Those tests prove that ordering only; that an account change discards an answer is the gatekeeper's success fence, proved in the account suite; a refusal (`unavailable`: missing, refused or signed out), the switch (`disabled`), an error, no binding and an empty table each have their own notice and show no rows. Because the binding is private, the gadget is the connecting person's own: owner-workspace display, not shared or console access. A published bound widget ([#183](https://github.com/factory-level/inferos/pull/183)'s registry refuses bindings) is outside this slice.

### Workspace members

A fifth resource kind, `inferops://<tenant>.<workspace>/portal/members`, binds one InferOps workspace's member list (MVP-18, InferOps' `member.list`, factory-level/inferops#2379) into an `InferOpsMembersGatekeeper` facet whose props fix the account, host and workspace id. It is **read-only** and **private-only**, and its `SupportedResource` sets `excludeFromOperateChat`. InferMind is not served.

- **Switch.** `INFEROPS_MEMBERS_ENABLED` (`members.ts`), off unless `"true"` and only while `INFEROPS_ENABLED` is on. While off, `getSupportedResources` omits the kind, `startResourceConfigurator` refuses its picker, `getGatekeeperClassFor` refuses with `DISABLED`, and `membersClientFor` refuses every call of an existing binding or session with `DISABLED: InferOps workspace members are turned off for this deployment.` Nothing is deleted.
- **Authority.** The demo host reads the mock's list (`src/fixtures/demo-members.json`: a demo owner, a viewer and one service account with a deny). Any other host needs a connected person: the client is the person's own (`accountClient`), and every answer is **fenced on success** as for tables. The stopgap connection never serves a member list, and an account without a sign-in is refused as a missing list.
- **Binding.** The URL's workspace slug must be one of the person's InferOps workspaces (`resolveWorkspace`), and `member.list` must answer one read for that person there. Every refusal (a workspace not held, an InferMind workspace, no sign-in, InferOps' 403 or 404) is one message: `No InferOps member list is available to you on <host>.` The probe returns nothing and is not an observation.
- **The tenant label is inert.** `member.list` is a plain `GET /workspace/members` with the bound workspace as `X-Workspace-Id`; it takes no reference, so InferOps never sees the URL's tenant label. As for boards, the label is checked for syntax only and the slug resolves against the person's own workspaces, so `inferops://globex.operations/portal/members` binds the person's own `operations` workspace. Nothing beyond that workspace is disclosed (proved live, see Evidence). This differs from tables, whose `object.embed` read refuses a tenant label that is not the person's.
- **Reads.** `InferOpsMembersSession.listMembers()` (`types.d.ts`) is exactly one `GET /workspace/members`. The answer is parsed strictly (`parseWorkspaceMembers` in `http-inferops.ts`: exactly `{workspace: {workspaceId, workspaceName, product}, members}` and each member exactly `{principalId, type, name, email, role, deniedPermissions}`); a field more or less, or a workspace other than the bound one, is `UNAVAILABLE`. `projectMembers` then returns workspace `{workspaceId, workspaceName, product}` and members `{principalId, type, name, role, deniedPermissions}` in InferOps' order. The email is never returned. Names and ids are personal data: this is not a claim that the list is free of personal data. Each read is an observation, *List InferOps workspace members*, describing the workspace name, host and member count, never a member.
- **Errors.** InferOps' 403 and 404 both read as one `NOT_FOUND` (*No such member list is available to you.*), so a binding cannot tell a missing grant, a missing `member:read`, an explicit deny and a missing workspace apart. A 401 is adjudicated by the account as for every read. Logs carry the operation name and status only.
- **Observers.** Strategy A, as for tables: `addObserver` always throws (`…private to the person who connected it, so this gadget cannot be shared.`) and the verifier is not consulted.
- **Writes.** None: `applyAction`, `rejectAction` and `revertAction` throw.
- **Configurator.** The Workshop's connect flow always opens a picker, so the kind has one (`members-ui.tsx`, organization and workspace). It changes no authority: the binding check above still decides.
- **Display (PR B).** The bundled `inferops.members` gadget shows the list through the existing `inferos.gadget` canvas kind and the workspace's own gadget view, as `inferops.records` does for tables; there is no new kernel widget kind, interface or permission. Its Durable Object has one call, `loadMembers()` → `members.listMembers()`, and stores nothing. The client draws the workspace's name, product and id, then one row per member in InferOps' order (name, person or agent, role, denied permissions or *None*, principal id), every value as a text node. Its only control is Reload: no invite, removal, role or deny change, transfer or workflow write. Its `ExportHandler` lists no formats, which also turns off the Workshop's default HTML and PDF exports; a print layout is kept, as for every bundled output format. Each load clears what was shown and only the latest load's answer is drawn (a generation per load), so a late answer for a replaced binding is never drawn; that an account change discards an answer is the gatekeeper's success fence. A refusal (`unavailable`: missing, refused or signed out), the switch (`disabled`), an error, no binding and an empty list each have their own notice and show no members. The binding is private, so the gadget is the connecting person's own.
- **Freshness.** The person's workspace list is the one stored at connect, so a workspace granted afterwards needs a reconnect. A revoked grant or an added deny takes effect on InferOps' next answer: its grant cache holds for up to 30 seconds and the access token for 900. Revocation is therefore not immediate.

### Workflow policy

A sixth resource kind, `inferops://<tenant>.<workspace>/project/workflow/<KEY>`, binds one project's published content-workflow policy (MVP-18, InferOps' `workflow.get`) into an `InferOpsWorkflowPolicyGatekeeper` facet whose props fix the account, host, project key and workspace id. It is **read-only** and **private-only**, and its `SupportedResource` sets `excludeFromOperateChat`. The source contract is slice 07's `GATEKEEPER-CONTRACT.md` revision 2 (D1-A and reduced P2, adopted as delegated engineering choices).

- **An InferOS-minted URL.** InferOps defines no `project/workflow` widget (its `project/workflow-chart/<KEY>` is an issue-count chart, another thing), so, like `object/table` and `portal/members`, the URL is InferOS' own and never reaches InferOps. It reuses the project-URL parser and key rule. `getGatekeeperClassFor` routes the kind explicitly before the board fallthrough, which checks the switch first, so a workflow URL never yields a board binding, with the switch on or off.
- **Switch.** `INFEROPS_WORKFLOW_POLICY_ENABLED` (`workflow-policy.ts`), off unless `"true"` and only while `INFEROPS_ENABLED` is on, checked on every call. While off, `getSupportedResources` omits the kind, `startResourceConfigurator` refuses its picker, `getGatekeeperClassFor` refuses with `DISABLED`, and `workflowPolicyClientFor` refuses every call of an existing binding or session with `DISABLED: InferOps workflow policies are turned off for this deployment.` Nothing is deleted, and turning it back on resumes.
- **Authority.** The demo host reads the mock's answers (`src/fixtures/demo-workflow.json`: DEMO's policy, with a canary in every field the projection drops; any other project is unconfigured). Any other host needs a connected person, through their own client (`accountClient`), with every answer **fenced on success**. The stopgap connection never serves a policy, and an account without a sign-in is refused as a missing policy.
- **Binding.** The URL's workspace slug must be one of the person's InferOps workspaces (`resolveWorkspace`), and one read must answer for that person there. Every refusal (a workspace not held, an InferMind workspace, no sign-in, a key not in the bound workspace's list, a workspace with no projects, InferOps' 403 or 404 on either read) is one message: `No InferOps workflow policy is available to you on <host>.` The probe returns nothing and is not an observation. The tenant label is inert, as for members: the reads take no reference.
- **Reads.** `InferOpsWorkflowPolicySession.readWorkflowPolicy()` (`types.d.ts`) is exactly two GETs, both with the person's token in the bound workspace: `project.list` (`GET /project/projects`) to resolve the key there, then `workflow.get` (`GET /project/projects/:projectId/workflow?workflow=content`) for that project. The key is resolved first because `workflow.get` answers a project id of another workspace as unconfigured rather than refusing it. Nothing is cached: each read is fresh, and `revision` says which publication was read.
- **Strict parse.** `readWorkflowPolicyAnswer` copies the provider's schema at inferops `b0189cc2` (`workflow-policy-v2.ts`, `workflow-policy.dto.ts`, Zod 4.4.3's `uuid` and `iso.datetime` patterns): every object must have exactly its source keys (the `{head}` envelope and the head included, though the provider's own head schema is not `.strict()`), every enum, pattern, string length (after trimming where the source trims) and array cap is the source's, and the guard refinement is the source's. It checks shape only: lane references, duplicate ids and fragment cycles stay the provider compiler's. The fields the projection drops (`reason`, `agents[]`, `publishedBy`) are validated first, so a malformed one fails like any other field. A head must be about the project asked for, have workflow `content` (head and policy), and be consistent: unconfigured means no policy, revision `'0'`, no `compiledHash` and no `publishedBy` or `publishedAt`; configured means a policy and a `compiledHash`. A field InferOps adds later is therefore refused until this file follows: an intended coupling.
- **Projection.** `projectWorkflowHead` returns the head exactly as sent, keys and arrays in InferOps' order, without `publishedBy`, without `agents`, and without the `reason` of every rule (top-level, fragment, lane-binding and transition rules). Nothing is added, renamed or marked as removed. Principal ids in rule and transition subjects stay: they are personal data, and this is a narrower view, not an anonymous one. `compiledHash` is InferOps' hash of its compiled source policy, passed on as metadata; nothing hashes the projection or claims the two match.
- **Observation.** Each read is an observation, *Read InferOps workflow policy*, naming the project key, host, revision and whether the policy is configured; never a subject, principal id, rule id, reason or lane name.
- **Errors.** InferOps' 403 and 404 on either read, and a key not in the list, all read as one `NOT_FOUND` (*No such workflow policy is available to you.*). A 401 is adjudicated by the account. A malformed, ambiguous, foreign, non-JSON or truncated answer is `UNAVAILABLE` with a fixed message that repeats no value. Logs carry the operation name and status only, and a shape mismatch only its event and operation.
- **Observers.** Strategy A: `addObserver` always throws (`…private to the person who connected it, so this gadget cannot be shared.`).
- **Writes.** None: `applyAction`, `rejectAction` and `revertAction` throw, `getAutoApprovableActions` is `[]`, and there is no `workflow.set`, `validate`, `explain` or any non-GET.
- **Configurator.** `workflow-ui.tsx`, the project-board picker with the workflow path. It changes no authority: the binding check above still decides.
- **Display.** The bundled `inferops.workflow-policy` gadget shows the binding through the existing `inferos.gadget` canvas kind, as `inferops.members` does for members; there is no new kernel widget kind, interface or permission. Its Durable Object has one call, `loadPolicy()` → `policy.readWorkflowPolicy()`, and stores nothing; its `ExportHandler` lists no formats.
  - **What the client draws:** the head (project id, workflow, revision, published or not, `publishedAt`, and `compiledHash` labelled as InferOps' source metadata, not a hash of the view), then the lanes in order (entry marked), the top-level rules, fragments, lane bindings with their guards, and transitions, each subject and action as written. Every value is a text node, and only named fields are drawn, so a field outside the projection is never shown even if one arrived.
  - **What it does not do:** combine rules, resolve fragments, apply guards or work out who may do what.
  - **States:** loading, unconfigured, not connected, turned off, unavailable and error, each with its own notice and no policy. Each load clears what was shown, and only the latest load's answer is drawn.
  - **Controls:** Reload and Try again only; no edit, publish, validate or export.
  - **Privacy:** the binding is private, so the gadget is the connecting person's own.
- **Not here.** No console change, no provider change.
- **Freshness.** As for members: the person's workspace list is the one stored at connect, and a revoked grant or an added deny takes effect on InferOps' next answer (grant cache up to 30 seconds, access token 900). Revocation is not immediate.

### Host boards

A kernel-only read of the one board a `project/board` binding is fixed to, through InferOps' `project.board_snapshot` (`GET /project/board-snapshot?ref=<canonical reference>`, factory-level/inferops#2366). It is the gatekeeper half; the kernel half, which selects each operator's own connection, calls both methods through `getGatekeeperFacet` under one 10-second deadline and owns the audit, is in [operate mode](operate-mode.md#host-boards). The facet records no observation.

- **Reach.** `InferOpsProjectGatekeeper.readHostBoardSnapshot()` and `connectionIdentity()` are methods of the board's Durable Object facet, typed by `HostBoardReader` and `HostBoardConnectionFence` in `@gadgets/gatekeeper-kit/host-board`. Only the overseer holds facet stubs (`getGatekeeperFacet`, `gatekeeper${id}`); agents, gadgets and widgets hold the `InferOpsProjectSession` that `startSession` returns, which is a separate `RpcTarget` without these methods, and the agent types (`types.d.ts`) do not name them. `GatekeeperClientImpl` keeps the facet private and exposes only `openSession` and its own methods. The dispatch, Wiki and table facets have neither method.
- **Target.** Neither method takes an argument. The reference is `inferops://<host>/project/board/<projectKey>` from the binding's props, and a key outside InferOps' identifier bound (`^[A-Z][A-Z0-9]{0,9}$`, narrower than the board grammar's sixteen) or a host that is not two slug labels is `unavailable` / `invalid-target` before any request.
- **Authority.** A connected person only, against `inferOpsApiEndpoint`, in the workspace the binding resolved: their own token through the account's `CredentialSource` (the board client's), sent on InferOps' principal lane with no `X-Workspace-Id`, since the reference names its workspace. The demo host, an account without an identity and a binding without a resolved workspace are `not-connected` without a request. A connected binding on a deployment whose endpoint is unusable (a malformed `INFEROPS_BASE_URL`, or no base URL and an InferLab origin that is missing or invalid) is `unavailable` / `provider`, and its fence null, also without a request: the endpoint is resolved inside each method's normalization boundary, and each method catches anything below it, so neither ever throws. There is no fallback to `project.board`, the project list, the mock, the stopgap connection or another account.
- **Caps.** The body is streamed through the kit's `readTextCapped` and abandoned at 256 KiB for a 200 and 4 KiB for any other status, before it is buffered whole or parsed; a 401's body is cancelled unread.
- **Parsing.** `parseBoardSnapshotResponse` is strict like InferOps' schema: exactly `{scope: {workspaceId, projectId}, snapshot: {project: {identifier, name}, columns}}`, each column exactly `{label, group, issues}` and each issue exactly `{identifier, title, priority, targetDate, blocked}`, with every bound rechecked (at most 20 columns, 200 issues a column, 500 in all, identifier 32, name 200, label 100, issue identifier 32, title 500 UTF-16 code units, group and priority InferOps' enums, a `yyyy-mm-dd` date or null). A field more or less, or a bound exceeded, is `unavailable` / `provider`, never a partial board. A snapshot whose `scope.workspaceId` is not the binding's, or whose project identifier is not its key, is refused the same way.
- **Statuses.** A 404 with InferOps' `NOT_FOUND` envelope is `not-found`, a 422 `SNAPSHOT_TOO_LARGE` is `too-large`, a 403 with an envelope `forbidden`, a 400 with one `invalid-target`; any other status, a body without the matching envelope, a redirect, a network failure or a malformed answer is `provider`. A 401 is adjudicated by the account, as for every read: a healed token retries once, a dead session is `not-connected`. Results carry only the status and reason. The lane's own logs carry the operation name, the status and a fixed local classification: an allowlisted InferOps code (`NOT_FOUND`, `SNAPSHOT_TOO_LARGE`, `FORBIDDEN`, `VALIDATION`, `UNAUTHORIZED`), else `other`, or `no_envelope`, `not_json`, `malformed`, `unreadable_body`, `unreachable`. A provider-chosen code, message, details, field name or value, the reference, the token and error objects never reach a log. The credential source's own log when the account cannot adjudicate a 401 (`credentials.rejection.report.failed`) is redacted for this lane: its `CredentialSource` is built with the kit's `redactAccountErrors`, so it carries only the classification `account_rpc_failed`, never the failed RPC's message or stack. Every other `CredentialSource` (boards, tables, Wiki, other connectors) still logs the error as before.
- **Fence.** The credential read of the attempt that actually answered (the retry, when a rejected token was healed) is the fence. Once the answer is in, `assertConnectionUnchanged` must still find that identity and generation, or the answer (a refusal included) is discarded as `stale`: a reconnect committed, a revoke completed or the session replaced while the request was in flight. A successful read returns the snapshot, `scope` and `fence` (`{accountId, identity, generation}`); `connectionIdentity()` reads the same fence fresh, or null when the lane is off, no connected person backs the binding or the endpoint is unusable, so the kernel can compare later. `fence.accountId` is the adapter's own string account id (the binding's `accountId` prop), not the kernel's numeric connected-account id; the kernel must map between them, never compare them.
- **Deadline.** Each provider request has the client's 15-second `AbortSignal.timeout`, but nothing puts the credential fetch, a refresh and its retry, and the completion fence under one deadline, so a read can take longer than 15 seconds in all. The endless-stream tests prove the byte caps, not a stalled body. The total deadline (10 seconds) is the kernel's (`HostBoardDesk.read`); its stalled-fetch, stalled-body and late-completion tests are in `operate-host-boards.test.ts` and `host-boards.test.ts`.
- **Switch.** `INFEROPS_HOST_BOARDS`, off unless `"true"`, and only while `INFEROPS_ENABLED` is on, which keeps its meaning exactly. While off both methods answer `unavailable` / `disabled` and null with no request; board bindings and sessions are unaffected. See [feature capabilities](feature-capabilities.md) for what does and does not resolve it yet.
- **Tests.** `__tests__/host-board-http.test.ts` covers the request, every bound at its limit and one over, UTF-16 measurement, extra and missing fields, the byte caps (including endless success and error streams cancelled before `JSON.parse`), each refusal, nothing raw in a result or log, and a private sentinel in a provider error's code, message and details and in malformed fields reaching neither a result nor a log. `account.test.ts` (`host boards, …`) covers the facet as the overseer calls it: the principal-lane request and fence, the switch, invalid keys, demo and unconnected bindings, refusals, a dead and a revoked session, a healed-token retry fenced on its own read, answers held across a reconnect and a revoke (`stale`), absence from the session and the agent types, that no other request is ever sent, and the normalization boundaries: a 401 whose adjudication RPC throws an error carrying a sentinel in its message and stack (no retry, refresh or expiry notice, and only fixed classifications logged), a malformed `INFEROPS_BASE_URL` and an invalid InferLab origin, each with a sentinel absent from results and logs.

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
- A Wiki page body edit is stale after any write to the page (a title change or move too), since
  InferOps has one page version; it is then discarded and proposed again.
- A Wiki section edit's version check and its write are two requests (InferOps' `PATCH` takes no
  expected version), so an edit made in InferMind between them is overwritten; and a section that
  someone else set to exactly the approved body counts as the edit applied.
- A 401 to a write is trusted as InferOps' auth layer turning the request away before any effect,
  whatever its body; no other status without InferOps' error envelope is. This assumes nothing in
  front of InferOps answers 401 after forwarding a write.
- Only board writes take InferOps' refusal as proof that nothing was applied. A dispatch, cancel,
  section or page edit InferOps refuses (a stale page version, a missing `issue:delegate`, the Wiki
  forbidden) is reported unknown and reconcile-only, until each one's refusal and same-key replay
  are verified.
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
- A page slug may contain `/` (`dispatch/dispatch-a-crew`). A `…/knowledge/document/<slug>` reference
  carries it as one percent-encoded segment (`dispatch%2Fdispatch-a-crew`): `wikiDocumentUrl` encodes
  it and `parseWikiDocumentUrl` decodes `%2F` once, then validates each segment. Raw extra segments,
  any other escape (so no double encoding), empty, `.` or `..` segments, a query or a fragment do not
  parse.
- One pending edit per page body and per section is enforced where the edit is staged: the check
  runs in the same synchronous step as the write, after the fingerprint, so two concurrent proposals
  cannot both stage. A concurrent proposal of the same body joins as a no-op; a different one is
  CONFLICT. The section race reproduces without that step in the workerd suite; the body path has no
  await between check and write there, so its race test passes either way and guards the outcome.
- The structure read and page body edit follow InferOps' factory-level/inferops#2345, merged as
  c536b637 (page text, strict compare-and-swap, a receipt bound to principal, expected version and
  payload). They are tested against fakes of it, not yet against a live InferOps. `connection.json`
  keeps its board-schema pin and notes c536b637 as the minimum for these knowledge endpoints.

- Wiki proposal approval has not been run against a live InferOps: the routes and their refusals
  are read from inferops#2368 (`domains/knowledge/backend/wiki-proposals.ts` at `5ab3d727`) and
  exercised against the mock and a stubbed fetch only. InferOS cannot tell whether a deployment
  runs #2368 with `knowledge.wikiPublish.enabled` on; off, every proposal call is `NOT_FOUND`.
  Live proof waits on MVP-35.
- The Wiki client has not been run against a live InferOps knowledge API. That a missing page or
  section is answered `200 null` is read from InferOps' route code (`getDocument`/`getSection`
  return null), and the client accepts an empty body the same way.

- Custom tables have no filter on column values until InferOps returns the filter's definition from the same snapshot as its rows, empty results included ([custom tables](#custom-tables)).
- The custom-table reads have been run against a live local InferOps only with the InferLab sign-in leg faked (see Evidence); a real per-person sign-in waits on the deferred Google identity.
- `INFEROPS_TABLES_ENABLED` is a ninth capability name beside [ADR 0001](../adr/0001-customer-capability-flag-vocabulary.md)'s eight; see [consumer configuration](consumer-configuration.md#open-questions).
- `INFEROPS_MEMBERS_ENABLED` is another capability name beside ADR 0001's eight, in the same proposed status as `INFEROPS_TABLES_ENABLED`; see [consumer configuration](consumer-configuration.md#open-questions).
- A workflow-policy binding has the same freshness: the workspace list is the one stored at connect, and a revoked grant or added deny is honoured on InferOps' next answer (grant cache up to 30 seconds, access token 900), not at once. Its parse duplicates the provider's strict v2 shape at `b0189cc2`, so a new provider field fails closed (`UNAVAILABLE`) until InferOS follows ([workflow policy](#workflow-policy)).
- A workspace-members binding reads the workspace list as it was when the person connected: a workspace granted later needs a reconnect, and a grant InferOps revokes is honoured on InferOps' next answer (its grant cache holds for up to 30 seconds, the access token for 900), not at once ([workspace members](#workspace-members)).

## Evidence

Wiki proposal approval (MVP-40, local synthetic, not live): `__tests__/wiki.test.ts` "Wiki proposal approval" (workerd, over the mock's InferOps rules: A1 reads as observations with state, hash, target, sources and freshness, no principals, the one `NOT_FOUND`, the pending overlay; A2 the exact card, nothing sent before approval, the sorted request under `<instance>:<action>`, applied as approved, then published by the job with the page's id, parent, order, Master role and pillars kept; A3 Viewer and Member `FORBIDDEN`, pending until granted; A4 self-approval final; A5 stale, superseded, moved, decided, malformed and unknown refused at staging; A6 revised after staging, final stale; A7 a lost response resent and replayed once, a redelivered job publishing once, concurrent staging joined, another waiting approval `CONFLICT`, and a lost response then a revision ending unknown and not retryable; A8 a tampered record refused unsent; A9 a new page's parent at staging and InferOps' 422 at apply, and publication under the parent in its pillar; A10 stale and superseded outcomes read from InferOps, never published; A11 the stopgap refused at staging and apply while its reads reach InferOps; A12 no revert, reject forgets; A13 the switch; A14 a shared gadget refused at staging while reads and edits work; A15 a collaborator admitted after staging refused unsent and pending, unknown and retryable after an earlier attempt, and sent once after removal; A16 never auto-approvable and no edit-before-approve path; A17 a card that would truncate refused), and `__tests__/http-inferops.test.ts` "Wiki proposals over HTTP" (field-by-field parsing without principals, the 404 `NOT_FOUND`, the reads' 403 collapse kept, malformed and foreign answers `UNAVAILABLE`, the exact approve request, and H1: each refusal from InferOps' exact envelope to its code, message and stage, a body without the envelope proving nothing, the other writes' mapping unchanged).

Workspace members (MVP-18 PR A): `__tests__/members.test.ts` (workerd, over the mock's demo list: grammar, the switch for offering, picking, binding and existing sessions, a host it does not serve and never the stopgap, the projection in InferOps' order with no email, an observation naming a count and the workspace and no member, every member passed through, revocation, no collaborator admitted, no actions), `__tests__/members-http.test.ts` (exactly `GET /workspace/members` with the person's token and the bound workspace, the strict answer, 403 and 404 as one `NOT_FOUND`, 401 and outages kept distinct, another workspace or an extra or missing field refused as `UNAVAILABLE`, no redirect followed, no token in an error), `__tests__/account.test.ts` "workspace members as the person" (the person's own token and workspace, every unavailable list one message, the inert tenant label, an ended session and a revoked account, answers held across a reconnect and a revoke discarded, a collaborator holding the workspace refused), and `__tests__/resources.test.ts` (the picker's copy of the grammar).

Workflow policy (MVP-18, slice 07): `__tests__/workflow-policy.test.ts` (workerd: the parse against every source key, enum, pattern, length, cap and the guard refinement at each level, the omitted fields validated before they are dropped, configured consistency, a foreign project, non-answers; the projection deep-equal to the source minus exactly `publishedBy`, `agents` and every rule reason, in source order, sharing nothing; no canary or omitted key in the projection, the observation or any error; the switch for offering, picking, binding and existing sessions, InferOps off too; routing ahead of the board path with the switch on and off; the Operate exclusion; the stopgap never served; an unconfigured project; a republished policy read fresh; a malformed answer `UNAVAILABLE` with no observation; revocation; no collaborator; no actions), `__tests__/workflow-policy-http.test.ts` (exactly two GETs with the person's token and the bound workspace and nothing else, no cache, the key resolved in the bound workspace's list, 403 and 404 on either read and an explicit deny as one `NOT_FOUND`, 401 and outages kept distinct, non-JSON, truncated, malformed, ambiguous, foreign and future-field answers `UNAVAILABLE`, logs and errors free of every canary, value and token), `__tests__/account.test.ts` "workflow policies as the person" (the person's own token and workspace, every unavailable policy one message, a later deny, the inert tenant label, a malformed answer, an ended session and a revoked account, the switch turned off mid-session, answers held across a reconnect and a revoke discarded, a collaborator refused, GETs only), and `__tests__/resources.test.ts` (the picker's copy of the grammar). The Operate exclusion is exercised end to end by `packages/integration-tests/__tests__/operate-chat-no-workflow-policy.test.ts` (in CI, modelled on `operate-chat-no-wiki.test.ts`): on the demo host with the switch on, the real Workshop and gatekeeper with a scripted model, an operate chat is not offered the kind, its `requestConnection` and `describeBinding` are refused as not available in an operate chat, a pasted binding is absent from `env`, and no policy text reaches the model, while the person's own connection outside the chat and a Build chat still read it (the positive control).

Workflow policy gadget (MVP-18, slice 07): `packages/bundled-blueprints/blueprints/inferops-workflow-policy/__tests__/` covers the pure rules (generations, refusals, how each subject, rule, guard and lane reads), the server (a missing binding as `not-connected`, one read returning the head, refusals classified, no storage, no exports) and the client in jsdom (the head and every section drawn as written and in order, text not markup, no control but Reload, an injected `reason`/`agents`/`publishedBy` canary never drawn, the unconfigured, empty and refusal states, clearing on reload and refusal, and no late answer drawn). `packages/integration-tests/__tests__/inferops-workflow-policy-gadget.test.ts` installs it in the real Workshop over the real gatekeeper on its demo data: the gadget's `loadPolicy()` equals the binding's own read with no canary, an unconfigured project reads as unconfigured, and a collaborator holding their own account cannot open it. It reuses #264's provider evidence below and runs no provider.

Workflow policy against a live InferOps (2026-10-13, author-local, not CI): `packages/integration-tests/__tests__/inferops-workflow-policy-live.test.ts` (opt-in, skipped without `INFEROPS_WORKFLOW_LIVE_BASE_URL`, and refusing to start without `INFEROPS_WORKFLOW_LIVE_DISPOSABLE=1`), the real Workshop and gatekeeper Worker against the composed shared-api (`createApp('stub')`) at factory-level/inferops `develop` `b0189cc2`, on a disposable migrated database seeded with `seed` and `seed:reserved` (throwaway key plaintexts, never printed). Its test setup, separately labelled and never a consumer path, had the seeded owner create two synthetic projects in `acme.operations` and publish a policy on one with InferOps' own `workflow.set` (a canary in every rule location's reason and an `agents[]` entry naming a seeded service account nowhere else in the policy), and had `canary-inspector` create a project in its own tenant. Each persona signed in through InferOps' stub login; only the InferLab legs were a fixture. Five cases passed. The `owner` and `viewer` each read the policy (revision 1, two top-level rules, two transitions) deep-equal, in order, to `workflow.get` minus `publishedBy`, `agents` and every reason, the viewer's read equal to the owner's, with no canary or the owner's id in any read or observation. The unconfigured project read as InferOps' unconfigured head. A republish between two reads of one session showed revision 1, then 2. `acme.knowledge` (InferMind), `synthetics.probe` (not held), a missing key and a key that exists only in the second tenant's workspace were refused at bind with the one message. InferOps refused (403) `canary-inspector`'s token pinned to `acme.operations`, and its binding of the acme URL was refused. Not run: a real InferLab sign-in, a browser, or a deployed InferOps.

Workspace members against a live InferOps (2026-10-12, author-local, not CI): `packages/integration-tests/__tests__/inferops-members-live.test.ts` (opt-in, skipped without `INFEROPS_MEMBERS_LIVE_BASE_URL`), the real Workshop and gatekeeper Worker against the composed shared-api (`createApp('stub')`) at factory-level/inferops `develop` `13e744d0` on a seeded local database. Each persona signed in through InferOps' stub login; only the InferLab legs were a fixture, handing out those real tokens and memberships. Four cases passed. The `owner` and `viewer` each read `acme.operations` (63 members), equal to `member.list` minus the email, the viewer's list equal to the owner's. `acme.knowledge` for the viewer (InferMind) and `synthetics.probe` for the owner (not held) were refused at bind with the one message. `canary-inspector` binding the same `acme.operations` URL read its own `canary` workspace (2 members) and none of acme's principals. InferOps refused (403, no member in the body) the viewer's, the owner's and the second tenant's token pinned to a workspace it holds no grant in, the answer the client reads as its one `NOT_FOUND`. The run's output held no member name, email or token. Not run: a real InferLab sign-in, a browser, or a deployed InferOps.

Workspace members gadget (MVP-18 PR B): `packages/bundled-blueprints/blueprints/inferops-members/__tests__/` covers the server (a missing binding as `not-connected`, one read returning the workspace with the members, each refusal as its kind and never a thrown error or a member, no storage touched, no export formats), the pure rules (load generations, refusal codes, kind and deny text) and the client in jsdom (workspace and members as text with markup inert, no email and no control but Reload, the empty, not-connected, turned-off, unavailable and error notices without members, a refusal clearing the list, and a late answer to an earlier load never drawn). The Workshop backend's `bundled-blueprints.test.ts` installs and inspects its archive like every bundled blueprint. The live suite above adds an installed `inferops.members` gadget for the owner and the viewer, each loading 63 members through the gadget's own Durable Object, equal to `member.list` minus the email (author-local, 2026-10-12, not CI).

Custom tables (MVP-20 slice 10): `__tests__/table.test.ts` (workerd, over the mock's demo table: grammar, the switch for offering, picking, binding and existing sessions, projection with no personal trace, `relatedTo` and `limit`, refused options with no observation, the bound-table fence for `getRecord`, a column made personal between reads, revocation, private-only admission, no actions, reads changing no data), `__tests__/table-http.test.ts` (the exact `object.embed` request, GET only, one `NOT_FOUND` for 403/404 and a bad id, `INVALID_REQUEST` for 400, one retry on 409, twelve malformed or ambiguous answers refused as `UNAVAILABLE` (among them a column name present twice, once personal), and 51 rows for a limit of 50 or two for one refused), `__tests__/account.test.ts` "custom tables as the person" (a connected person's own token and workspace, a colliding tenant label refused by InferOps, a workspace not held refused before any request, an ended session and a revoked account, a staged then committed reconnect, a collaborator who holds the workspace refused, and the success fence through the real account and credential objects: an InferOps answer held in flight while a reconnect commits, or while the account is revoked, is discarded with no observation recorded), `__tests__/resources.test.ts` (the picker's copy of the grammar), and `packages/integration-tests/__tests__/inferops-isolation.test.ts` "custom tables" (the real Workshop and gatekeeper Worker: reads without the personal column as observations and GET only, another workspace's table, a foreign tenant label and another table's row refused, a shared gadget refused even to a collaborator holding the workspace, the switch off refusing sessions and bindings without a request; the leakage test also checks no personal value reached a log or error).

Custom tables against a live InferOps (2026-10-07, author-local, not CI). InferOps was the composed shared-api (`createApp('stub', { objectsEnabled: true })`, stub auth, no boot attestation) from factory-level/inferops `656f22fe` (merged to `develop` as `83b7d77e`) on a seeded local database, read with an `owner` `dev:token` for tenant `acme`, workspace `operations`, and a table of three rows with one column marked personal and one link to a Projects issue. Three layers, kept apart:

- **Provider composition:** the gatekeeper's own HTTP client and projection against that API (a throwaway script): the personal column present upstream and absent after projection, link labels dropped, `limit` and `relatedTo` honoured, the database's real colliding tenants `internal.operations`, `load.operations` and `canary.operations` (and `acme.knowledge`) refused `NOT_FOUND`, another table's row answered with its own definition, GET only, and no reference text in the logs (7/7).
- **Workshop and gatekeeper:** `packages/integration-tests/__tests__/inferops-tables-live.test.ts` (opt-in, skipped without its variables), with only the InferLab legs answered by a synthetic fixture because InferOps refuses SSO codes for non-Google sessions (inferops ADR 0012): bind and list as the person (3 rows, 3 of 4 columns, the personal one withheld), `internal.operations` refused at bind and another table's row refused, and the installed `inferops.records` gadget's own `loadRows()` returning the same projected rows (3/3).
- **Browser:** the same harness with the production router serving the real frontend build, driven by a local Playwright script (not committed): the owner's workspace gadget view showed the table at desktop and phone widths, and after Reload, an injected 404 (*This table is not available to you*, rows cleared), an injected 503 (*The rows could not be loaded*), a recovery, an empty table (*No rows yet*), and the switch turned off on the running deployment (*InferOps custom tables are turned off*). No personal column or value appeared in any state. The fleet launcher (`pnpm run-local`) could not start on that host: the system file-watcher limit (ENOSPC), which was not changed.

Not proven: a real InferLab sign-in (Google identity remains deferred), a shared or console display (the binding is private, and published bound widgets are out of scope), or a cloud deployment.

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
`__tests__/apply-outcomes.test.ts` covers apply outcomes: the classification, a first-attempt stale
refusal ending the record `failed`, unsimulated and replayed without writing, a refusal that can
pass (`DISABLED`) left pending and unmarked and applied once on, a fingerprint mismatch failed
unsent, a later refusal after an earlier dispatched attempt staying unknown, a lost response
replayed under its key into one write, a legacy record's refusal unknown, and a legacy dispatch
never sent. `dispatch.test.ts` and `wiki.test.ts` cover a refused dispatch and page edit stored
unknown and not sent again, and a page edit whose write committed with its response lost not sent
again.
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
malformed responses, connection configuration, and write stages: InferOps' 400, 401, 403, 404 and
409 to the write marked refused (a policy 403 named), the same statuses without InferOps' error
envelope proving nothing except a 401, 429, 5xx, a lost response and an unusable success proving
nothing, and a failed check or scope read marked unsent with no write sent. The gatekeeper's own tests never run its
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
workspace list failing the connect and signing the session out, a page edit applied after the
person's session died sending nothing and reported not applied (not reconcile-only), then applied
once after a reconnect, InferOps denying a workspace
without expiring the account, observer admission by the collaborator's own membership, and a
create and an update proposed before the session ended not applied after it.
`__tests__/wiki.test.ts` (workerd, over the mock) covers the Wiki: its grammar and the page
reference, binding the demo Wiki and refusing another workspace or tenant, a workspace without
InferMind refused at binding, on every read and at apply, the page list and page reads as
observations with versions, wikilinks and only standalone references, the agent text, unknown,
malformed and section-less pages, an edit queued and shown pending and written once on approval,
stale, unknown and malformed edits refused at proposal, an unchanged body and a second pending
edit, an edit made stale in InferOps refused at apply (unsent), an edit already in effect counted as
applied without a second write, a tampered or unsigned record refused by its fingerprint,
rejection, revert and its refusal, `INFEROPS_ENABLED` off and on, and observer admission. For
pages and structure it covers the structure read as an observation, a page's body, version and
Master role, the page text of a body-only SOP (title H1 dropped, another heading kept), of a page
with a body and a section (body only), of the section-less root and pillar Masters (generated
blocks, slash slugs encoded) and of a page with nothing to read (`NOT_FOUND`), and body edits:
shown as `pendingBody`, applied once, refused stale at proposal, stored unknown when InferOps
refuses it stale at apply (content left) or when another writer wrote the same body, not sent
again after a write whose response was lost (InferOps' own key-bound replay checked on the mock),
fingerprint tampering, rejection, a second pending edit (`CONFLICT`), the revert only at the
produced version, and the Wiki refused (`FORBIDDEN`) at proposal and, unknown and not resent, at
apply.
`account.test.ts` adds a connected person's InferMind workspace bound by slug with their own token
there, one of their InferOps workspaces refused as having no Wiki and an InferMind one refused as
a board (both before any request), an unheld workspace refused like a missing Wiki, a tampered
tenant label, InferOps' product or permission refusal as one `FORBIDDEN`, and Wiki observer
admission; `http-inferops.test.ts` the knowledge requests, `null` and empty answers, the 403
message, a section of another page, malformed responses, the page detail's body, version and
Master role, the structure parsed field by field and refused when malformed, and the page PATCH
(body and expected version only, the key, no read first, same-key replay, `STALE_VERSION` as
`STALE_REVISION`); `resources.test.ts` the Wiki
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

### Apply-outcome live run (2026-10-07)

Step e2 records a stale update's outcome, and step h records a policy-refused move's outcome as
`failed` / `notApplied` / not retryable. Step h also refuses a second approval of that move. Step h2
covers what happens across reloads:

- It restarts the Workers with `INFEROPS_ENABLED=false`, then again with it back on.
- Across both restarts, the two refused actions keep their state and their `lastAttempt`, and
  approving either again is refused (`not pending`). Their issues are unchanged in InferOps.
- An update approved while the integration was off stays `pending` as `notApplied` / `DISABLED` /
  retryable. Nothing reaches InferOps until it is approved again with the integration on; it then
  applies once, and a further approval is refused.

The run used InferOS `main` at `c577a68` plus this step, against a fresh InferOps worktree off
`develop` `83b7d77e`:

- **Database:** its own `inferlab_78`, created and seeded from `db/init-db.sql`, `migrate` and
  `seed`.
- **API:** served launcher-free. A local script ran `createApp('stub')` from `apps/_shared-api`
  with `EVENTS_DRIVER=log` and `COMM_EMAIL_DRIVER=console`, on port 15880. `main.ts` was not run, so
  there was no boot attestation and no widget-catalog converge, and no secret layer was decrypted.
  Without `EVENTS_DRIVER=log`, the development config's Pub/Sub event driver stalled every write on
  the cloud metadata server. The first attempt failed that way, and nothing else was changed.
- **Connection:** the stopgap connection, with the seeded `owner` persona token.

Ten steps passed and three were skipped (i, j and k: no enrolled repository, and no Wiki workspace
on the token).
- e2: ENG-11 was overtaken at revision 190, its update failed with 409 `STALE_REVISION`, and it stayed
  at 190.
- h: CPOL-2's move from Draft to Published was refused with 403 `FORBIDDEN` (`EXPLICIT_DENY`), and
  the issue stayed in Draft.
- h2: actions 7 and 13 were unchanged across both reloads. Update 15 stayed pending while the
  integration was off, with InferOps still at 190, then applied once (revision 204).

Not shown: an `unknown` outcome against a real InferOps (a lost response is exercised only against
the fake), per-person identity, and any deployment.

## Explicit AG-UI approval bridge

`POST /api/operate/agui/approval` adapts one existing queued InferOps board transition through the current authenticated workspace capability and action journal. The [source-adjacent wire contract](../../packages/workshop-backend/src/operate-agui-approval.md) defines the canonical1.0 request, one-answer cap, ten-minute interrupt expiry and namespaced reason. This is a deterministic approval run, not a model turn; read-only AG-UI endpoints keep their policy.

The journal stores person/thread/initial-run/interrupt/proposal correlation and the explicit decision. A sparse index binds one action to each person's thread. Snapshots precede the terminal interrupt, carry bounded reference-only transition simulation, and derive state from the existing action record and last attempt. Client messages/state are ignored; tools/context cannot grant authority. Every request reopens the workspace as its authenticated caller. The existing use-only facade hides actions and refuses this method: there is currently no visible-but-non-approver capability, and this bridge creates none.

Unchanged approval/rejection reuse approveAction/rejectAction and the existing action claim. The facet rechecks scope/request fingerprint and uses the original provider key/revision; InferOps rechecks current permissions/workflow policy. Identical replies reconcile the recorded outcome; conflicting replies refuse. A lost response remains unknown until an authoritative receipt, including after a later refusal. External action decisions reconcile on a fresh-client reload. Successful transport does not mean applied.

Edited target arguments validate against the current issue/revision/workflow, stage a fresh transition and invalidate the old facet proposal without applying it. A durable replacement link recovers an interrupted edit; the existing journal records the replacement and emits a new interrupt with a new key/fingerprint. The prior answer never approves changed arguments. No multi-action atomicity, implicit guards, new role engine, frontend, deployment or live-identity proof is claimed.
