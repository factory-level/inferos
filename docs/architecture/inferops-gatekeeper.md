---
title: InferOps gatekeeper
design: https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/inferops-gatekeeper.md
covers:
  - custom-gatekeepers/gatekeeper-inferops
  - packages/bundled-blueprints/blueprints/inferops-kanban
  - packages/bundled-blueprints/blueprints/inferops-records
  - packages/bundled-blueprints/libraries/service-dashboard
  - packages/bundled-blueprints/blueprints/inferops-service-jobs
  - packages/bundled-blueprints/blueprints/inferops-service-job-status-counts
  - packages/bundled-blueprints/blueprints/inferops-service-job-recent-activities
  - packages/bundled-blueprints/blueprints/inferops-service-dashboard
  - packages/bundled-blueprints/blueprints/inferops-members
  - packages/bundled-blueprints/blueprints/inferops-dot
  - packages/bundled-blueprints/blueprints/inferops-workflow-policy
  - packages/gatekeeper-kit
  - packages/workshop-shared/src/gatekeeper.ts
  - packages/workshop-backend/src/user.ts
  - packages/workshop-frontend/src/features/auth/AccountSubjectPassCard.tsx
  - packages/workshop-backend/src/account-subject.ts
  - packages/workshop-backend/src/user-directory.ts
  - packages/workshop-backend/__tests__/account-subject.test.ts
  - packages/workshop-backend/src/auth/config.ts
  - packages/integration-tests/__tests__/inferops-isolation.test.ts
  - packages/integration-tests/__tests__/inferops-live.test.ts
  - packages/integration-tests/__tests__/inferops-members-live.test.ts
  - packages/integration-tests/__tests__/inferops-wiki-proposals-live.test.ts
  - packages/integration-tests/__tests__/inferops-workflow-policy-live.test.ts
  - packages/integration-tests/__tests__/operate-chat-no-workflow-policy.test.ts
  - packages/integration-tests/__tests__/inferops-workflow-policy-gadget.test.ts
  - packages/integration-tests/src/inferops-fake.ts
  - packages/workshop-backend/src/server.ts
  - scripts/release/manifest-lib.ts
  - packages/workshop-backend/scripts/company-data-dashboard-proof.ts
  - scripts/run-dev-server.ts
updated: 2026-11-12
---

# InferOps gatekeeper

## Overview

`custom-gatekeepers/gatekeeper-inferops` (package `@inferos/gatekeeper-inferops`, vendor id
`inferops`) implements the reviewed agent-facing API from the
[design](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/inferops-gatekeeper.md). Its `src/types.d.ts` is the design's
`inferops-gatekeeper-api.d.ts`, extended by `findBoards` and the FAC-172 service-query/comment surface (below): `InferOpsProjectSession` (`readBoard`, `openIssue`,
`createIssue`, `findBoards`, `readServiceQuery`) and `InferOpsIssueSession` (`read`, `transition`, `update`, `activity`, `comment`), with `Issue.pending`
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
`…/knowledge/document/<slug>`, or by the alias `…/knowledge/page/<uuid>` InferOps also reads (FAC-68),
both of which `parseWikiDocumentUrl` parses for the canvas; a reference is never bound. A page read
(`readDocument`) and each search hit (`searchWiki`) carry InferOps' own reference for the page as
`ref` (`listDocumentRefs`, InferOps' `document.company_list`), never one built here, and only one
naming this Wiki's own host; an InferOps that names none (before factory-level/inferops#2647), or
can't answer, leaves `ref` out. The same page is so named alike by the global Wiki, InferOps search,
the Dot and this Wiki.

An account kind, `inferops://<tenant>/account` (`inferops://demo.local/account` for the demo data),
binds an `InferOpsAccountGatekeeper` whose `InferOpsAccountSession` (`listWorkspaces`, `findBoards`,
`openBoard`, `openWiki`) serves every board and Wiki the person's own account can open in that
organization through one connection, each checked when it is opened
(ADR 0015, `docs/adr/0015-inferops-account-connection.md`, proposed in [inferos#308](https://github.com/factory-level/inferos/pull/308); see
[InferOps account](#inferops-account)). Dispatch, workflow policy, custom tables and members keep
their own bindings.

The package is the reference [connection package](connection-extensions.md): `connection.json`
states its contract (resource kinds, reads and writes, approval, provider errors, simulation limits,
configuration names, the pinned InferOps revision), and `__tests__/conformance.test.ts` runs
gatekeeper-kit's shared conformance suite against a `project/board` binding.

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | Vendor (connected accounts with an InferLab origin, auto-provisioned demo accounts without), account (`GatekeeperUser`: bind, configurator, revoke, reconnect), verifier, project-board gatekeeper facet, sessions, `clientFor` (which data source and whose authority), HTTP entry for the sign-in legs. |
| `custom-gatekeepers/gatekeeper-inferops/src/auth-proxy.ts` | The sign-in proxy: on `INFERLAB_AUTHORIZE_ORIGIN`, forwards central-auth's `/authorize`, `/authorize/persona`, `/logout` and the Google edge's `/auth/oauth/sign-in/social` and `/auth/oauth/callback/google` to `INFERLAB_AUTH_ORIGIN` with the edge header and `x-inferos-authorize-origin`. See [sign-in proxy](#sign-in-proxy). |
| `custom-gatekeepers/gatekeeper-inferops/src/deployment-company.ts` | `INFEROPS_COMPANY`: the one company the deployment belongs to (a tenant id, `internal`, unset or malformed), `companyAdmits`, and the refusal messages, which name no company. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts` | InferLab PKCE flows: `INFERLAB_AUTH_ORIGIN` and `INFERLAB_AUTHORIZE_ORIGIN` validation, `inferOpsApiEndpoint` (the one place the API base URL comes from), `InferLabLogin` Durable Object per attempt (sign-in, connect or reconnect), `/authorize` redirect (to the authorize origin when set), `/oauth` callback, the sign-in proxy's dispatch, server-side code exchange, the workspace-slug read, and what each purpose does with the session. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-credentials.ts` | `InferOpsCredentials` Durable Object per connected account: the InferLab session (access and refresh token) under gatekeeper-kit's `CredentialCoordinator`, the identity and the InferOps and InferMind workspaces InferLab reported with each one's slug (an InferMind one marked `product: "infermind"`), slug resolution per product (`resolveWorkspace(slug, product)`, InferOps by default), refresh (`POST /auth/refresh`), logout (`POST /auth/logout`), staged reconnects, and the once-only expiry notice. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-client.ts` | `InferOpsClient` data-source contract (board, issues, the coding calls `listRepos`, `listRuns`, `readRun`, `dispatchIssue`, `cancelRun`, and the Wiki calls, among them `readDocument` with the page's body, version and Master role, `readStructure`, `updateDocument`, `searchWiki` (`knowledge.search`, returning `WikiSearchRecord`s without `score`), `listDocumentRefs` (FAC-68: each page's InferOps reference by id, from `document.company_list`; empty when InferOps can't answer) and the proposal calls `listProposals`, `readProposal` and `approveProposal`, whose refusals read as `PROPOSAL_APPROVE_REFUSED` in both implementations) and `InferOpsError` codes (`NOT_FOUND`, `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`, `CONFLICT`, `RUN_ACTIVE`, `UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`, `DISABLED`), with the facts a failure proves: its `WriteStage` (`unsent`, or `refused` by InferOps in answer to the write: a 401, or a 400, 403, 404 or 409 carrying InferOps' error envelope) and whether a `FORBIDDEN` is a workflow-policy refusal. They hold only in the isolate that raised the error; `atStage` restores a stage across the mock's RPC boundary. |
| `custom-gatekeepers/gatekeeper-inferops/src/apply-attempts.ts` | What an unsuccessful apply proves (`classifyAttempt`), what kind of reason it was (`failureKind`, FAC-119), each kind's `ApplyPolicy` (`BOARD_WRITES`, `PROPOSAL_APPROVE`, `RECONCILE_ONLY`), `CheckRefused` for a gatekeeper check that refuses before sending, and which refusals can pass (`canPass`). |
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
| `custom-gatekeepers/gatekeeper-inferops/src/mock-inferops.ts` | `MockInferOps` Durable Object per (host, account), seeded from `src/fixtures/demo-board.json`; the only module that holds project data. Serves host `demo.local` only. Implements transition, create and update with InferOps' checks and per-key replay, and refuses a key reused for a different request (`IDEMPOTENCY_CONFLICT`). Also two demo repositories and a run ledger with InferOps' dispatch guards and replay, and `setRunStatus` standing in for the runner. A synthetic Wiki (`src/fixtures/demo-wiki.json`, stored under `wiki:v2`: a company root without a body, two pillars with Masters (Engineering has neither body nor sections), a body-only SOP whose body opens with its title, a slash-slugged SOP `dispatch/dispatch-a-crew` filed in both pillars whose body opens with another heading, a page with both a body and a section, and one with nothing to read) with InferOps' section semantics (a write advances the version by one, takes no expected version and replays nothing), its page semantics (`updateDocument` is a strict compare-and-swap on the page version that replays only the same key with the same expected version and body one version on, a receipt standing in for InferOps' key, principal, expected version, operation and payload) and its structure read (pillars by position, members by title, the unfiled pages), and `setInferMindEnabled` to make the demo workspace one without InferMind. `searchWiki` is a plain full-text stand-in for `knowledge.search` (every query word in the section body, case-insensitive, ranked by occurrences, ties by section id, a snippet of at most 300 code points with `<b>…</b>` around matches, no `score`), and `setSearchUnavailable` makes it fail as InferOps' timeout does. Its drafted proposals (the fixture's `proposals`, stored under `wiki:proposals:v1` and hashed over InferOps' canonical proposal document) follow InferOps' `approveProposal` exactly: the account's role (`setProposalRole`; Viewer and Member lack `knowledge:publish`), replay for the same principal and hash on a decided proposal, `CONFLICT` for another decided state or a failed integrity re-hash, stale for a superseded revision, another hash or other sources, the self-decision refusal for the requester or reviser (the demo account is principal `MOCK_PRINCIPAL`), and a new page's parent. An approval queues one publish job; the test-only `runPublishJobs` claims each approved proposal once and publishes it as InferOps' job does (an edit keeps the page's id, parent, order, Master role and pillars; a new page goes under its parent, filed in its pillar) or ends it `stale`; `reviseProposal`, `seedProposal` and `proposalCounts` serve the tests. `forget` (an account's `revoke`) deletes the account's data and leaves a tombstone, so every later call is refused `UNAUTHORIZED` rather than re-seeding demo data under a binding that outlived its account. Development only ([#28](https://github.com/factory-level/inferos/issues/28)): `MOCK_INFEROPS_SYNTHETIC_ISSUES=<n>` (1 to 2000, passed through by the dev server from the shell or `.dev.vars`) adds a deterministic synthetic project `PERF` of n issues over six states when an account's data is first seeded, for measuring the Kanban against a large board; unset or out of range it adds nothing (`__tests__/synthetic.test.ts`). |
| `custom-gatekeepers/gatekeeper-inferops/src/http-inferops.ts` | `openHttpInferOpsClient`: `InferOpsClient` over `fetch` for a fixed connection or an endpoint whose authority (token and workspace) is fetched per request, with field-by-field response parsing, the project-scope check and the error mapping. `listWorkspaceSlugs` reads `GET /workspaces` for the connect flow. `endpointFromEnv` reads the API base URL and `connectionFromEnv` the stopgap connection from worker vars. Its coding calls read `GET /project/repos` (dropping `gitUrl`), `GET /project/runs` (filtered to the bound project's issues), `GET /project/runs/<id>`, and send `POST /project/issues/<id>/dispatch` and `POST /project/runs/<id>/cancel`, each after the issue's or run's scope check. Its Wiki calls read `GET /knowledge/documents`, `/knowledge/documents/<id>` (with `body`, `version` and `masterRole`, an absent role read as none), `/knowledge/wiki/structure` (each page's `documentId`, slug, title and parent, a pillar's key, title, position, Master and members with their `source`, all checked field by field), `/knowledge/sections?documentId=<id>` (after finding the page) and `/knowledge/sections/<id>`, search with `GET /knowledge/search?query=&limit=` (see Wiki search below), and send `PATCH /knowledge/sections/<id>` with `{body}` only (after finding the section) and `PATCH /knowledge/wiki/pages/<id>` with `{body, expectedVersion}` and the key, unread first (its 409 `STALE_VERSION` maps to `STALE_REVISION`, its 404 to `NOT_FOUND`), parsing InferOps' bare responses, answering `null` or an empty body as `NOT_FOUND`, and mapping every 403 to one `FORBIDDEN` message (`WIKI_FORBIDDEN`). Its proposal calls read `GET /knowledge/wiki/proposals[?state=]` and `/knowledge/wiki/proposals/<id>` (field by field, dropping every principal, the decision note, the grounding and the approved-source copy; a 404 is the one proposal `NOT_FOUND`) and send `POST /knowledge/wiki/proposals/<id>/approve` with `{proposalHash, sources}` and the key, outside the Wiki's 403 collapse: its own `approveFailure` maps 409 `STALE_PROPOSAL` to `STALE_REVISION`, any other 409 to `CONFLICT`, 403 `SELF_APPROVAL_DENIED` to `CONFLICT`, any other 403 to `FORBIDDEN`, 422 `NEEDS_PLACEMENT` to `INVALID_REQUEST` (a refusal for this request alone) and 404 to `NOT_FOUND`, and an answer that is not this proposal approved at this hash is `UNAVAILABLE`. The only module that talks InferOps HTTP. A run's result keeps `patch`, `tests` (the runner's test commands, counts and artifact paths) and `reasonCode` only when well formed, leaving out a malformed or unknown one whole (`parsePatch`, `parseTests`). |
| `custom-gatekeepers/gatekeeper-inferops/src/resources.ts` | Resource grammar `inferops://<tenant>.<workspace>/project/<kind>/<KEY>` with `<kind>` `board`, `dispatch` or `workflow` (`parseProjectWorkflowUrl`, `projectWorkflowUrl`; the InferOS-minted workflow kind's `SupportedResource` with `excludeFromOperateChat`), `inferops://<tenant>.<workspace>/knowledge/wiki`, `…/object/table/<tableId>` and `…/portal/members` (`parseMembersUrl`, `membersUrl`; its `SupportedResource` with `excludeFromOperateChat`) (two lowercase slug labels; `demo.local` is the demo data), the three `SupportedResource`s (the Wiki's with `excludeFromOperateChat`), `resourceKind`, `projectResourceKind`, `parseHost`, `isSlug`; the page reference `…/knowledge/document/<slug>` (`parseWikiDocumentUrl`, `wikiDocumentUrl`, slugs of URL-unreserved characters). |
| `custom-gatekeepers/gatekeeper-inferops/src/actions.ts` | The stored action records, a tagged union (`kind`: `transition`, `create`, `update` on a board binding; `dispatch`, `cancel` on a dispatch binding; `section-update`, `document-update` and `proposal-approve` on a Wiki binding) each carrying the exact request it sends (an approval's: the proposal id, hash and its sources sorted by section id); `readAction` reads a record without `kind` (written before creates and updates) as a transition; `fingerprintOf`/`matchesFingerprint` hash the normalized request with the binding's scope, its project key or `knowledge/wiki` (SHA-256 over canonical JSON). |
| `custom-gatekeepers/gatekeeper-inferops/src/simulation.ts` | Board ordering and read-time overlay of pending actions: an issue's live pending transition or update (`pending` `transition` or `update`), and pending creates as provisional cards (`pending: "create"`). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/wiki-ui.tsx` | The Wiki picker: organization and workspace only, building `…/knowledge/wiki`; the account lists only the person's InferMind workspaces for it (and only InferOps ones for the project pickers). |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx` | The same picker for a dispatch binding, building `…/project/dispatch/<KEY>`; offered only while coding dispatch is on. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/account-ui.tsx` | The account picker: the organization only, pre-filled from an agent's request, building `inferops://<organization>/account` (or the demo account when left empty and the account offers demo data); no workspace or project picker. |
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
  ignored, and a failed or malformed list fails the attempt and signs the new session out.
  - **Company (FAC-160, inferops ADR 0009 T6).** A deployment belongs to one company:
    `INFEROPS_COMPANY` is a tenant id or `internal` (InferLab's own, reserved tenants only), and
    `deployment-company.ts` reads it. InferOps is the authority: its token exchange refuses a
    session in any other company, or for an origin it has no company for, with
    `company_not_this_deployment` (403), which the flow shows as "This InferOS belongs to another
    company…", naming neither. With a tenant id set, the gatekeeper checks again: a session from
    another company is signed out and refused before any purpose uses it, and
    `InferOpsCredentials.getCredentials` refuses a stored connection from another company.
    `internal` and unset (local) leave the decision to InferOps, which holds the reserved list.
    Set but malformed, the code isn't exchanged and sign-in is off. It only refuses.

  Then, by purpose:
  - **Sign-in** signs the session out again with `POST /auth/logout`, and hands
    `callback.complete` an account carrying the InferLab principal (`subject`: the auth origin as
    issuer and `user.id`, `subjectOf`) and the normalized email only when `emailVerified` is
    `true`. The Workshop keys the account on the principal ([ADR 0019](../adr/0019-account-keyed-on-stable-subject.md),
    FAC-165), so an email InferLab doesn't vouch for (after an email change) is just not passed on.
    The exchange only answers for a `kind = 'sso'` root, opened after the provider edge
    authenticated the browser as that principal; invitations, impersonation and dev logins never
    reach it. Signing in grants nothing.
  - **Connect** installs the session and identity in the account's `InferOpsCredentials` object
    together with the callback, then calls `callback.complete` with the connected account (its
    `subject` too); if
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
- **Shared configuration.** `InferOpsAccount.holdsSharedConfiguration(action)` answers the
  Workshop's question when a deployment sets `SHARED_CONFIGURATION_GATEKEEPER=inferops` (see
  [Operate mode](operate-mode.md#shared-configuration)). The answer is about one company, the
  session's own: its `scope` is the identity's tenant id, since a connection's workspaces are all in
  its session's company. A session in a company other than the one `INFEROPS_COMPANY` names answers
  for nothing (`scope: null`) and sends no request; a malformed `INFEROPS_COMPANY` throws. Otherwise
  it asks InferOps' `GET /auth/permissions?permissions=configuration:<build|publish>` with the
  person's own token in each workspace stored at connect, in order, through
  `InferOpsClient.holdsPermission`, and says yes at the first workspace whose decision allows it.
- **System credentials (FAC-102, inferos ADR 0011).** A configured system workflow's run acts as an
  InferOps service account, never a person. `GatekeeperVendor.provisionSystemCredential(credentialRef,
  {resourceUrl}, key)` (kernel-only: the Workshop relays an Admin's key once and keeps nothing) asks
  InferOps with the key itself which workspaces it lists (`GET /workspaces`) and who it is there
  (`readCallerPrincipal`, `GET /auth/me`), and stores it only for a **service account** in this
  deployment's company whose workspaces include the board host's; anything else is refused with the
  one fixed "The key wasn't accepted.", never saying why or repeating the key. It's stored in
  `InferOpsSystemCredentials` (one Durable Object per credential reference, migration `v8`, apart
  from people's `InferOpsCredentials`) with the workspace id and host it was checked for; storing
  again rotates it and `forgetSystemCredential` deletes it and retires the reference, so a store
  arriving after it (from a provisioning still checking the key) stores nothing and is refused in
  the same fixed words; the Workshop never reuses a reference. `getSystemGatekeeperClass(credentialRef,
  {resourceUrl})` returns the project-board gatekeeper class with `systemCredentialRef` in its props
  (never the key); boards only. Such a binding's client (`systemClient`) reads its authority per
  request from the store, sends the key as `Authorization: Bearer` (InferOps routes an `iex_` key to
  its service-account lane), and only for the host it was checked for. With nothing stored it's
  UNAUTHORIZED, and InferOps refusing a revoked key fails the call: there is no fallback to anyone's
  token, the stopgap connection or the mock. A key InferOps refuses reads as "The assignment's service-account key was refused. An Admin needs to assign it again." (still `UNAUTHORIZED`, without the person-oriented reconnect hint or a class-name prefix), in a run's calls and in a failed apply. `account.test.ts` ("system credentials") covers the
  check, the refusals, the host, rotation, forgetting, a late store after forgetting and revocation.
- **Running workflows (FAC-102).** `InferOpsAccount.holdsWorkflowInvoke(resourceUrl)` answers whether
  the person may ask a configured system workflow to run against that board: InferOps'
  `workflow:invoke`, asked in the board host's own workspace only, resolved among the person's own
  InferOps workspaces (`resolveWorkspace(slug, "inferops")`). An InferMind or other workspace's
  grant never counts, and a board outside the person's InferOps workspaces is a no, asking nothing
  (the manager, 2026-11-05). The company scope and its refusals are the shared-configuration
  question's, which still takes a yes from any workspace. The Workshop asks it before admitting an on-request run (see
  [Operate mode](operate-mode.md)). A yes isn't shared configuration and grants nothing of the
  workflow's.
  Only an Admin's grant (`owner`, `admin`) holds those permissions, and a grant deny removes either
  from that grant (factory-level/inferops#2551); a deny on one grant doesn't remove the authority
  while another grant in the company still holds it. The Workshop refuses a person whose
  connections answer for more than one company. With `INFEROPS_COMPANY` `internal` or unset, the
  company is whichever InferOps admitted at the exchange, which after factory-level/inferops#2547
  is only one the deployment's origin is mapped to. A 403 or 404 for a workspace is a no there; an
  outage, or an answer without a boolean decision for exactly the permission asked, throws
  `UNAVAILABLE`, so the Workshop refuses rather than guessing. An account without a connected person
  (demo data, a sign-in) answers for nothing; the mock client's `holdsPermission` is always false.
  A workspace granted since the person connected counts after they reconnect.
  `__tests__/account.test.ts` ("shared configuration authority") covers the request, an Operator,
  an Admin in a second workspace, another company's deployment and its own, a malformed setting, a
  refused workspace, an outage and malformed answers, and an account with no person.
- **Presentation company (FAC-88).** `InferOpsAccount.presentationCompany()` names the company the
  Workshop keeps the person's operate page and widget states for (see
  [Operate mode](operate-mode.md#personal-presentation-state-by-person-and-company)): the stored
  session's tenant id, lowercased, read without a request to InferOps. It is null without a
  connected person or for a session `INFEROPS_COMPANY` doesn't admit, and a malformed
  `INFEROPS_COMPANY` throws. `__tests__/account.test.ts` ("the company the person works in")
  covers it.
- **Connection company (FAC-14 K2).** `InferOpsProjectGatekeeper.connectionCompany()` names the
  company a board connection acts in: its connected account's stored tenant id, lowercased, read the
  same way and without a request to InferOps. The Workshop compares it with the person's before a
  widget's declared command is requested on the connection (see
  [Operate mode](operate-mode.md#declared-commands)). It is null for a connection without a connected
  account (the demo board, the stopgap connection, a system run's) or one `INFEROPS_COMPANY` doesn't
  admit, and a malformed `INFEROPS_COMPANY` throws. `__tests__/account.test.ts` covers it.
- **Widget index (FAC-11 slice 2).** `InferOpsAccount.widgetIndexWorkspaces()` lists the
  connected person's workspaces where `configuration:publish` holds, asked as
  `holdsSharedConfiguration` asks, in identity order. `registerWidget(workspaceId, entry)` and
  `withdrawWidget(workspaceId, sourceId, sourceVersion)` write InferOps' `widget.publish`
  (`PUT /knowledge/widget-definitions`, source `inferos.blueprint`, visibility `company`) and
  `widget.withdraw` (`DELETE /knowledge/widget-definitions/:sourceId/:sourceVersion`) through
  `InferOpsClient.publishWidgetDefinition` / `withdrawWidgetDefinition`, with the person's own
  token in `workspaceId`, which must be one of theirs. An account without a connected person (the
  stopgap bearer, demo data, a sign-in) writes nothing and answers `refused`. A 403 is
  `WIDGET_INDEX_FORBIDDEN` (the gatekeeper's own words, not InferOps' message), a 400 or 422 an
  invalid definition, anything else `unavailable`; a definition is checked before sending (id 1 to
  128, version from 1, title 1 to 120, purpose 1 to 2000). The demo's mock has no index and answers
  `unavailable`. Only the Workshop's build-role `publishConsole` and `deleteConsole` call them (see
  [Operate mode](operate-mode.md#widget-index)), directly rather than as approved actions: the
  divergence below.
- **Widget search by intent (FAC-13).** `InferOpsAccount.searchWidgets(query, k)` asks InferOps'
  `widget.search` (`GET /knowledge/widget-search?query&k`, `knowledge:read`) through
  `InferOpsClient.searchWidgets`, with the connected person's own token, in each of their
  workspaces (as the sign-in recorded them), and merges the answers (`mergeWidgetSearches`): each
  built-in kind and each definition (`<sourceId>@<sourceVersion>`) once, at its best score, best
  first, at most `k` of each. It returns definitions only (`WidgetSearchAnswer`): no instance,
  record or live data.
  - **Nothing asked** is said, never shown as "no widgets": an account without a connected person of
    `INFEROPS_COMPANY` answers `{status: "unavailable", reason: "reconnect"}`, and a person with no
    InferOps workspace `no-workspace`.
  - **Denied** only for InferOps' own missing-permission refusal (`Missing permission:
    knowledge:read`, read from its error envelope; `WIDGET_SEARCH_DENIED`): that workspace was asked
    and adds nothing, counted in `denied`. Any other 403 (a product refusal, a workspace the person
    no longer holds) is a workspace not searched.
  - **Partial outages** are counted in `unsearched`, beside what the other workspaces found. If
    every workspace failed so, the last failure is thrown. A 404 (an InferOps without
    `widget.search`) or an outage is `UNAVAILABLE` in `WIDGET_SEARCH_UNAVAILABLE`'s words; an
    answer that doesn't parse, or holds more than `k` of either, is refused as malformed. The demo's
    mock has no index and throws.
  - Scores from workspaces ranked differently (one `semantic`, one `keyword`) are merged on one
    scale, and the answer reads `semantic`. A deployment has one embedder, so this only orders.
  - **What a built-in kind declares (FAC-14).** Since inferops#2626 a hit may carry `metadata`
    (`defineWidget`'s permission, `freshnessSeconds`, `supportedSizes` and actions' id, label,
    reversibility and permission). `parseWidgetMetadata` keeps it when every field is well formed
    (`resource:action` permissions, bounded lists) and otherwise leaves it out rather than fail the
    search: the field is new, and it grants or refuses nothing either way. The operate agent shows
    it in `findWidgets` ([Agent widget verbs](operate-mode.md#agent-widget-verbs)).
  - `__tests__/http-inferops.test.ts` ("widget search by intent (FAC-13)") covers the request, its
    parsing (the metadata kept and a malformed one left out), and which 403 reads as denied.
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
  A state's or card's workflow is one of `content`, `software` and `service` (InferOps' Service
  jobs ladder, at the pinned inferops `470d745d`, `project-board.schema.json`); any other value
  makes the whole board answer `UNAVAILABLE`. Coding dispatch stays `software`-only.
- **Activity** (FAC-157). `InferOpsIssueSession.activity()` reads InferOps' `issue.history` (field
  changes and comments) with the connection's own InferOps access.
  - **Placement:** it reads the issue first, so an unknown issue or one of another project is the
    same `NOT_FOUND`, and nothing is observed.
  - **Shape:** it returns the most recent 100 entries, newest first (`toIssueActivity` in
    `inferops-client.ts`), with how many earlier ones were left out. Who acted is reduced to person,
    agent (a service account) or system, and no principal id leaves the gatekeeper.
  - **Paging and bounds:** InferOps pages history oldest first, so the HTTP client reads it page by
    page, at most 50 requests.
    - Each page's body is streamed through `readTextCapped` and abandoned at 256 KiB before it's
      parsed (`Send.capped`); a failed page's body is capped at 4 KiB.
    - Page size adapts. InferOps allows comments and descriptions of 20,000 characters, up to about
      120 KB an entry as JSON, so only one is sure to fit, while most entries are a few hundred
      bytes. A read asks for 100, sizes each next page from the last page's bytes per entry, and
      asks again for half as many when a page goes over the cap. Only a single entry over 256 KiB,
      which InferOps' limits rule out, fails the read (`UNAVAILABLE`).
    - Each page goes straight into `ActivityWindow`, a rolling window of the newest 100 entries.
    - Comments and values are cut to 2,000 characters as they're kept (`shortened: true`).
    - So one read holds one page plus the window, however long the history.
    - A history needing more than 50 requests (about 5,000 typical entries, at least 50 of the
      largest) fails `UNAVAILABLE` rather than show older entries as the latest.
    - A newest-first `issue.history` in InferOps would make this one request; that's an InferOps change.
  - **Refusal and logging:** InferOps' refusal of the history is passed on as `FORBIDDEN`. One
    observation names the issue and the count. Pending changes aren't activity until applied.
  - **The mock** records each applied write's fields as a person's change.
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
  explicitly, naming the state's workflow (`content` or `service`) unless it is InferOps' default
  `software`. Until decided, `readBoard()`
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
- **Receipts (FAC-97 part 2).** `createIssue`, `transition`, `update`, `dispatch`, `cancel`, `updateDocumentBody`, `updateSection` and `approveProposal` return the kernel's receipt (`WriteReceipt` in `types.d.ts`: `actionId` and `status()`, whose outcome and bounded result come from the action log, and whose refusal is a `WriteFailureCode` with one fixed sentence: InferOps' own error text never reaches the caller and stays in the action log), through `ProjectBinding.submit`. A write with nothing to do returns `null`: a create that joins one already pending, a move to the issue's current state, an update that changes nothing, a cancel already pending, and a Wiki edit that changes nothing or is already pending. Simulation is unchanged: reads still show a pending write as applied, and the receipt is how a caller tells whether it has been. This reverses the earlier rule that callers never see approvals (see [Operate mode](operate-mode.md), Write receipts).
- **Applying.** `applyAction` reads the record (a record without `kind` is a transition and has no
  fingerprint to check), recomputes the fingerprint of the request it is about to send and refuses
  a mismatch without sending anything, marks the record dispatched (`attempts.dispatchedAt`), then
  calls the data source with idempotency key `<facet instance id>:<action id>`; the data source
  rechecks scope, state, workflow and revision, and a replayed key returns the original result
  without writing again, so a create whose response was lost is retried into the same issue. An
  applied create records the new identifier, an applied move or update the revision it produced, stored
  after the success and outside the failure handling. A success, and a replay of an action already
  applied, returns `{applied: {result}}` (FAC-97): `appliedResult` in `actions.ts` reports the kind and
  whichever of the created identifier, the produced revision, the queued run, the produced page
  version or the approved proposal's state the record keeps, so the overseer keeps InferOps' own answer
  as the action's result (see "Truthful outcomes" under [Operate mode](operate-mode.md#data-and-control-flow)). A
  field a record applied before it was kept lacks is left out. `apply-outcomes.test.ts` ("what an
  applied write reports") covers a move, an edit, a replay and a refusal reporting none.
  `rejectAction` deletes the record, which ends the simulation.
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
  - *Its kind* (FAC-119, `failureKind`): every failure says what kind of reason it was, from its
    code and InferOps' policy flag only, never its words, and the stored failure keeps it so a
    replay answers the same. A workflow-policy `FORBIDDEN` (`isPolicyRefusal`, InferOps' policy
    envelope) is `policy` and a missing permission's `FORBIDDEN` is `permission`; `UNAUTHORIZED` is
    `sign-in`; `STALE_REVISION`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RUN_ACTIVE` and
    `WORKFLOW_MISMATCH` are `conflict`; `INVALID_REQUEST`, `INVALID_STATE` and `NOT_FOUND` are
    `invalid`; anything else, and an error with no code, is `unavailable`. The kernel keeps it on
    the action (`ActionAttempt.kind`), and the approval bridge reports it (see
    [Operate mode](operate-mode.md#explicit-ag-ui-approval-bridge)). `apply-outcomes.test.ts`
    ("the kind of a failure") covers it.
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
- **Wiki search** (FAC-66, the accepted knowledge read and search contract). `searchWiki(query,
  {limit})` refuses, before any request, a query that is empty or over 500 characters after
  trimming, and a `limit` that is not a whole number from 1 to 50 (default 20), all as
  `INVALID_REQUEST`. It refuses the deployment's stopgap connection (`FORBIDDEN`, sending nothing),
  then takes one search from the account's throttle: `InferOpsCredentials.admitWikiSearch`, at most
  30 in any 60 seconds per account across all its bindings, past which it fails `UNAVAILABLE` saying
  when to retry. The client sends `GET /knowledge/search?query=&limit=` with the binding's own token
  and workspace and nothing else, so no argument can widen the scope; InferOps applies its row
  rules and the lens before choosing candidates. Each hit keeps `sectionVersion` and a snippet of at
  most 300 code points, checked field by field, and `score` is dropped. A 404 (an InferOps before
  `knowledge.search`), a 503 such as `SEARCH_TIMEOUT`, a 429, any other 5xx and a malformed answer
  (more hits than `limit`, a longer snippet) are all `UNAVAILABLE` with `SEARCH_UNAVAILABLE`, never
  an empty list; a 403 is the one Wiki `FORBIDDEN` and a 400 `INVALID_REQUEST`. A section with an
  edit pending through the binding is marked `pending: "update"` with its committed snippet. The
  search is one observation (`Searched the InferMind Wiki`) with the query's first 100 characters
  and each hit's section tag and page slug, never a snippet, and it excludes every admitted
  collaborator (`observeWithheld`), since the answer reflects the owner's lens. Snippets are
  documented as text: InferOps still emits `<b>…</b>` (decision 6's sentinels are not built), and
  InferOS never renders them as HTML.
  Tests: `__tests__/wiki.test.ts` ("search") over the mock and `__tests__/http-inferops.test.ts`
  over a fake InferOps. Live (local, this branch, 2026-11-04, InferOps `470d745d` from `pnpm local
  inferops up --rev`, not committed as a test): with `openHttpInferOpsClient.searchWiki`, the acme
  owner found the section it had just made (`sectionVersion` 1, no score); the acme member, who
  holds the Wiki but neither made the section nor reaches it through a confirmed relationship, got
  no hits; the acme viewer and admin, and the second company (grokbot) naming acme's workspace,
  were refused `FORBIDDEN`; the second company's own Wiki had no hits; and InferOps' `ts_headline`
  had removed the author's own `<b>` tags from the snippet, leaving only its highlight.
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
`InferOpsCredentials`, `v2`: `InferOpsDispatchGatekeeper`, `v3`: `InferOpsWikiGatekeeper`, `v4`: `InferOpsTableGatekeeper`, `v5`: `InferOpsMembersGatekeeper`, and `v6`: `InferOpsWorkflowPolicyGatekeeper`); `wrangler.jsonc` is generated. The worker needs no secrets, except the optional edge secret below. `BASE_URL` is
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
| `INFEROPS_WORKFLOW_POLICY_ENABLED` | `"true"` turns workflow-policy bindings on; anything else, or unset, is off, and it is off while `INFEROPS_ENABLED` is. `pnpm dev-server` always sets it (off unless asked for). Deployed, only the dev stage turns it on, through its `inferops.resources` list (`scripts/stage/stages.ts`); prod leaves it off ([workflow policy](#workflow-policy)). |
| `INFEROPS_HOST_BOARDS` | `"true"` turns the kernel-only host-board read on; anything else, or unset, is off, and it is off while `INFEROPS_ENABLED` is. Nothing sets it yet: `pnpm dev-server`, wrappers and the release leave it unset ([host boards](#host-boards)). |
| `INFERLAB_AUTH_ORIGIN` | InferLab central-auth origin (bare HTTPS, or HTTP on loopback). Set, it turns on sign-in and makes every account a connected person; the exchange, refresh and logout go here. Unset means demo accounts. |
| `INFEROPS_BASE_URL` | InferOps API base URL connected people call with their own session. It never appears in a resource URL; the account's display name shows its host. Unset, the InferLab origin serves as the API too (locally one server serves both). |
| `INFEROPS_API_TOKEN` | Stopgap bearer token (a user access token or an `iex_` service-account key) for accounts with no identity. Requires the base URL, the workspace id and the workspace slug, else an error names the missing variable. |
| `INFEROPS_WORKSPACE_ID` | The workspace UUID the stopgap sends as `X-Workspace-Id`. |
| `INFEROPS_WORKSPACE_SLUG` | The stopgap workspace's slug: a resource URL whose `<workspace>` is this slug (for example `inferops://acme.operations/project/board/ENG` with `operations`) uses the stopgap connection. |
| `INFERLAB_AUTHORIZE_ORIGIN` | Optional bare origin the browser is sent to for `/authorize` instead of `INFERLAB_AUTH_ORIGIN`, served by this gatekeeper's [sign-in proxy](#sign-in-proxy). Set but malformed, sign-in is off rather than falling back. Server-side calls never use it. |
| `INFEROPS_EDGE_SECRET` | A **secret**, not a var. Optional. It is the shared value that InferLab's IP-allowlisting edge lets through (dev InferLab's Cloud Armor rule, InferOps `waf:inferosEdgeSecret`); see [edge header](#edge-header). Unset, no header is sent. |

`demo.local` bindings keep working beside a configured API.

**The stopgap is for local development.** Its token is one credential for the whole dev server,
so every account that has no identity acts with it and observer verification cannot tell those
people apart. It never backs a connected person, and the release manifest offers no input for any
of these vars, so a deployed instance cannot be given them through the deploy wizard.

### Edge header

A hosted Worker reaches InferLab from Cloudflare's shared egress IPs, so an IP-allowlisting edge refuses it. `src/edge-header.ts` builds the one `fetch` that every outgoing request uses: `inferLabFetch(env)`.

- When `INFEROPS_EDGE_SECRET` is set, a request whose exact origin is `INFERLAB_AUTH_ORIGIN` or `INFEROPS_BASE_URL` carries `x-inferos-edge: <secret>`. The secret is trimmed first, and its redirect is forced to `manual`. Any other URL is fetched untouched. When the secret is unset, the function is plain `fetch`.
- It is threaded through every caller as a required `fetcher`. The callers are:
  - the token exchange (`exchangeCode`, which now also refuses redirects);
  - session refresh and logout (`refreshInferLabSession` and `logoutInferLabSession`, from `InferLabLogin` and `InferOpsCredentials`);
  - the sign-in workspace list (`listWorkspaceSlugs`);
  - the host-board snapshot (`fetchBoardSnapshot`);
  - the HTTP client (`openHttpInferOpsClient`) behind every board, issue, Wiki, table, members, workflow-policy and dispatch call, for connected accounts and the stopgap alike.
- The value is never logged, and nothing in the helper logs. It is an edge credential, not an identity: InferOps authentication, permissions and RLS apply behind it unchanged.
- `__tests__/edge-header.test.ts` covers the following:
  - the header is present for both origins when the secret is set;
  - it is absent when the secret is unset or blank;
  - it is never sent to a foreign or look-alike origin;
  - each request path above carries it;
  - a source guard fails if any `src/` file other than `edge-header.ts` calls the global `fetch`.
- Stages upload the secret with the gatekeeper's version ([stage deploys](stage-deploy.md)). The release manifest offers no input for it.

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
  page (or "New page … under …" and, for a new page, its pillar or "none"), revision, hash,
  summary, source count and the contradictions the draft recorded (or "none") before the content
  verbatim: each is InferOps' record of what the hash binds, shown as data. A card that would drop anything (`descriptionIsComplete` unset, the 96 KiB budget) is
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
- **Governed reads** (FAC-9, the governed data contract in `@gadgets/workshop-shared/governed-data`; inferops ADR 0013, proposed). The same session is also a `GovernedReadSession`:
  - **`describe()`** gives the table's visible columns as fields, each filterable and sortable. `integer` and `number` read as `number`, `timestamp` and `date` as `date`. It declares no commands, since the binding is read-only. It reads the definition alone (`table.get`, `GET /object/types/<id>` in the client's own workspace), with no rows.
  - **`list(query)`** filters, sorts and pages in the gatekeeper, over the newest 50 rows of **one** read. Those rows are already projected with that read's own definition, so a personal column is absent from both the fields and the values, and the probe described above can't happen. `truncated` is true when that read was full, so the table may hold more.
  - **Refusals, before any row is read:** the request's shape is checked first. Then its fields and types are checked against the definition alone (`table.get`). An unknown field and a personal one are refused at that same step, with the same message, and a wrong-typed one is refused there too. None of them reads a row or logs anything.
  - **Checked again:** a valid request reads the rows once and is checked again against the definition those rows came with. So a column that turned personal between the two reads is refused before anything is returned or logged.
  - Every refusal is `INVALID_REQUEST`, with the contract's code in the message.
  - **`get(id)`** is `getRecord`'s read, with a row outside the bound table, or none, as `null`.
  - **Logging:** each read is one observation, and no filter value is repeated into it.
  - **Not yet:** paging past the newest 50 needs InferOps paging (inferops#2335).
  - **Tests:** `__tests__/governed-table.test.ts`.
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
- **Switch.** `INFEROPS_WORKFLOW_POLICY_ENABLED` (`workflow-policy.ts`), off unless `"true"` and only while `INFEROPS_ENABLED` is on, checked on every call. While off, `getSupportedResources` omits the kind, `startResourceConfigurator` refuses its picker, `getGatekeeperClassFor` refuses with `DISABLED`, and `workflowPolicyClientFor` refuses every call of an existing binding or session with `DISABLED: InferOps workflow policies are turned off for this deployment.` Nothing is deleted, and turning it back on resumes. The bundled Workflow policy and Records blueprints' own declared bindings (their `blueprint.json` pattern and example URL) are proved offered and bindable only with their switch on, and never while `INFEROPS_ENABLED` is off (`__tests__/blueprint-bindings.test.ts`), so a blueprint and the gatekeeper can't drift apart unnoticed.
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

### The person's own Dot

FAC-133 (inferos [ADR 0013](../adr/0013-dot-runtime.md) decision 3). A seventh resource kind, `inferops://<tenant>.<workspace>/chatbot/dot`, binds the signed-in person's own Dot in one InferOps workspace into an `InferOpsDotGatekeeper` facet whose props fix the account, host and workspace id. InferOps runs the Dot (its chatbot domain and `shared-agentic`); InferOS relays it and decides its proposals. Its `SupportedResource` sets `excludeFromOperateChat`. It needs InferOps at or after `0c09fa9b` (factory-level/inferops#2618, carrying #2619). Its company-wide knowledge reads and its page edit and create proposals (FAC-136) need InferOps at or after `97e335ea` (factory-level/inferops#2622), which the provider pin `b4c8cd6e` (factory-level/inferops#2626) includes. A company with its own database is refused at the run by InferOps as `COMPANY_DATABASE_UNAVAILABLE` (503), which reads here as the Dot being unavailable; InferOps' run should refuse it in words that say why, as its tool calls do.

- **Switch.** `INFEROPS_DOT_ENABLED` (`dot.ts`), off unless `"true"` and only while `INFEROPS_ENABLED` is on, checked on every call; a wrapper's version 2 capability of the same name, resolved by the dev server like the others. While off, `getSupportedResources` omits the kind, `startResourceConfigurator` refuses its picker, `getGatekeeperClassFor` refuses with `DISABLED`, and `dotClientFor` refuses every call of an existing binding or session.
- **Authority.** A connected person's own sign-in only: the stopgap connection is no one's Dot, and the demo has none (the mock's Dot calls are `UNAVAILABLE`). The URL's workspace slug must be one of the person's InferOps workspaces; every refusal is one message, `No InferOps Dot is available to you on <host>: …`. `startSession` refuses an account that isn't connected with `FORBIDDEN`. Tenant, workspace and principal reach InferOps only as the person's own token and `X-Workspace-Id`, never in a body.
- **Calls.** Only InferOps capabilities: `chatbot.conversation_create`, `_get` and `_cancel`, `chatbot.proposal_list`, `_confirm`, `_decline` and `_run_outcome` (FAC-134), and the run's streaming twin, `POST /chatbot/conversations/:id/runs`. InferOS stores a conversation's id (in the caller's hands) and the staged decision on each proposal (`dot-confirm` action records), never a message.
- **The relay** (`dot-relay.ts`). The run is the only request sent without the 15 s request timeout or a whole-body read. It is read as server-sent events, exactly as InferOps' `streamAguiEvents` writes them (`data: <json>` frames, `: ping` heartbeats, LF or CRLF), and each event is handed on only once `@ag-ui/core` 1.0.2's `EventSchema` accepts it. Bounds (`DOT_RELAY_LIMITS`): a 130 s deadline (InferOps aborts at 125 s), 35 s of silence (InferOps pings every 15 s), 256 KiB an event and 4 MiB a run. The relay ends `finished` or `error` on the run's own end, and otherwise `cut`, `malformed`, `oversized`, `deadline` or `silent`, never silently. Strict parsers read every JSON answer; a shape InferOps didn't declare is `UNAVAILABLE`.
- **A turn** (`ask`). The prompt (1 to 16 000 characters) and the optional `page` and `record` (`inferops://` links of at most 2 000 characters) are checked first, then one observation is logged, *Asked your Dot: <prompt, 80 characters>*, and the run starts. The selection is sent as references only; InferOps reads each as the person (A2) and refuses one they can't open before the model runs, which reaches the caller as `NOT_FOUND` in fixed words. Progress (`onProgress`) is delivered in the stream's order: text deltas, tool calls started and finished, each proposal once staged, and an error. `malformed` and `oversized` end the turn `error` with *The Dot's reply couldn't be read. Ask again.*; `cut`, `deadline` and `silent` end it `interrupted`. Except for a `cut`, which InferOps has already noticed, the relay then cancels the run so it doesn't hold the conversation. A run's own error text is passed on, at most 300 characters. One turn at a time per conversation session; another while one runs is `CONFLICT`. `cancel()` stops the running turn (`chatbot.conversation_cancel`).
- **Proposals.** Each proposal a turn shows (`TOOL_CALL_RESULT` carrying the broker's `{proposed, proposalId}`), and any `proposed` one a later `read()` shows that nothing staged (a cut stream, a turn run elsewhere), is staged once ever, in any status, as a `dot-confirm` action and submitted as an ordinary write. None is auto-approvable. The card names the operation and its arguments as InferOps stored them; the caller gets the arguments as JSON text. A knowledge write (FAC-136: `knowledge_page_edit` or `knowledge_page_create`, `DOT_KNOWLEDGE_WRITE_TOOLS`) is the person's own edit, live once made. An edit's card is titled *Your Dot proposes a change to a wiki page*, opens with `DOT_KNOWLEDGE_WRITE_WORDS` (*Your Dot will change this page as you, and readers see it right away.*) and says the person's knowledge access is checked again in that page's workspace. A create's card is titled *Your Dot proposes a new wiki page*, opens with `DOT_KNOWLEDGE_CREATE_WORDS` (*Your Dot will create this page as you, and readers see it right away.*) and says the access is checked again in that workspace. Both name the target as InferOps stored it (`dotKnowledgeTarget`: *Page* for an edit's `page` link, *New page in* for a create's `workspace` link). The link identifies the target and grants nothing; InferOps checks `knowledge:write` at the confirm. No Dot tool publishes, so no card says it does. Approving it calls `chatbot.proposal_confirm` under the person's own token with the proposal id as the idempotency key, which InferOps applies at most once (A2). A confirm InferOps answers as already decided (409 `PROPOSAL_DECIDED`) is read back: confirmed reads as done, declined, failed or expired as not applied, and still confirming or unknown as unknown. It is never assumed done. Rejecting it calls `chatbot.proposal_decline`, and only an outcome InferOps confirmed is recorded:
  - a decline InferOps confirms is kept declined, so it is never staged again;
  - one InferOps refuses as already decided, expired or gone is read back and settled to its true status. Not made (declined, failed, expired, gone) is kept with that truth. Made (confirmed) refuses the rejection, so the person approves it and it is recorded as made.
  - any other failure (unreachable, a timeout, an answer it can't be sure of) records nothing and fails the rejection: the action stays pending, and the person is told the decline couldn't be confirmed and can decline it again.

  A read reconciles with InferOps: a proposal InferOps still shows waiting, but recorded here as decided, is staged again. Who decides: only the person whose Dot it is, since no collaborator is ever admitted. Not revertible.
- **Workflow-run proposals (FAC-120).** The Dot's `inferos_workflow_invoke` (inferops#2627, off behind `chatbot.workflowInvoke.enabled` there) proposes running an InferOS workflow by its trigger reference (`workflow-trigger-ref.ts`: `inferops://<company>.<workspace>/inferos/workflow-trigger/<workspace>/<hook>?definition=…&revision=…`), which names a target and authorizes nothing. It is staged as its own kind, `inferops.dot-workflow-invoke`, with a card naming the trigger and revision, never auto-approvable. It declares the run to the kernel at submit (`ActionDescription.workflowRun`), which binds the approval to that reference. InferOps runs nothing for it: approving it calls the kernel's `ApprovedEffects.invokeWorkflow()`, present only for the person's own approval of that action ([Operate mode](operate-mode.md#approved-workflow-runs)), and only once the run started is the proposal confirmed in InferOps (`handed-off`), keyed by the proposal id, with the run's id on the receipt. A refused run is not applied, in its own FAC-119 kind, and the proposal is declined there only when the refusal stands (a retryable one stays pending in InferOps, r1 on #488); a run that may have started (`unknown`) is uncertain and not retryable, and the proposal is neither declined nor confirmed. Without the effects (an automatic approval, an older kernel) nothing is asked: `policy`, "needs your own approval". A confirm InferOps doesn't answer after the run started is logged (`dot-confirm.workflow.confirm_unanswered`) and leaves the proposal to expire there; the run is recorded here and never started again by approving again.
- **Its run's outcome (FAC-134).** The proposal declares `workflowRun.reportOutcome: true`, so the kernel tells the facet how the run came out (`Gatekeeper.workflowRunOutcome(action, ApprovedRunOutcome)`, at least once, after the run has a final outcome; [Operate mode](operate-mode.md#approved-workflow-runs)).
  - **Relayed to InferOS's Dot conversation:** `recordDotRunOutcome` calls `chatbot.proposal_run_outcome` (inferops#2644) under the person's own token, with fixed fields only: kind, run id, outcome, the kernel's `reason` as `reasonCode`, and `ranAs`. Never what the run returned.
  - **Only for the run it named:** the hand-off's confirm sends the started run's id (`confirmDotProposal(…, {runId})`), so InferOps accepts that run's outcome only, and only from a session it issued to InferOS's client. A person's own InferOps browser, CLI or MCP session can't record one. But InferOS's PKCE client is public, so the person can mint such a session themself: an outcome marked as from the InferOS client can be produced by the person themself, and it is shown as reported, not verified (inferops#2644's documented limit).
  - **Once per run id:** each one is recorded on the action (`reportedRuns`, with `actionApplied` and InferOps' answer). A run id already recorded changes nothing, and a different run id on the same action is recorded once too.
  - **InferOps' answers:** a refusal for good (409: another run already there, or not handed off) is kept as `refused`, not retried. Anything else is thrown for the kernel to retry.
  - **Ignored:** an outcome for any other action of the binding is logged (`dot-run-outcome.ignored`), and nothing is sent.
  - **Tests:** `dot.test.ts`, "deciding a workflow-run proposal".
  - **Shown in the Dot (FAC-134 UI):** InferOps' proposal carries the recorded outcome as `run`.
    - **Parsing:** `parseDotProposal` reads its fixed fields only (kind, run id, outcome, ranAs, and a `reasonCode` that is one of InferOS's fixed reasons, the same set InferOps accepts). Anything else, or an older InferOps without the field, reads as `null`.
    - **The session API:** `DotProposal.run` (`types.d.ts`).
    - **The `inferops-dot` blueprint:** passes only those fields to its page. A workflow-run proposal never reads "Made": `workflowRunWords` gives *Started in InferOS* until its run ends, then *Run finished*, *Run failed* (with a fixed reason in words, never the code) or *Run uncertain*, each with what it ran as. Each recorded outcome is marked *Reported, not verified* (`RUN_REPORTED`): InferOps keeps what InferOS reported, and a person can produce one themself through InferOS's public sign-in client (inferops#2644's documented limit).
- **Temporary canvas proposals (FAC-137).** The Dot's `inferos_canvas_compose` (inferops#2649) proposes a temporary personal canvas: a title and up to 20 placements, each the kernel's typed widget reference (`builtin` or `console-widget`), an optional size (`small`, `half`, `large`) and string filters. It is staged as its own kind, `inferops.dot-canvas-compose`, with a card naming each widget and its filters, never auto-approvable. The facet reads the proposal into the kernel's `TemporaryCanvasInput` (`dotCanvasInput`): each size becomes grid cells on the 12-column canvas (4×4, 6×6 and 12×8, `large` when absent), packed left to right and then down; the reference and filters pass through unchanged, and the kernel's own `parseTemporaryCanvasInput` runs last. Anything the kernel can't take (a list or number filter, an unknown size or field, a reference that isn't the kernel's typed one) makes the whole proposal unreadable: it is staged with no declaration, so approving it asks the kernel nothing, and declining it is the way out; never a partial canvas. The Dot can't fill a console widget's reference yet: `widget_search` returns definitions, not published console instances (a follow-up, once a console-instance search exists). Read, the canvas is declared to the kernel at submit (`ActionDescription.temporaryCanvas`). Approving it calls `ApprovedEffects.createTemporaryCanvas()`, present only for the person's own approval ([Operate mode](operate-mode.md)), and once the canvas is created the proposal is confirmed in InferOps (`handed-off`), keyed by the proposal id, with the canvas's id on the receipt. The kernel creates at most one canvas per action, so a lost answer is uncertain and safe to send again. A kernel refusal (`KernelRefused`, `apply-attempts.ts`) is known not created whatever an earlier attempt did, including a canvas created then and expired or removed since (`TEMPORARY_CANVAS_GONE`): it ends the action as failed, not applied and not retryable, in the kernel's own kind and words, and the proposal is declined in InferOps. Without the effects nothing is asked: `policy`, "needs your own approval". A confirm InferOps doesn't answer after the canvas exists is logged (`dot-confirm.canvas.confirm_unanswered`) and leaves the proposal to expire there; the canvas stays.
- **Personal workflow proposals (FAC-134 capability 2, inferops#2648).**
  - **A create** (`inferos_workflow_create`) is staged as `inferops.dot-workflow-create`. Its prose is fixed: the Dot's title appears only as the *Title* field's value, never in the gatekeeper's own sentences (r1 on #475). Its input becomes the kernel's `personalWorkflow` declaration (`dotPersonalWorkflow`: each step's `command` reference and input; one that isn't valid declares nothing, so its approval creates nothing). The kernel lists every step in its own field.
  - **Approving a create** calls `ApprovedEffects.createPersonalWorkflow()` (`applyDotWorkflowCreate`):
    - **created:** the proposal is confirmed in InferOps (no run named), and the action keeps `personalWorkflow: {id, reference, expiresAt}`, its reference built from the steps' InferOps company and workspace;
    - **refused:** not applied, in its FAC-119 kind; declined in InferOps only when the refusal stands (`refuseDotProposal`, r1 on #488);
    - **unknown:** a step's check went unanswered, nothing was created, and it's `UNAVAILABLE` to approve again.
  - **A run** of one, `inferos_workflow_invoke` with an `inferos/personal-workflow/…` reference, is staged as `inferops.dot-personal-workflow-run`, declaring `personalWorkflowRun: {reference, reportOutcome: true}` (never `workflowRun`). Approving it calls `runPersonalWorkflow()`, and the confirm names the run.
  - **Its outcome** is recorded only as `kind: "personal-workflow"` for such a proposal, and a trigger run's only as `workflow-run`. Anything else is logged and ignored.
  - **In the Dot,** `parseDotRun` reads both kinds and the step reasons (`step-refused`, `step-unknown`). A personal workflow whose run placed every request reads *Requests placed* / *Requests placed. Each waits for the console's builders.*, never done.
  - **Tests:** `dot.test.ts`, "deciding a personal workflow proposal", and the blueprint's `dot.test.ts`.
- **Delegate proposals (FAC-134 capability 3, ADR 0020, inferops#2653).**
  - **A delegate** (`inferos_delegate_launch`) is staged as `inferops.dot-delegate`.
    - **Its prose is fixed.** The Dot's title is only the *Title* field's value. Its prompt and note appear only in the *Arguments* field, never in the gatekeeper's own sentences (r1's LOW on inferops#2653).
    - **Its input becomes the kernel's `delegate` declaration** (`dotDelegate`: the title, prompt, connections and tools; never the note), with `reportOutcome: true`. One that isn't valid declares nothing, so its approval launches nothing. The kernel shows the ceiling and quotes the prompt in its own field.
  - **Approving it** calls `ApprovedEffects.launchDelegate()` (`applyDotDelegate`):
    - **launched:** the proposal is confirmed in InferOps naming the delegate's run (`{runId}`), and the action keeps `runId` and `delegate: {id}`;
    - **refused:** not applied, in its FAC-119 kind, retryable only for a refusal that can pass (permission, sign-in, unavailable). Only a refusal that stands declines it in InferOps (`refuseDotProposal`, r1 on #488): a retryable one stays pending there, so a later approval that does launch it can confirm it and name its run;
    - **unknown:** it may have launched, so it's uncertain (`UNAVAILABLE`), never declined.
  - **Its outcome** is recorded only as `kind: "delegate"` with `ranAs: "person"`, for a delegate proposal. No other proposal's outcome may claim the person (`recordDotRunOutcome`, and `parseDotRun` on InferOps' answer).
  - **In the Dot,** a delegate's proposal uses the run words (`RUN_TOOLS`): *Delegate finished* (with *Check what it changed in your operate session.*), *Delegate failed* or *Delegate uncertain*, each with *It ran as you, with at most what you approved.* and *Reported, not verified*. `requester-revoked` and `cancelled` have a delegate's own words.
  - **Tests:** `dot.test.ts`, "deciding a delegate proposal", and the blueprint's `dot.test.ts`.
- **A decision the Dot waits for (FAC-135, inferops PR 2's contract).** A Dot write proposal waits 7 days in InferOps, and its run resumes as the person (Calvin's decision: the person's own authority, waiting for reconnect or ending refused, never a system credential).
  - **Staged at the next session start, not in the background.** A turn watches its conversation from before it starts (`DotBinding.watch`, facet key `dot:watched`, ids only, at most 32; past that the oldest is never dropped silently: it is recorded in `dot:watchEvicted` and logged, "More than 32 conversations wait for a decision: the oldest is checked when you open it.", and a read of that conversation checks it and clears the record). Each session start on the Dot (`openDotSession`, when the Dot gadget next runs: its page, or a canvas or console tile holding it) lists each watched conversation's proposals with the person's own credential (`chatbot.proposal_list`) and stages every one still `proposed` through the same once-per-proposal staging a read uses. So a proposal a cut turn left (the browser closed mid-turn) reaches *Needs your approval* with no read of the conversation, once, however many sessions start. A conversation is no longer watched once nothing in it waits: no undecided, unexpired proposal, and no decision whose run hasn't ended. **It never delays the session** (r1 on #493): the session is returned at once and the sweep runs in the background (`ctx.waitUntil`) on its own hold of the approval queue, within one deadline for the whole sweep (`DOT_SWEEP_DEADLINE_MS`, 10 s). It stops at the first listing that doesn't answer in time, and at the first `UNAVAILABLE` or `DISABLED`, as at `UNAUTHORIZED`; the next session start tries again. A failure in it never fails the session. **Not built:** staging while InferOS is closed; that needs a kernel background hook (a manager follow-up).
  - **A dead sign-in.** The session start stops at the first `UNAUTHORIZED`, stages nothing, and records once that the Dot waits for the person to reconnect (facet key `dot:waitsForReconnect`, logged `dot.stage_left.waits_for_reconnect`), until a later start succeeds. An approval whose confirm meets a dead sign-in stays pending (kind `sign-in`, retryable) and is never declined, and the shown proposal says so (`DotProposal.waitsForReconnect`, from the action's `signInRefusedAt`; neither InferOps' status nor the kernel receipt, which reads `FORBIDDEN` for a sign-in too, tells it apart). After reconnect its retry confirms once, under the same key.
  - **What resumed.** Confirm and decline answer `{proposal, resumed}` (`DotDecisionWire`; an older InferOps answers `{proposal}`, read as nothing resumed). The action records `resumed` (the proposing run's own id, answered at once as `running` while the resume runs detached) and `runStatus` (InferOps' `Proposal.runStatus`). InferOps may answer only once the resume ends, often after the 15 s request timeout: a confirm whose answer is lost is uncertain and replayable (`DOT_CONFIRM`), never declined, and its retry under the same key gets InferOps' stored answer: with InferOps' background-resume flag on, a replay answers 200 with the proposal as stored (and `resumed` while the first resume runs), applied here only when that proposal was made (`assertMade`: confirmed or handed off; declined, failed or expired stands refused); with it off, a replay is 409 `PROPOSAL_DECIDED`, settled by reading the proposal back. A decision that leaves the run resuming or not yet resumed watches its conversation. Neither `resumed.status: running` nor `resumed: null` is final: it may resume when the conversation's busy run ends, so `runStatus` is refreshed from every `read()` and session start (`noteRunStatus`). After a refused confirm, InferOps resumes the run with the refusal; the proposal is read back and its `runStatus` (for example `refused`) kept on the failed action (`recordRefusedRun`). The session API shows it as `DotProposal.runStatus`, and `DotProposal.resumed` (true only once an answer to this proposal's own decision named the resumed run, never from `runStatus` alone, which ends `complete` whether or not this decision resumed it).
  - **Another company's connection** (`OTHER_COMPANY`) is final. The credential refuses it before sending, with a code that crosses RPC in its message; the account client restates it as unsent. So the confirm is not applied and not retried (kind `permission`), and the proposal is declined there, by `refuseDotProposal`'s rule for a refusal that stands.
  - **Field values only:** nothing InferOps wrote reaches the approval's prose.
  - **Tests:** `dot.test.ts`, "a decision the Dot waits for (FAC-135)"; `account.test.ts`, "the Dot's session start (FAC-135)" (the production entry, through a real bound connection: the shared connection and the demo refused before sending, the person's own account and token, and `OTHER_COMPANY` from the real credential, restated unsent, final, with nothing sent); `apply-outcomes.test.ts` (`OTHER_COMPANY`'s classification).
- **Background decisions on the Dot page (FAC-135, inferops#2657):** each proposal also reads its Dot run's `runStatus` (from InferOps' `Proposal.runStatus`). `shownProposal` keeps only a status the page knows, and `waitsForReconnect` and `resumed` only when exactly `true`. `decisionWords` gives the four states:
  - **waiting for your decision:** as before, with nothing more while the run waits (`awaiting_decision`);
  - **waiting for you to reconnect:** the gatekeeper sets the proposal's `waitsForReconnect` while its decision is pending because its last confirm met a dead sign-in. A proposal's status alone can't tell: its receipt maps a dead sign-in to `FORBIDDEN`. It reads *Waiting for you to reconnect InferOps*, and says nothing is made meanwhile. It waits for the person only, never anyone else (ADR 0011 U3);
  - **resumed:** only once decided **and** its own decision resumed the run (`DotProposal.resumed`, recorded by the gatekeeper from InferOps' answer; `runStatus` alone never says so, since with background resume off every run ends complete), a line saying what the run did after: *Your Dot picked up your decision and answered below.*, *…is answering after your decision.*, *…couldn't finish…* or *…was cut off*;
  - **ended refused:** *Ended: nothing was decided in time, so your Dot stopped waiting.*

  These are fixed words, never the run's own: those are in the conversation. Tests: the blueprint's `dot.test.ts`, "a background decision's words".
- **Receipts** (`dotProposalStatus`), in FAC-97's words from InferOps' own status, read when asked:

  | InferOps | Receipt |
  | --- | --- |
  | proposed | waiting |
  | confirming | running |
  | confirmed | succeeded, with the bounded summary below |
  | handed-off | succeeded: an InferOS workflow-run proposal, confirmed only after the run started here (FAC-120) |
  | failed | failed, with the receipt code for InferOps' refusal |
  | declined | rejected |
  | expired | failed, `EXPIRED` |
  | unknown (confirming past its bound) | unknown |

  A failure's reason is the receipt's fixed sentence, never InferOps' words. `EXPIRED` is a new FAC-97 receipt code (`action-outcome.ts`; InferOps' `PROPOSAL_EXPIRED` maps to it). A confirmed proposal's result is `summarizeDotOutcome`: at most 10 identifying scalars of InferOps' answer, at the top level or one object down (`id`, `identifier`, `key`, `revision`, `status`, `state`, `title`, `name`), each string at most 200 characters, plus the proposal id.
- **Errors.** Every refusal is a fixed sentence: a conversation that isn't the person's (`NOT_FOUND`), a selection they can't open (`NOT_FOUND`), `FORBIDDEN`, a running turn (`CONFLICT`), the Dot unavailable (`UNAVAILABLE`), an expired proposal (`EXPIRED`) and a decided one (`CONFLICT`). A 401 is adjudicated by the account as for every call. Logs carry the operation name and status only.
- **Observers.** Strategy A: `addObserver` always throws; a Dot is never shared. A use-role operator binds their own.
- **Configurator.** `dot-ui.tsx`, organization and workspace. It changes no authority.
- **Display (PR C).** The bundled `inferops.dot` gadget is the Dot's screen, through the existing `inferos.gadget` canvas kind. There is no new kernel widget kind, interface or permission.
  - **Its Durable Object** keeps one thing: the id of the conversation it is having. That's a reference, never a message (ADR 0013 decision 1). It reads the conversation back from InferOps whenever it is shown. A kept conversation that is gone, or isn't the person's, is forgotten; any other failure keeps it.
  - **Its calls:**
    - `open()`;
    - `ask(prompt, progress)`, which starts a conversation on the first question and relays the answer as it comes through an `RpcTarget` the client hands it;
    - `cancel()`;
    - `startOver()`, which forgets the id; InferOps keeps the conversation.
  - **What the client sees:** messages and each change's status only, never a receipt or a change's arguments, in the conversation read back and in each change relayed as it is proposed (`shownProgress`). Every value is drawn as a text node.
  - **Knowledge (FAC-136).**
    - **A knowledge read** (`knowledge_company_search`, `_list` or `_read`) is named while the Dot answers as *Reading your company's knowledge… Reading changes nothing.* The empty conversation says asking about the company's knowledge changes nothing.
    - **A knowledge write** (`knowledgeWrite`, from the proposal's arguments, read on the server) reaches the client as its target only: an edit's page link, and the new title if it renames the page; or a create's workspace link and the new page's title, at most 200 characters. Never its body. Only a canonical `inferops://` link is kept.
    - **How it is listed:** *A change to a wiki page* (with *Page:* and its link), or *A new wiki page: <title>* (with *In:* and the workspace's link). The link is text, not a link to follow. While waiting, it says what approving it does, in the card's words; once made, *Readers see it now.* It never says it publishes.
    - **An edit shows its page's link, not its title:** the proposal carries only the link, and its current title would need a read of the page. Its `ExportHandler` lists no formats. It keeps a print layout, as every bundled output format does: the transcript and its changes, without the composer, buttons or status line.
  - **No second decision card.** A change is never decided in the gadget. It lists each one in words:
    - waiting for your decision, pointing at *Needs your approval*, where every write is decided (FAC-119 U1's decision card covers Dot actions there);
    - being made;
    - made;
    - declined;
    - not made, with the receipt's reason;
    - expired;
    - uncertain: "may or may not have been made", never read as done or not done.
  - **Each refusal has its own words:**
    - no Dot connected;
    - refused: your access, or a shared connection, which has no Dot;
    - unavailable: the Dot can't run now, and a company with its own database lands here today;
    - still answering;
    - not found;
    - turned off;
    - an error.
  - **Controls:** Ask, Stop and Start over. A refused question is taken back, and its text is kept to ask again.
  - **Tests:** `blueprints/inferops-dot/__tests__` (`server.test.ts`, `dot.test.ts`, `client.test.ts`).
- **Not here.** A conversation list (no capability yet), conversation history beyond the newest 50 messages through `read({before})`, and a reconciling sweep of proposals stuck confirming (InferOps follow-up). The SSE fixtures are written in the tests to InferOps' encoder format, not generated from it.
- **Tests.** `__tests__/dot-relay.test.ts` (byte-level relay: order across split frames and heartbeats, CRLF, a tool call and proposal, the run's error, cut, malformed, oversized event, frame and run, silence, deadline; strict parsers) and `__tests__/dot.test.ts`. The latter drives the facet's own session, apply and reject over the real HTTP client against a scripted fake InferOps (`__tests__/worker.ts`, `dotBindingOver`). It covers the observation, text in order, the selection sent unchanged, proposals staged once with receipts and on reading, the run's error, a malformed event shown and the run stopped, a cut, refusals in fixed words, input checks, the keyed confirm and its bounded result, `EXPIRED`, a decided proposal settled to its real status, decline, a decline InferOps didn't answer kept pending, one refused because the change was made, one refused as expired, a decided record InferOps still shows waiting staged again, no collaborator admitted, and the status mapping.

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

### InferOps account

`inferops://<tenant>/account` (ADR 0015, `docs/adr/0015-inferops-account-connection.md`, proposed in [inferos#308](https://github.com/factory-level/inferos/pull/308);
design "InferOps account" in the linked specification) is one binding per person and organization.
`InferOpsAccount.getGatekeeperClassFor` parses it (`parseAccountUrl`: one tenant slug, or exactly
`demo.local`) and mints an `InferOpsAccountGatekeeper` whose props are the account and the tenant
label only. A tenant other than the demo needs a connected person and a configured API; the stopgap
connection is refused. The resource is offered while InferOps is on and is `excludeFromOperateChat`,
so Operate and host boards keep exact board bindings.

- **Opening.** `openBoard(ref)` and `openWiki(ref)` are the only methods in the package that take a
  reference. Each parses it with its own kind's parser (`parseProjectBoardUrl`, `parseWikiUrl`), so a
  dispatch, workflow, table, members, page or account reference is refused; requires its host to
  belong to the binding's tenant (`hostInTenant`: the demo host only to the demo account); resolves
  the workspace slug among the person's own workspaces of the right product
  (`InferOpsCredentials.resolveWorkspace`, `inferops` for a board, `infermind` for a Wiki), and
  confirms the project (`hasProject`) or the Wiki (`listDocuments`) with the person's own token.
  Every refusal, including InferOps' NOT_FOUND or FORBIDDEN, is NOT_FOUND with one message per kind
  ("No such InferOps board is available to this connection.", and the same for a Wiki). Opening is
  not an observation. The result is the board facet's `ProjectSessionImpl` or the Wiki facet's
  `WikiSessionImpl` over a binding built from the resolved target, holding its own duplicate of the
  approval queue, so it outlives the account session.
- **Actions.** Each resolved target has its own `ScopedActionStore` (`scope:<key>/action:<id>`, key
  `board:<host>:<workspaceId>:<KEY>` or `wiki:<host>:<workspaceId>`), and `actionScope:<id>` indexes
  each action id to its store, so one board's pending moves never show on another and the
  overseer's `applyAction`, `rejectAction` and `revertAction`, which name the id only, reach the
  right board or Wiki. The id counter and `instanceId` stay facet-wide, so action ids and
  `<instance>:<action>` idempotency keys are unique across the binding. Each record carries its
  resolved `scope` (`kind`, `host`, `workspaceId`, `projectKey`), and its fingerprint is computed
  over that scope instead of the facet's fixed project key or `knowledge/wiki` (`fingerprintOf`;
  the board and Wiki facets' fingerprints are unchanged). Apply runs the board or Wiki facet's own
  apply (`applyBoardAction`, `applyWikiAction`) after the fingerprint and then resolves the workspace
  again: a person who no longer holds it, or a slug that now names another workspace, refuses the
  action unsent and for good. Reverting an applied action makes the same check first and writes
  nothing when it fails. Every approval names its target first ("Target: Board GROK on
  grokbot.operations", or "Wiki of …").
- **Collaborators (strategy C).** gatekeeper-kit's `ObserverTracker` keeps the binding's
  collaborators (with their verifiers) and one data set per board and per Wiki read, keyed as the
  stores are. A collaborator is admitted against every set read so far (`hasProjectAccess`,
  `hasWikiAccess` on their own verifier); the first read of a new set checks every stored
  collaborator again and excludes those who fail. `listWorkspaces`, `findBoards` (on the account and
  on a board it opened) and `readDocumentText` on a Wiki it opened reveal more than any set, so they
  go through the tracker's withhold fence (`prepareWithheld`): every current collaborator is
  excluded, and once such a read is recorded the binding is owner-only for good, refusing every
  later collaborator whatever they can open. Until then admission follows the per-set rule above.
  A Wiki proposal approval is refused while the binding has any collaborator, as on the facets.
- **Administration.** Disabling the board or Wiki kind in the admin settings does not reach an
  account binding already made, since that policy is checked when a binding is minted; disabling
  the account kind is the switch for it.

The board, dispatch and Wiki facets build the same bindings from their props: `ProjectBinding` and
`WikiBinding` take their target and their parts (store, client, observers, an optional observation
hook) as arguments, and apply, reject and revert are functions over a binding.

### Accounts keyed on the principal

FAC-165, [ADR 0019](../adr/0019-account-keyed-on-stable-subject.md) (proposed). The vendor declares
`providesSubject`, and every account answers `getAuthenticatedSubject()`: the principal its sign-in
or connect recorded, else, for an account connected before that, the `userId` its stored identity
holds. The Workshop (`account-subject.ts`, `auth/login-flow.ts`) keys the person's account on it:

- **The subject index.** The user directory records which account each subject signs in to
  (`subjects`, written once per subject) and the account each vouched address currently belongs to
  (`emails`). A new person gets an account named `subject~<issuer>~<subject>` (no `@` or `:`).
- **Binding an existing account.** A first subject sign-in with a vouched email binds the account
  that address names, exactly as the provider gives it (an email-keyed account was named by it
  unchanged; only the `emails` index folds case) (`UserDurableObject.bindSubject`, set-if-unset):
  never a password account, never one another subject holds. Without a vouched email, the person
  gets their own account.
- **Claimed in one step, then bound.** The directory's subject mapping is itself the claim: one
  set-if-unset step (`claimSubject`) records the first sign-in's candidate and returns whichever
  account won, with no read before it, and the mapping is never removed. Every sign-in for that
  subject then binds the winner (set-if-unset, the same answer for each), never its own candidate;
  a winner that can't bind is moved, compare-and-set, to the subject's own name (`moveSubject`). So
  overlapping first sign-ins with different addresses bind one account and all sign in to it, and a
  sign-in that stopped between claiming and binding is settled by the next one. The one-off pass
  claims the same way.
- **A bound account signs in only through its subject.** Gatekeeper email sign-in and Cloudflare
  Access refuse it (`SIGNS_IN_THROUGH_SUBJECT`), so an address that later belongs to someone else
  reaches nothing. Profile ids, session tokens and every stored reference keep the account's name.
- **Finding a person by address** (`collaboratorAccountName`, used by `addCollaborator`) resolves the
  account whose current vouched address it is, and never a bound account by its old address. A share
  stores the account, so it never follows an address.
- **The one-off pass** `AdminApi.bindAccountSubjects()` binds each listed email-keyed account whose
  own InferOps connection vouches its address, unless the directory already sends that subject to
  another account (a conflict, left unbound, so nothing is stranded). It creates no account, and a
  second run binds nothing new. Accounts the directory doesn't list yet bind at their next sign-in.
- **Running the pass.** A deployment admin runs it from the Admin page's Access tab
  (`AccountSubjectPassCard`, over the same `AdminApi.bindAccountSubjects()`; nothing else calls
  it). Binding can't be undone there, so it takes a second, explicit step: *Bind accounts…* says
  what binding does, and only *Bind accounts* runs it; *Cancel* runs nothing. While it runs the
  button is disabled. It then shows the pass's counts only (checked, bound, already bound, and how
  many were left unbound), never an account, with its own words for nothing to bind and for no
  account holding a vouching connection. A failure shows the server's message and the pass can be
  run again. Tests: `AccountSubjectPassCard.test.tsx`.
- **Admins** (`ADMINS`) are still matched by account name: a bound account keeps its address as its
  name; a new person's account name is its subject form.
- **Tests:** `account-subject.test.ts` (the email change, a second person on the old address, the
  binding rules, finding by address, the pass and its conflict, two first sign-ins at once, one
  acting on an answer from before another finished, a sign-in that stopped before binding, an
  address with capitals, an address that names an account only later, and a pass whose claimed
  account another subject took meanwhile) and the gatekeeper's
  `inferlab-login.test.ts` and `account.test.ts`. `account-subject.test.ts` runs in its own vitest
  project, `backend-sign-in`, whose Miniflare alone has the empty `BLUEPRINTS` namespace the real
  sign-in reads its admin config from, so no other backend file runs with it.

### Sign-in proxy

A browser that InferLab's IP-allowlisting edge refuses cannot open central-auth's `/authorize` page either, since that is a browser leg and carries no edge header. With `INFERLAB_AUTHORIZE_ORIGIN` set (a hostname routed to this gatekeeper, behind the deployment's Access application), `src/auth-proxy.ts` serves it:

- `inferLabAuthorizeOrigin(env)` is where the popup's `/authorize` redirect goes: the authorize origin when set and valid, the InferLab origin when unset, and null (sign-in off) when set but malformed. The code exchange, refresh, logout and `/workspaces` read still go to `INFERLAB_AUTH_ORIGIN` / `INFEROPS_BASE_URL` directly.
- `handleInferLabLogin` (the gatekeeper's HTTP entry) tries `handleInferLabAuthProxy` first. It answers only requests whose origin is the authorize origin, and only `GET /authorize`, `POST /authorize/persona`, `GET /logout`, `POST /auth/oauth/sign-in/social` and `GET /auth/oauth/callback/google`; any other path or method there is a 404 without calling InferLab, because the InferLab origin also serves the API.
- Upstream requests go through `inferLabFetch` (edge header, `redirect: "manual"`) with only `accept`, `accept-language`, `content-type`, `cookie` (minus Access's `CF_Authorization`), `origin`, `referer` and `user-agent`. An `Origin`/`Referer` naming the authorize origin is rewritten to the InferLab origin, which central-auth's same-origin check on the persona form accepts as its public origin; any other value passes unchanged and is refused there.
- In the response, a `Location` on the InferLab origin is rewritten to the authorize origin (the `/oauth` callback is the deployment's own and passes through), and `Set-Cookie` loses any `Domain`, so central-auth's host-only cookies (CSRF, SSO) stay on the authorize host.
- **Choose again every time.** A live central-auth session in the browser makes `/authorize` answer at once as whoever signed in last. Signing out of InferOS does not end it: that drops only the Workshop token, and the gatekeeper only ever signs out the child session it was handed. So `/authorize` always carries `prompt=select_account`, with or without the proxy, and InferLab shows the sign-in page even with that session live (factory-level/inferops#2528), on every sign-in, connect and reconnect. The session stays live for InferLab's own apps and for connected accounts: opening `/logout` instead would end it with every child session under it, including the session of an InferOps account already connected through it. Through the proxy that session lives on the authorize host, because the proxy strips `Domain` from central-auth's cookies. Against an InferLab without #2528 the prompt is refused with a 400.
- **Google through the proxy.** Every forwarded request carries `x-inferos-authorize-origin: <authorize origin>`, set by the proxy, never taken from the browser. InferLab answers its Google edge on that origin when the origin is listed in its `auth.sso.proxyOrigins` (factory-level/inferops#2528; dev lists `https://auth.dev-os.factorylevel.dev`), so Google's redirect URI is `<authorize origin>/auth/oauth/callback/google`, which must also be registered on InferLab's Google client. The callback returns to the relative `/authorize?…` on this host, and the sign-in finishes as a persona one does. Against an InferLab without that change, or an origin it does not list, Google returns to InferLab's own hostname, which the edge refuses for most browsers. InferLab creates no account on a first Google sign-in, so the Google account must already be an InferLab user.
- `__tests__/auth-proxy.test.ts` covers the origin and path allowlist (including the two Google legs and the other edge paths staying a 404), the edge and authorize-origin headers (a browser-sent authorize-origin header is replaced), header filtering, the cookie, Origin, Referer, Location and Set-Cookie rewrites, a relative `/logout` redirect staying on the authorize host, and a foreign `Origin` passing unchanged; `inferlab-login.test.ts` covers `prompt=select_account` with and without the proxy, and the popup going to the authorize origin's `/authorize` while the code is exchanged at the InferLab origin, and a malformed authorize origin turning sign-in off.
## Divergences from Design

- **Widget index writes skip the approval queue** ([ADR 0016](../adr/0016-console-widget-index-writes.md),
  proposed). The design has every gatekeeper write staged, approved and applied. A console
  publication's `widget.publish` and `widget.withdraw` are written directly, as the publishing
  person, from the build-role publication only: the person publishing is the person who would
  approve. No gadget, agent, use-role or operate session reaches them; InferOps still decides
  against the person's own grant, and InferOS reports what it answered. A companion `docs/human`
  proposal asks for the design to name this exception.

- The account session's `findBoards` returns the package's existing `BoardCandidate` (`tenant`,
  `workspace`, `projectKey`, `boardRef`, `title`, `reasons`), which the board session's `findBoards`
  already returns, not the design's `{ ref, key, name, workspace }`: the agent types are one
  self-contained file and cannot hold two types of that name.
- For the demo account, `listWorkspaces` returns the demo's one workspace twice, once per product,
  since the demo serves both a board and a Wiki on `demo.local`.

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

### Against the 2026-11-02 product design

Recorded on 2026-11-02 against `364deb91c`; the design is InferOps [`docs/human/architecture/agent-operations.md`](https://github.com/factory-level/inferops/tree/develop/docs/human/architecture/agent-operations.md).

- Every call carries the person's own authority (ADR 0004); the assigned system-workflow authority context does not exist (I08).
- Reads and proposals return acceptance and approval outcomes; there is no run-progress or completion callback contract for delegates (I07, I09).
- Agents are not configured by a Company Admin from gatekeeper capability bundles; connections are bound per person and per gadget.

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
  parse. The alias `…/knowledge/page/<uuid>` parses only with a lowercase UUID and nothing after it.
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

Wiki proposal approval against a local InferOps (MVP-40, opt-in, not CI): `packages/integration-tests/__tests__/inferops-wiki-proposals-live.test.ts`, skipped without `INFEROPS_WIKI_LIVE_BASE_URL`. It runs against inferops' test-only in-process harness (`apps/_shared-api/tests/wiki-proposal-proof-server.ts`: the composed app on 127.0.0.1 over a disposable database, Wiki publishing on, no worker, no secret layer) with two proposals stored by its test-only `domains/knowledge/tests/wiki-proposal-proof-seed.ts`. Over per-person connections (the InferLab legs a fixture, as in members-live), it covers: the owner's reads equal InferOps' `proposal.get`; staging sends nothing; an explicit approval applies as the owner, approved at the hash and never published; re-approval answers as the first, sending nothing (FAC-118), and InferOps replays a same-hash resend; the member is refused FORBIDDEN and stays pending; the owner's own request is refused for good. The single publish job is counted by the seed's `verify` step. Step B (`INFEROPS_WIKI_LIVE_PUBLISH`, one phase per run): once inferops' test-only `apps/_shared-worker/tests/wiki-publish-consumer.ts` runs the real `knowledge.wiki.publish` job from the queued envelope, `published` reads P1 published into its filed target at expectedVersion + 1, keeping the page's id, slug, parent and pillar membership, with P1's title and content and no Master role, and P2 still unpublished. After one redelivery of the exact completed envelope, `redelivered` reads P1 and its page unchanged, and a same-hash approval replays. Job states, sibling order and provenance are read by the seed's `verify`. The shared-gadget, stopgap, uncertain-dispatch and no-replay cases stay covered against the mock (below).

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


## Company service dashboard (FAC-172)

The `inferops.service-jobs`, `inferops.service-job-status-counts`, and `inferops.service-job-recent-activities` blueprints share `libraries/service-dashboard` and compose as three separate `inferos.gadget` instances on an ordinary saved canvas. The combined `inferops.service-dashboard` blueprint also offers all three panels over one
project connection: `service-jobs`, `service-job-status-counts`, and
`service-job-recent-activities`. `InferOpsProjectSession.readServiceQuery` accepts only those names,
a bounded limit and an opaque cursor. The HTTP adapter supplies `queryVersion=1` and resolves the
bound project's ID itself; caller-supplied scope is refused. Response fields are projected and a
job outside the project is refused. A project connection latches owner-only before attempting a joined read, so even a later or concurrently admitted collaborator cannot inherit joined data; account connections use their existing withheld-observation tracker. Each read reuses the existing current-credential request
path and is an observation withheld from board-only collaborators, because their board grant
cannot authorize joined company data. The mock refuses these reads; it supplies no fake proof.

The dashboard stores no records. Failed/denied/missing connections remain distinct from empty
results, pages expose the next cursor, and stale client responses cannot replace newer reads.
Its comment form narrows to the selected issue and calls `InferOpsIssueSession.comment` with the
exact `headSeq` read by the query. The existing action store fingerprints the body and expected
head, queues the action, and sends `X-Idempotency-Key` plus `expectedIssueHeadSeq` only on apply.
The API rechecks authorization and the head. An uncertain response uses the existing replayable
write policy; no exactly-once claim is made. Comments are not revertible here and are not shown
as recorded activity before approval. The blueprint disables export.

This code requires the FAC-172 InferOps provider implementation; the repository-wide provider
pin continues to describe the existing stable board contract until the coordinated provider
merge. Tests use synthetic responses. Live browser, provider load and restore evidence are
separate gates and are not implied by the unit tests.


These widgets run as isolated DOM blueprint clients, like the existing members and workflow-policy blueprints, rather than in Workshop React. They use native controls and CSS system colors (`Canvas`, `CanvasText`, `ButtonBorder`, `GrayText`) to inherit the browser accessibility palette without a feature-local color system.

The local proof installer is `packages/workshop-backend/scripts/company-data-dashboard-proof.ts`.
Given a localhost Workshop URL and the synthetic company's board reference, it installs the
three separate blueprints into one new workspace and creates a saved canvas with three
`inferos.gadget` references. Its report contains only IDs, success states and row counts; the
local browser session is stored in a restricted `/tmp` file. It must run against the live
company fixture; there is no mock fallback. The proof uses a local catalog enabling
`inferos.gadget` and those three blueprints, without changing any deployed catalog.
