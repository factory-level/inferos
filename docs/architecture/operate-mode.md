---
title: Operate mode
covers:
  - packages/workshop-shared/src/operate-session.ts
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/user.ts
  - packages/workshop-backend/src/server.ts
  - packages/workshop-shared/src/operate-flow.ts
  - packages/workshop-backend/src/flow-store.ts
updated: 2026-10-02
---

# Operate mode

## Overview

The operate session is implemented in the kernel: one per person, holding a page state that is the replay of an ordered event log, plus an owner-only workspace for its operate chat. Clients reach it through `AuthenticatedApi.getOperateSession()`. The operate chat has no operate-only tool set yet.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/operate-session.ts` | The page state machine: `OperatePageState`, `OperateEvent`, `OperateRef`, and the pure `applyOperateEvent` / `replayOperateEvents`. Shared so the kernel, clients and (later) the agent derive the same page from the same log. |
| `packages/workshop-shared/src/api.ts` | The `OperateSession` capability, `AuthenticatedApi.getOperateSession()`, `OperateSessionUpdate`, and the coded `OPERATE_SESSION_ERROR_CODES` (`conflict`, `invalidEvent`). |
| `packages/workshop-backend/src/user.ts` | Session state in the user Durable Object: the `operateEvents` log, the `operatePage` snapshot, and `operateSessionWorkspaceId`. `dispatchOperateEvent`, `subscribeOperateSession`, `listOperateEvents`, `claimOperateSessionWorkspace`. |
| `packages/workshop-shared/src/operate-flow.ts` | An authored flow (`OperateFlow`: title and ordered canvas ids) and `parseOperateFlowContent`, which checks its limits. |
| `packages/workshop-backend/src/flow-store.ts` | `WorkspaceFlowStore`: a workspace's flows in its Overseer, behind `Overseer.listFlows` / `createFlow` / `replaceFlow` / `deleteFlow`. |
| `packages/workshop-backend/src/server.ts` | `OperateSessionImpl` (`@validateRpc`), which forwards to the user DO with a fresh stub per call and opens the session workspace. |

## Data and Control Flow

The session lives in the user Durable Object, which already exists once per person and is owner-only. Every session method there runs synchronously against storage, so concurrent calls from several tabs (and later the agent) are serialized and never interleave.

`dispatch(event, expectedSeq)` compares `expectedSeq` with the stored sequence number and rejects with `conflict` if another change landed first. It then applies the event with `applyOperateEvent`, rejecting with `invalidEvent` (an `OperateEventError`) when the event doesn't fit the current page. Only then does it append the log entry (`seq`, `event`, `actor`, `at`) and store the new snapshot together with that entry. Either both are written or neither is. Client dispatches are recorded with the actor `person`.

`subscribe()` sends the current snapshot and subscribes to the stored snapshot with no await in between, so no event can fall in the gap. Every later update carries the log entry that produced it. Every connection a person holds subscribes to the same storage, which is what keeps their tabs and devices live on one session.

`getWorkspace()` claims a fresh Overseer id in the user DO (synchronously, so two first calls agree on one id) and registers it like `newGadget()` does, titled "Operate session". `listGadgets()` skips it. If the recorded workspace has been deleted, the next call claims a new one. The workspace is an ordinary owner-only Overseer, so the session's chat uses the existing chat machinery.

A session can run a **flow**: `startFlow` copies an ordered list of one workspace's screen ids into the page state (`flow`), `goToStep` moves the index within it, and `exitFlow` clears it. While `flow` is set the page is meant to show only that step (the full-canvas state); the working set and focus are untouched, so they return on exit. Because the steps are copied in, the reducer validates a step from the event alone and a run is unaffected by later edits to the flow it started from.

Flows are authored per workspace and stored in its Overseer (`flows` collection), next to the canvases whose ids are a flow's steps. The flow methods need build access and both view flags, exactly like the canvas methods, and the use-role capability denies them. A flow is saved only over canvases that exist in that workspace, in the author's order; a step may repeat. Replacing or deleting compares the revision and rejects a stale one with the canvas conflict error. The store never touches a session: a client reads a flow and dispatches `startFlow` with its steps, so the kernel does not check that a run's steps match a stored flow, and a step whose canvas was deleted later is for the client to show as unavailable.

A stored snapshot may predate a page-state field. The user DO fills missing fields from `INITIAL_OPERATE_PAGE` whenever it reads the snapshot, so such a session reads as if it always had the field.

References in the page state (`screen`, `workspace`, and a flow's workspace and steps) identify targets only. The session never opens them and grants no access.

## Configuration

None. Limits are constants in `operate-session.ts`: references and screen ids up to 128 characters, a subject up to 512, at most 24 references in the working set (opening one more drops the oldest), and 1 to 32 steps in a flow run with a title up to 120 characters. One `listEvents()` page returns at most 200 entries.

## Divergences from Design

Against [the design](../design/operate-mode.md):

- A flow is a single ordered list of one workspace's screens. Views that lay out several screens at once, steps from other workspaces, and steps that must be completed before moving on are not implemented.
- Views, subject-bound views, approvals in the page state and handover events are not implemented. The page state covers the working set, focus, subject, chat panel, app presentation and a running flow.
- The session workspace exposes the full `Overseer`, including authoring methods. The operate-only chat mode is the next step.
- The URL mirror, presence, and agent-dispatched events (`actor: "agent"`) are not implemented.
- The event log is kept in full, with no compaction or retention policy.
- Role consoles are not implemented: no console definition, no per-role menu or mosaic, no console state machine (`openConsole`, `consoleEvent`, `navigateBack`), and no grid layout for rollups.
- Build is not gated by role. Any signed-in user can author, and the Build | Operate toggle depends only on the `operate-mode` flag and composable views.
- There is no full chat presentation (`setPresentation`), and the operate chat can't render widgets inside the conversation. The operate chat panel sits beside the canvas only.
- There is no derived console inventory and no admin or observability view of which apps and widgets each console uses.
- Build still offers the bundled `inferops.kanban` blueprint as a creatable output, and it does not yet offer Widgets or Agent workflows as outputs.

## Open Questions

- Retention of the event log for audit versus storage growth.
