---
title: Operate mode
covers:
  - packages/workshop-shared/src/operate-session.ts
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/user.ts
  - packages/workshop-backend/src/server.ts
updated: 2026-10-02
---

# Operate mode

## Overview

The operate session is implemented in the kernel: one per person, holding a page state that is the replay of an ordered event log, plus an owner-only workspace for its operate chat. Clients reach it through `AuthenticatedApi.getOperateSession()`. No frontend uses it yet, and the operate chat has no operate-only tool set yet.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-shared/src/operate-session.ts` | The page state machine: `OperatePageState`, `OperateEvent`, `OperateRef`, and the pure `applyOperateEvent` / `replayOperateEvents`. Shared so the kernel, clients and (later) the agent derive the same page from the same log. |
| `packages/workshop-shared/src/api.ts` | The `OperateSession` capability, `AuthenticatedApi.getOperateSession()`, `OperateSessionUpdate`, and the coded `OPERATE_SESSION_ERROR_CODES` (`conflict`, `invalidEvent`). |
| `packages/workshop-backend/src/user.ts` | Session state in the user Durable Object: the `operateEvents` log, the `operatePage` snapshot, and `operateSessionWorkspaceId`. `dispatchOperateEvent`, `subscribeOperateSession`, `listOperateEvents`, `claimOperateSessionWorkspace`. |
| `packages/workshop-backend/src/server.ts` | `OperateSessionImpl` (`@validateRpc`), which forwards to the user DO with a fresh stub per call and opens the session workspace. |

## Data and Control Flow

The session lives in the user Durable Object, which already exists once per person and is owner-only. Every session method there runs synchronously against storage, so concurrent calls from several tabs (and later the agent) are serialized and never interleave.

`dispatch(event, expectedSeq)` compares `expectedSeq` with the stored sequence number and rejects with `conflict` if another change landed first. It then applies the event with `applyOperateEvent`, rejecting with `invalidEvent` (an `OperateEventError`) when the event doesn't fit the current page. Only then does it append the log entry (`seq`, `event`, `actor`, `at`) and store the new snapshot together with that entry. Either both are written or neither is. Client dispatches are recorded with the actor `person`.

`subscribe()` sends the current snapshot and subscribes to the stored snapshot with no await in between, so no event can fall in the gap. Every later update carries the log entry that produced it. Every connection a person holds subscribes to the same storage, which is what keeps their tabs and devices live on one session.

`getWorkspace()` claims a fresh Overseer id in the user DO (synchronously, so two first calls agree on one id) and registers it like `newGadget()` does, titled "Operate session". `listGadgets()` skips it. If the recorded workspace has been deleted, the next call claims a new one. The workspace is an ordinary owner-only Overseer, so the session's chat uses the existing chat machinery.

References in the page state (`screen`, `workspace`) identify targets only. The session never opens them and grants no access.

## Configuration

None. Limits are constants in `operate-session.ts`: references and screen ids up to 128 characters, a subject up to 512, and at most 24 references in the working set (opening one more drops the oldest). One `listEvents()` page returns at most 200 entries.

## Divergences from Design

Against [the design](../design/operate-mode.md):

- Views, subject-bound views, approvals in the page state and handover events are not implemented. The page state covers the working set, focus, subject, chat panel and app presentation.
- The session workspace exposes the full `Overseer`, including authoring methods. The operate-only chat mode is the next step.
- The URL mirror, presence, and agent-dispatched events (`actor: "agent"`) are not implemented.
- The event log is kept in full, with no compaction or retention policy.

## Open Questions

- Retention of the event log for audit versus storage growth.
