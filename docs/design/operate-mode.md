---
title: Operate mode
status: draft
updated: 2026-10-02
---

# Operate mode

Tracking epic: [#7](https://github.com/factory-level/inferos/issues/7); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

InferOS has two modes. Build is where people author software: apps, widgets and workflows, each in its own workspace. Operate is where people run their operations through a chat that uses that software. Operate is an operational platform, not a build platform. Its chat works your systems (InferOps and other gatekeepers) through the apps and widgets you published, and it never edits their code.

## Requirements

- Each workspace stores an explicit kind: `app`, `widget` or `workflow` (`WorkspaceKind`). The kind changes only through a deliberate switch and is never inferred from code. It decides how the authored thing runs and how Operate presents it.
- An authored app, widget or workflow reaches Operate only through **Publish to Operate**. Publishing packages the workspace as a blueprint and installs it into an operate space at a pinned version. Edits in Build do not reach operations until someone republishes, and upgrading an installed version is explicit.
- An **operate space** lives in a workspace and can be added to. It holds the installed published things, its screens and views, and the operate session. Installing adds gadgets and bindings through existing mechanisms and grants no new authority.
- A **view** composes many operate screens (existing canvas definitions) into one page with a declared layout. Views store references, layout and a revision only, like screens.
- Operate is **a single session**. One continuous operate chat runs across every view and screen in the space. Shared screens and views share their definitions, never a session: each person's conversation and page state are their own.
- A **page state machine** owns the full Operate page state. User actions, the operate agent and the URL all change it through the same validated events. The state is serializable, so a reload or link restores it.
- The operate chat is a kernel **chat mode**. Its agent may use the space's installed gadgets and connected gatekeepers through `executeCode`, read screens and views, and send page events. It has no authoring tools (`readFile`, `writeFile`, `editFile`, `createGadget`, `createWorktree`, `setGadgetBinding`). Writes still go through gatekeeper approvals, and InferOps stays authoritative.
- Installed workflows run inside the operate space on their timed (scheduler) and event (hook) triggers. Their approvals and results surface in the operate session.

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

### Single session

Each person has one operate session per operate space. The session is the continuous operate chat plus that person's page state. Opening a shared view adds it to your session; it does not join someone else's. Collaborators' presence can be shown, but their page state is never applied to yours.

## Non-Goals

- Editing code from Operate. Authoring stays in Build.
- Live use of unpublished Build workspaces.
- Cross-tenant or team scoping beyond existing workspace sharing.
- Free-form layout, custom CSS or arbitrary renderers in views.

## Open Questions

- Is the single session per operate space, or one per person across every operate space they can open?
- Which view layouts are needed first (tabs, primary + secondary, grid of screens)?
- How does an installed app render full-page inside a view: through the existing sandboxed gadget host at view size, or as a dedicated app region?
- Should Publish to Operate require the workspace's kind to be set explicitly first, or publish the default `app`?
- Retention of page state: URL only, or also restored per person when they return to the space?

## Related

- Design: [`inferops-canvas.md`](inferops-canvas.md) (screens, widgets, guarded composition)
- Design: [`agent-authoring.md`](agent-authoring.md) (blueprints, schedules)
- Architecture: [`../architecture/inferops-canvas.md`](../architecture/inferops-canvas.md) (workspace kind as built)
