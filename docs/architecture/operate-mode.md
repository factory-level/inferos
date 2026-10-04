---
title: Operate mode
covers:
  - packages/workshop-shared/src/operate-session.ts
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/user.ts
  - packages/workshop-backend/src/server.ts
  - packages/workshop-shared/src/operate-flow.ts
  - packages/workshop-backend/src/flow-store.ts
  - packages/workshop-shared/src/operate-console.ts
  - packages/workshop-backend/src/console-store.ts
  - packages/workshop-backend/scripts/dev-setup.ts
  - packages/workshop-backend/src/overseer.ts
  - packages/workshop-backend/src/agent.ts
updated: 2026-10-03
---

# Operate mode

## Overview

The operate session is implemented in the kernel: one per person, holding a page state that is the replay of an ordered event log, plus an owner-only workspace for its operate chat. Clients reach it through `AuthenticatedApi.getOperateSession()`. The session workspace is operate-only, enforced in its Overseer: its capability denies every authoring method, and its chats' agents get a tool set with no authoring tools plus `operatePage`, which changes the page as the agent.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/operate-session.ts` | The page state machine: `OperatePageState`, `OperateEvent`, `OperateRef`, and the pure `applyOperateEvent` / `replayOperateEvents`. Shared so the kernel, clients and the operate agent derive the same page from the same log. |
| `packages/workshop-shared/src/api.ts` | The `OperateSession` capability, `AuthenticatedApi.getOperateSession()`, `OperateSessionUpdate`, and the coded `OPERATE_SESSION_ERROR_CODES` (`conflict`, `invalidEvent`, `consoleChanged`, `boardUnavailable`). |
| `packages/workshop-backend/src/user.ts` | Session state in the user Durable Object: the `operateEvents` log, the `operatePage` snapshot, and `operateSessionWorkspaceId`. `dispatchOperateEvent`, `subscribeOperateSession`, `listOperateEvents`, `claimOperateSessionWorkspace`. |
| `packages/workshop-shared/src/operate-flow.ts` | An authored flow (`OperateFlow`: title and ordered canvas ids) and `parseOperateFlowContent`, which checks its limits. |
| `packages/workshop-backend/src/flow-store.ts` | `WorkspaceFlowStore`: a workspace's flows in its Overseer, behind `Overseer.listFlows` / `createFlow` / `replaceFlow` / `deleteFlow`. |
| `packages/workshop-shared/src/operate-console.ts` | An authored console (`OperateConsole`: title, a view menu of `rollup` and `screen` views over canvas ids, a `fullChat` setting and optional `customization` flags), `parseOperateConsoleContent`, which checks its limits, `consoleScreens`, and `consoleEventMismatch`, which checks a console navigation event against a console's current definition. |
| `packages/workshop-backend/src/console-store.ts` | `WorkspaceConsoleStore`: a workspace's consoles in its Overseer, behind `Overseer.listConsoles` / `createConsole` / `replaceConsole` / `deleteConsole`. |
| `packages/workshop-backend/scripts/dev-setup.ts` | `pnpm dev:setup --console` seeds Operate test data: a connection to the mock demo board, Board and Activity screens over it, and an "Operations lead" console. |
| `packages/workshop-backend/src/server.ts` | `OperateSessionImpl` (`@validateRpc`), which forwards to the user DO with a fresh stub per call, opens the session workspace as an operate session, and checks console navigation events against the console's current definition before dispatching them. |
| `packages/workshop-backend/src/overseer.ts` | The `operateSession` mark in the workspace's storage, set by `open()` when the session opens it; `OperateOverseerInterface`, the operate-only capability every open of a marked workspace returns; and the agent hooks `isOperateSession` and `operatePage`. |
| `packages/workshop-backend/src/agent.ts` | `OPERATE_AGENT_TOOLS`, the operate chat's tool allowlist; the `operatePage` tool; and the operate note leading the chat's system prompt. |

## Data and Control Flow

The session lives in the user Durable Object, which already exists once per person and is owner-only. Every session method there runs synchronously against storage, so concurrent calls from several tabs and the operate agent are serialized and never interleave.

`dispatch(event, expectedSeq)` compares `expectedSeq` with the stored sequence number and rejects with `conflict` if another change landed first. It then applies the event with `applyOperateEvent`, rejecting with `invalidEvent` (an `OperateEventError`) when the event doesn't fit the current page. Only then does it append the log entry (`seq`, `event`, `actor`, `at`) and store the new snapshot together with that entry. Either both are written or neither is. Client dispatches are recorded with the actor `person`.

Before a person's `openConsole`, `openView` or `showScreen` (with a screen) reaches the user DO, `OperateSessionImpl` checks it against the console's current definition, because the reducer is pure and only knows what `openConsole` copied in. It opens the console's workspace with the caller's own role (build, or the use role's read-only `listConsoles`), finds the console (the one being opened, or the page's open one), and applies `consoleEventMismatch`: `openConsole` must name one of its views and its current `fullChat`, `openView` one of its views, and `showScreen` a screen of the view the page shows. A missing console, an unreadable workspace (no access, deleted, views disabled) or a mismatch rejects with `consoleChanged`, and nothing is appended. A concurrent change between the page read and the dispatch is caught by `expectedSeq`. The operate agent's `operatePage` cannot send these events, so its path skips the check.

`subscribe()` sends the current snapshot and subscribes to the stored snapshot with no await in between, so no event can fall in the gap. Every later update carries the log entry that produced it. Every connection a person holds subscribes to the same storage, which is what keeps their tabs and devices live on one session.

`getWorkspace()` claims a fresh Overseer id in the user DO (synchronously, so two first calls agree on one id) and registers it like `newGadget()` does, titled "Operate session". `listGadgets()` skips it. If the recorded workspace has been deleted, the next call claims a new one. The session opens it with `open(..., asOperateSession)`, which records `operateSession` in the workspace's own storage. The mark is never cleared, and every later open checks it, including the owner's `openGadget()` by id: a marked workspace is refused to anyone but its owner, before any share key is redeemed, and the owner gets `OperateOverseerInterface`.

`OperateOverseerInterface` wraps the owner's `OverseerClientInterface` and forwards only what the operate chat needs: metadata, presence, workpiece and console subscriptions; the chat methods (`newChat`, `sendChatMessage`, history, attachments, titles, `stopAgent`, `retryAgent`, `deleteChat`); the action log, `approveAction` / `rejectAction` and auto-approval rules; connection requests and `newGatekeeper` / `getGatekeeperById` / `getGatekeeperByResourceUrl`; and `listCanvases` / `getCanvas` / `listFlows` / `listConsoles`. Everything else rejects with "Unauthorized": gadgets (`createGadget`, `getGadget`), code (`submitCodeChange`, commit reads, merges and draft changes), canvas, flow and console edits, hooks, blueprints, AI-model and agent-spawner gatekeepers, sharing, and the workspace's title, kind, pin and deletion. Like `UseOverseerInterface` it `implements Overseer`, so a new Overseer method does not compile there until it is classified.

The agent loop reads the same mark (`AgentHooks.isOperateSession()`), never anything the client sends, so every chat in the workspace is an operate chat however its turn started. Its tools are the `OPERATE_AGENT_TOOLS` allowlist: `readFile`, `grep`, `webFetch`, `observeUserChanges`, `describeBinding`, `executeCode`, `listCanvases`, `listConnectableResources`, `requestConnection` and `operatePage`. `writeFile`, `editFile`, `createGadget`, `createWorktree`, `setGadgetBinding`, `editCanvas` and `listBlueprints` are not offered, so a call to one fails as an unknown tool. `executeCode` still reaches connected resources through their gatekeepers, so a domain write queues for approval exactly as in Build. A short operate note leads the project-specific half of the system prompt. Other workspaces' chats never get `operatePage`.

`operatePage` reads the page or applies one event to it: `open`, `focus` or `close` a screen or workspace reference, `goToStep` or `exitFlow` in the running flow, `setSubject`, `showHome`, or `openBoard` / `closeBoard`. It returns the resulting page state as JSON. The Overseer forwards it to the owner's user DO (`dispatchOperateEvent(event, null, "agent")` or `getOperatePage()`), so the event goes through the same reducer and serialized log as a person's and is recorded with the actor `agent`. A null `expectedSeq` applies it to whatever page is current, since the agent acts on the latest page rather than one it watched.

A session can run a **flow**: `startFlow` copies an ordered list of one workspace's screen ids into the page state (`flow`), `goToStep` moves the index within it, and `exitFlow` clears it. While `flow` is set the page is meant to show only that step (the full-canvas state); the working set and focus are untouched, so they return on exit. Because the steps are copied in, the reducer validates a step from the event alone and a run is unaffected by later edits to the flow it started from.

Flows are authored per workspace and stored in its Overseer (`flows` collection), next to the canvases whose ids are a flow's steps. The flow methods need build access and both view flags, exactly like the canvas methods, and the use-role capability denies them. A flow is saved only over canvases that exist in that workspace, in the author's order; a step may repeat. Replacing or deleting compares the revision and rejects a stale one with the canvas conflict error. The store never touches a session: a client reads a flow and dispatches `startFlow` with its steps, so the kernel does not check that a run's steps match a stored flow, and a step whose canvas was deleted later is for the client to show as unavailable.

A session can have a **console** open. `openConsole` copies the console's workspace, id, title, `fullChat` setting and a starting view id into the page state (`console`), so later events are checked from the event alone, like a flow's steps. `openView` shows another view and `showScreen` opens a screen from it (`null` returns to the view), and `closeConsole` closes the console. `showHome` returns to the mosaic, clearing focus and any running flow as well as the console and setting `presentation` back to `canvas`, while keeping the working set, subject and approval state; the operate agent may send it. The page's `presentation` is `canvas` or `chat`. `openConsole` sets it to `chat` when the console's `fullChat` is `default` or `only`, and `setPresentation` is rejected when the console's setting is `off` (no full chat) or `only` (no canvas). The reducer does not check view or screen ids against the stored console; the session capability does, before dispatching (above). A view or screen that stops resolving after it was opened, because the console was edited later, is for the client to show as unavailable.

Consoles are authored per workspace and stored in its Overseer (`consoles` collection), beside the canvases their views reference, under the same rules as flows for writes: build access and both view flags, at most 16 per workspace, each view's screens must exist in that workspace, and replace and delete compare the revision. A console holds references, order and settings only, and opening one grants nothing. Reading is wider than for flows: `listConsoles` is also allowed to the use role (`UseOverseerInterface`) and to the operate session capability, so an operator granted use on the workspace reaches their console without Build; create, replace and delete stay build-only.

A console may also carry `customization`: four independent booleans for personal shareable screens, custom widgets, application tools and custom skills. The parser requires every flag to be a boolean and keeps a definition with no field as it is; clients treat absence as all disabled (`DEFAULT_CONSOLE_CUSTOMIZATION`). They are opt-in policy settings, not capability grants, and are changed only through the build-only console writes with their revision check. Creating and sharing personal extensions is separate work, and the flags do not enable authoring in the operate-only session workspace.

A session can show an **approval** under review. `reviewApproval` names one pending action as `{workspaceId, actionId}` (the workspace's `ActionLogEntry.id`, a non-negative integer, since action ids count up per workspace) and sets `reviewing`, replacing any approval already under review. `approvalResolved` records `{workspaceId, actionId, outcome}` (`applied`, `rejected` or `failed`) as `lastApprovalOutcome` and clears `reviewing` only if it names the same approval. Both events change presentation only: they never approve, reject or apply anything. An action is resolved only through its workspace's `approveAction` / `rejectAction`, the gatekeeper's apply result is the truth `approvalResolved` reports, and the reducer does not check either event against the action log.

A stored snapshot may predate a page-state field. The user DO fills missing fields from `INITIAL_OPERATE_PAGE` whenever it reads the snapshot, so such a session reads as if it always had the field (a session stored before approvals reads `reviewing` and `lastApprovalOutcome` as null).

A session can show a **board** (#61): `openBoard` names `{workspaceId, boardRef}`, the board's canonical reference and the workspace whose connection reads it, and `closeBoard` stops showing it. Opening a console, another view or screen, closing the console or going home closes the board too, so a board never outlives the context it was opened in. The reducer checks only lengths. Before a person's `openBoard` reaches the user DO, `OperateSessionImpl` opens the named workspace with the caller's own access and requires `getGatekeeperByResourceUrl(boardRef)` to find a connection there; otherwise it rejects with `boardUnavailable` and appends nothing. A use-role operator is denied that lookup on a console workspace, so their boards name their own session workspace, where a connection exists only if they made it from their own account. The operate agent's `openBoard` (`operatePage` with a `boardRef`) is rewritten by the Overseer to name the session workspace itself and refused, as an agent-readable tool error, unless one of that workspace's connections reports exactly that reference; the agent is told to ask the person to connect it rather than open another board. So a stale, unconnected or removed target is refused explicitly and never replaced by a default; a board whose project was since deleted or whose access was revoked opens as a reference and fails on its first read, which the board surface shows as such.

The operate prompt tells the agent to discover boards with the InferOps board session's `findBoards(query)` through `executeCode`, to show the candidates and ask when more than one fits, and to open only the candidate the person chose by its exact `boardRef`. `findBoards` itself is the gatekeeper's (see [InferOps gatekeeper](inferops-gatekeeper.md)). `integration-tests/__tests__/operate-board-discovery.test.ts` covers paraphrased and empty searches over the person's own projects, opening a connected board, refusing a found but unconnected one and then opening it once connected, refusing a console owner's connection to a use-role operator and to a stranger, and a revoked or signed-out person's search failing; `operate-chat.test.ts` covers the agent's refused `openBoard`.

References in the page state (`screen`, `workspace`, a board, and a flow's workspace and steps) identify targets only. The session never opens them and grants no access.

## Configuration

None. Limits are constants in `operate-session.ts`: references and screen ids up to 128 characters, a subject up to 512, at most 24 references in the working set (opening one more drops the oldest), and 1 to 32 steps in a flow run with a title up to 120 characters. The page holds at most one approval under review and one last outcome. One `listEvents()` page returns at most 200 entries.

## Divergences from Design

Against [the design](../design/operate-mode.md):

- A console is stored in, and references screens of, one workspace; there is no operate space yet. It has no state machine (`consoleEvent`, `navigateBack`), no app or widget assignments, no role assignment, and no derived inventory. Operators with only the use role can list a workspace's consoles, but not its canvases, flows or connected boards, so a use-role console's screens and boards do not render yet. The operate agent's `operatePage` offers `showHome` but not the other console events.
- Full chat is a page presentation only: the conversation does not yet render widgets inline.
- A flow is a single ordered list of one workspace's screens. Views that lay out several screens at once, steps from other workspaces, and steps that must be completed before moving on are not implemented.
- Views, subject-bound views and handover events are not implemented. The page state covers the working set, focus, subject, chat panel, app presentation, a running flow, the approval under review and the last reported approval outcome.
- The session page dispatches `reviewApproval` and `approvalResolved` (see the approvals on the [operate session page](inferops-canvas.md#operate-session-page)) and reports only the outcome it read back from the workspace's action log, but the kernel does not check a reported outcome against the log. The page covers the session workspace and the focused screen's workspace only. Workflow runs started by a schedule, their approval waits and a generic workflow-run view are not shown in the session (post-release).
- The URL mirror and presence are not implemented. The agent can open, focus and close references, step or exit a running flow and set the subject, but cannot start a flow, and it learns the page only by calling `operatePage` rather than from its prompt.
- A session workspace claimed before the `operateSession` mark existed is marked on its next `getWorkspace()`. Until then an `openGadget()` by id returns the full owner capability.
- The event log is kept in full, with no compaction or retention policy.
- Role consoles are partial: there is a console definition and the `openConsole` / `openView` / `showScreen` / `closeConsole` / `showHome` events and a shown board (`openBoard` / `closeBoard`), but no general console state machine (`consoleEvent`, `navigateBack`) and no issue continuity in the page state.
- The kernel does not re-read the provider when a board is opened: it checks that a connection the sender can reach holds exactly that reference, and the board's first read is what reveals a deleted project or revoked access. The chat surface for Wiki exclusion (#61) is not changed here.
- Build is not gated by role. Any signed-in user can author, and the Build | Operate toggle depends only on the `operate-mode` flag and composable views.
- Kind controls stop at authoring. Today the kernel enforces only the explicit `setKind()` (denied to `use`), the builder contract and starter files, and the workflow `client.js` refusal in the agent's file tools. That refusal is skipped in worktrees. A blueprint does not record the kind, so an install reads as `app` (`integration-tests/__tests__/operate-published.test.ts` records this as a known gap). `checkWorkspaceKind` runs only in tests, not at publish. Placing an `inferos.gadget` does not require a widget-kind gadget, and there is no per-console operate catalog.
- There is no derived console inventory and no admin or observability view of which apps and widgets each console uses.
- Build still offers the bundled `inferops.kanban` blueprint as a creatable output, and it does not yet offer Widgets or Agent workflows as outputs.

## Open Questions

- Retention of the event log for audit versus storage growth.
