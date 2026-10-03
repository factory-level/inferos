---
title: Operate mode
status: draft
updated: 2026-10-02
---

# Operate mode

Tracking epic: [#7](https://github.com/factory-level/inferos/issues/7); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

InferOS has two modes. Build is where people author software: apps, widgets and workflows, each in its own workspace. Operate is where people run their operations through a chat that uses that software. Operate is an operational platform, not a build platform. The target is collaborative domain software such as EMR (electronic medical records) and operations software: many people working the same authoritative records at once, often with regulated data. Its chat works your systems (InferOps and other gatekeepers) through the apps and widgets you published, and it never edits their code.

## Requirements

- Each workspace stores an explicit kind: `app`, `widget` or `workflow` (`WorkspaceKind`). The kind changes only through a deliberate switch and is never inferred from code. It decides how the authored thing runs and how Operate presents it.
- An authored app, widget or workflow reaches Operate only through **Publish to Operate**. Publishing packages the workspace as a blueprint and installs it into an operate space at a pinned version. Edits in Build do not reach operations until someone republishes, and upgrading an installed version is explicit.
- An **operate space** lives in a workspace and can be added to. It holds the installed published things, its screens and views, and the operate session. Installing adds gadgets and bindings through existing mechanisms and grants no new authority.
- A **view** composes many operate screens (existing canvas definitions) into one page with a declared layout. Views store references, layout and a revision only, like screens.
- Operate is **a single session**. One continuous operate chat runs across every view and screen in the space. Shared screens and views share their definitions, never a session: each person's conversation and page state are their own.
- A **page state machine** owns the full Operate page state. User actions, the operate agent and the URL all change it through the same validated events. The state is serializable, so a reload or link restores it.
- The operate chat is a kernel **chat mode**. Its agent may use the space's installed gadgets and connected gatekeepers through `executeCode`, read screens and views, and send page events. It has no authoring tools (`readFile`, `writeFile`, `editFile`, `createGadget`, `createWorktree`, `setGadgetBinding`). Writes still go through gatekeeper approvals, and InferOps stays authoritative.
- Installed workflows run inside the operate space on their timed (scheduler) and event (hook) triggers. Their approvals and results surface in the operate session.

- Operate views can be bound to a **subject**: a reference such as a patient, an encounter or a board. The subject is part of the page state. The operate chat works in that subject's context, and the subject's authoritative system decides who may see or change it. A subject reference identifies a target but never authorizes it.
- Collaboration is on records, not sessions. Several people can have the same subject open; each sees the others' presence, and every write carries the expected revision so a concurrent change becomes a visible conflict, never a silent overwrite.
- Every read and write the operate agent performs is attributable and auditable: who asked, which subject, which tool or gatekeeper, and what was approved. Observations already record reads; actions already record approvals. Operate surfaces that record per subject.
- What the operate agent may do follows the person's role in the operate space and in the subject's system, not the published app's wishes. Approval requirements can depend on role and on the data involved.
- Regulated data (for example PHI) never enters logs, analytics, error reports or unapproved model providers. A space that holds such data marks it, which already forces manual approval of every action and blocks public web fetches (`containsRestrictedData`), and it may only use model providers the deployment allows for that data.

## Behavior

### Build ↔ Operate

The shell has a Build | Operate toggle. The mode is derived from the URL: Operate routes are the operate space's pages, and everything else is Build. This is implemented behind the `operate-mode` flag; today Operate is the InferOps Canvas.

### Publishing

From a Build workspace, Publish to Operate creates or updates a blueprint for it and installs or upgrades it in a chosen operate space. The installed copy records its source blueprint and version. The workspace kind travels with the blueprint and decides where the installed thing appears:

| Kind | In Operate |
| --- | --- |
| `app` | Opens full-page in a view, with the operate chat beside it (Chat ↔ App). |
| `widget` | Placed on screens. The operate agent can also show it in the conversation. |
| `workflow` | Runs on its triggers, has no UI, and reports its runs and approvals into the session. |

### Views and screens

A screen is today's canvas definition: sections of widget instances. A view arranges several screens with a layout from a fixed set (for example tabs, or a primary screen with a secondary one), stored as screen references plus layout. Views carry no free-form placement or styling, matching the canvas contract.

### Page state machine

The page state is one value:

- the open view, and the screen shown in each of its regions
- the focused widget, if any
- the open app, if any, and its Chat or App presentation
- whether the chat panel is open
- the approval being reviewed, if any

Every change is an event, applied by one pure transition function:

- `openView`, `showScreen`, `focusWidget`
- `openApp`, `closeApp`, `setAppPresentation`
- `toggleChat`
- `reviewApproval`, `approvalResolved`

The transition function validates each event against the current definitions and the viewer's access. An event that names a missing view, screen or app is rejected without a partial change. The state is mirrored to the URL, so reload, back and links are deterministic.

The operate agent changes the page through a page-event tool that sends the same events. These events only change presentation: they never grant access or perform domain writes. The agent receives the current page state as context, so it knows what the user is looking at.

### Sessions

The operate session is the center of Operate. Everything else (views, screens, subjects, published apps) is something you open *in* your session.

- **One per person.** Each person has exactly one operate session. It is created the first time they enter Operate and never forks. Every tab and device that person opens is a window onto the same session, kept live: a page change in one appears in the others.
- **What it holds:**
  - **the conversation:** one continuous operate chat, never split per screen or per view.
  - **the page state:** the state machine's current value.
  - **the event log:** every page event in order, each with a sequence number, from the person or the agent. The page state is the result of replaying it, so a session is deterministic and can be audited.
  - **the working set:** references to the views, screens, subjects and apps opened in it, from any workspace the person can open. It holds references only, never copies of their data.
- **Shared screens, separate sessions.** Opening a screen or view someone shared with you adds a reference to *your* session. Its definition stays shared, so their edits to it show up for you, but your session, conversation and page state stay yours. Presence shows who else has the same thing open. Handing work over is an explicit event that shares a subject and a note into another person's session.
- **Authority stays with the viewer.** The session grants nothing. Each reference is rendered through the person's own access, so a reference they can no longer open shows as unavailable instead of failing the whole page.
- **The agent works inside the session.** Each operate-chat turn receives the current page state, and the agent changes the page only by appending events through the same validated reducer. Events change presentation only; domain writes still go through gatekeepers and approvals.
- **Links open things in your session.** The URL mirrors the session's current page so it can be shared or bookmarked. Opening one applies an `open…` event to the opener's own session; it never opens someone else's.

**Where it lives (kernel).** Each person's session is backed by a dedicated, owner-only workspace (an Overseer) that never appears in the workspace list. That reuses chat, storage and live subscriptions. `AuthenticatedApi.getOperateSession()` mints an `OperateSession` capability over it, with:
- `subscribe()`: the page state and sequence number, then each event as it lands
- `dispatch(event, expectedSeq)`: append an event, rejected if `expectedSeq` is stale, so concurrent tabs never interleave silently
- access to the session's operate chat

### Subjects

A view may declare a subject type (for example `patient`). Opening it requires a subject reference, which becomes part of the page state and the URL. Every screen and widget in the view receives the subject as input, and the operate chat receives it as context ("this patient"). Switching subject is an event (`openSubject`), like any other page change. The view stores no copy of the subject's data: widgets read it through gatekeepers under the viewer's own authority.

## Non-Goals

- Editing code from Operate. Authoring stays in Build.
- Live use of unpublished Build workspaces.
- Cross-tenant or team scoping beyond existing workspace sharing.
- Free-form layout, custom CSS or arbitrary renderers in views.

## Open Questions

Proposed answers, to confirm:

- **Session scope:** decided: one session per person, shared live across their tabs and devices (see Sessions).
- **First layouts:** a primary region with a secondary one (a chart beside a side panel), and tabs. A grid of screens later.
- **Apps in views:** render through the existing sandboxed gadget host, sized to the region. A dedicated app region would weaken isolation, which matters more with regulated data.
- **Publishing:** require the kind to be set explicitly before publishing. Publishing creates a new pinned version, and upgrading what a space runs is a separate, explicit step, so changes to live operations are controlled.

Still open:

- Which subject types come first, and where their authoritative data lives (InferOps, or another system behind a gatekeeper).
- How roles map from the subject's system into Operate (per space, per subject, or both).
- Which model providers a deployment may use with regulated data, and how a space declares that it holds it.

## Related

- Design: [`inferops-canvas.md`](inferops-canvas.md) (screens, widgets, guarded composition)
- Design: [`agent-authoring.md`](agent-authoring.md) (blueprints, schedules)
- Architecture: [`../architecture/inferops-canvas.md`](../architecture/inferops-canvas.md) (workspace kind as built)
