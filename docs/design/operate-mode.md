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
- A **view** composes many operate screens (existing canvas definitions) into one page with a declared layout. Views store references, layout and a revision only, like screens. A **rollup** is a view that summarizes several screens on one page, such as an Overview of a board and its activity.
- A **role console** (working name, see Open Questions) is the authored collection of everything one operator role works in: its views and rollups, its screens, the flows and state machine that move a person between them, and the published apps and widgets assigned to it. A console stores references, layout, assignments and a revision only. It grants no access.
- **Build is for admins and leads.** Creating and changing apps, widgets, workflows, skills, gadgets and consoles needs a build role. Employees get Operate only and work in the consoles assigned to their role. The role comes from server-enforced authority, never from a UI flag, a deployment profile or the console itself.
- Each console can carry an authored **state machine**: named states, the screens or views each shows, and the guarded transitions between them. It drives navigation and presentation only. Domain writes still go through gatekeepers and approvals.
- Admins and leads can see, for every console and view, which apps and widgets are assigned to it, at which pinned version, with their health and pending approvals. Operators see the same inventory, read-only and scoped to what their role can open.
- Operate has three surfaces, kept distinct: an **app** owns a full page, a **widget** is a bounded piece that can be placed on a screen or rendered in the operate chat, and **full chat** is a ChatGPT-style assistant page with no canvas that loads widgets into the conversation. All three are presentations of the same session. Full chat is optional: each console decides whether to offer it.
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

Only people with a build role see Build and the toggle. Everyone else lands in Operate, in the console assigned to their role (see Roles and access).

### Build outputs

What Build offers to create is a fixed catalog of outputs: **Apps**, **Widgets** and **Agent workflows** (the three workspace kinds), plus the document formats **Sheets**, **Docs** and **Slides**. A Kanban board is not an output. Boards are InferOps records: a console references one through the `inferops.project-board` widget kind and changes it only through the InferOps gatekeeper's approved transitions. Building a board as an InferOS output would copy authoritative data that InferOps owns.

### Publishing

From a Build workspace, Publish to Operate creates or updates a blueprint for it and installs or upgrades it in a chosen operate space. The installed copy records its source blueprint and version. The workspace kind travels with the blueprint and decides where the installed thing appears:

| Kind | In Operate |
| --- | --- |
| `app` | Opens full-page in a view, with the operate chat beside it (Chat ↔ App). |
| `widget` | Placed on screens. The operate agent can also show it in the conversation. |
| `workflow` | Runs on its triggers, has no UI, and reports its runs and approvals into the session. |

### Surfaces: apps, widgets and full chat

Operate presents published things on three surfaces. They differ in who owns the page and how the operate agent can use them:

| Surface | What it is | Owns | The operate agent |
| --- | --- | --- | --- |
| **App** | A sandboxed gadget from an `app` workspace | A full page with its own navigation. The operate chat sits beside it (Chat ↔ App). | Opens and closes it through page events. It can't render an app inside the conversation. |
| **Widget** | A bounded, embeddable piece with declared inputs (schema-validated params and the current subject), a curated size and declared actions | Only its region. It has no navigation of its own. | Places it on screens. It can also render the widget inside the conversation and receive the widget's actions as events. |
| **Full chat** | A ChatGPT-style assistant page: the operate conversation fills the page, with no canvas | The page, as one presentation of the session | Answers freely and loads widgets into the conversation inline. |

The rule: something that needs its own navigation or a full page is an app. Something that takes declared inputs and fits a region is a widget. An app placed in a view region is still an app and keeps its whole region; it is never squeezed into a widget size.

"Widget" covers three kinds, and the design keeps them apart:

- **InferOps transactional widgets**, such as `inferops.project-board`. These are registered kinds the host renders itself, reading through the InferOps gatekeeper.
- **Gadget widgets**: the `inferos.gadget` kind, a published `widget`-kind workspace rendered through the sandboxed gadget host.
- **Declarative chat widgets**: template widgets (a schema, states and actions, like InferOps `widget-kit` or ChatKit widgets) that the operate agent fills with data and shows in the conversation, with no sandboxed code. Whether InferOS adopts this kind is an open question.

Placing a widget in the conversation is presentation only, as it is on a screen. The widget reads under the viewer's own authority, and its actions reach the agent as events. Any domain write still goes through gatekeeper approval.

**Full chat** is optional and is decided per console. A console declares one `fullChat` setting:

- `off` (the default): the console has no full chat, and the operate chat appears only beside the canvas.
- `available`: the person can switch between the canvas and full chat.
- `default`: the console opens in full chat, and the canvas is one switch away.
- `only`: the console is chat-only, with no canvas. This suits a role that needs no screens.

Full chat uses the same session: one conversation, one page state, one event log. Switching between full chat and the canvas is a page event (`setPresentation`), so it keeps the conversation and restores on reload. The reducer rejects `setPresentation` when the open console's setting doesn't allow full chat. In full chat the agent can load only the widgets assigned to the open console, the same set it could place on that console's screens. Like every console setting, `fullChat` selects a presentation. It grants nothing.

### Views and screens

A screen is today's canvas definition: sections of widget instances. A view arranges several screens with a layout from a fixed set (for example tabs, or a primary screen with a secondary one), stored as screen references plus layout. Views carry no free-form placement or styling, matching the canvas contract.

A rollup is a view in the **grid** layout: each region shows a compact form of one screen, and selecting a region opens that screen in full (see Screen navigation). A rollup holds no data of its own; each region renders its screen's widgets under the viewer's authority, the same as opening the screen.

### Role consoles

A role console groups what one operator role works in:

- **views and rollups**, in menu order. The first console has three: Overview (a rollup), Board and Activity.
- **screens** those views reference.
- **flows** that step through its screens.
- **a state machine** (optional) over its screens and views.
- **a full chat setting** (`off` by default, or `available`, `default` or `only`; see Surfaces).
- **assignments**: the published apps and widgets the console's screens may use, each at a pinned installed version.
- **roles** it is assigned to.

A console lives in an operate space and is authored in Build with the same validated composition operations as screens: add, remove, move and configure against an expected revision, with preview and undo, available to people and agents alike. A space can hold several consoles, one per role. A person with access to more than one sees them as a mosaic and picks one; a person with one console lands in it directly.

Assigning an app or widget to a console is composition. It records a reference to an installed version and grants no resource access: each widget still reads through the viewer's own gatekeeper authority, and a reference the viewer can't open shows as unavailable.

### Roles and access

Build access reuses the existing workspace collaborator roles (`CollaboratorRole`: `build` or `use`) rather than adding a parallel mechanism. Authoring a console, or anything assigned to it, needs `build` on its workspace. Operating it needs `use`. An operator with only `use` never receives authoring methods: the kernel withholds them when it mints the capability, so hiding Build in the UI is presentation, not the control.

A console's role assignment selects which consoles a person is offered. It never widens what they can read or change. That still follows their own access in the operate space and in each gatekeeper's system (for example InferOps permissions and row-level security).

### Console state machine

A console may declare a state machine:

- **states**, each naming the view or screen it shows;
- **transitions**, each with a named event, a source and target state, and an optional declarative guard over the page state (for example "a subject is open");
- an **initial state**.

The definition is declarative and stored like a view, as references and a revision. It contains no executable code. The kernel validates it on save (every state reachable, every reference resolving inside the console) and runs it through the existing page state machine: a console transition is one more `OperateEvent`, applied by the same pure transition function, so the person, the operate agent and links all move through it the same way. A saved layout is still not a running machine. The running state belongs to the person's session page state, never to the shared console definition.

A flow is the simplest console state machine: a linear chain whose events are Next and Back.

### Screen navigation

Inside a console, a person moves between views from the console menu and between screens inside a view by selecting a rollup region, by Back, or by the transitions the state machine allows from the current state. Every move is a page event (`openConsole`, `openView`, `showScreen`, `consoleEvent`, `navigateBack`), so it is recorded in the session's event log, mirrored to the URL and restored on reload. The console's state machine and the person's access both bound navigation: an event naming a screen outside the console, or a transition not allowed from the current state, is rejected with no partial change.

### Console inventory and observability

Each console exposes a derived inventory: for each view and screen, the apps and widgets it uses, their pinned versions, and the roles that reach them. The inventory is computed from the console and screen definitions, so it needs no storage of its own and can't drift from them.

The admin view in Build adds what is live for each assignment:

- health and recent errors;
- pending and recent approvals;
- usage.

It draws on existing records: action-log attribution, agent trace spans and the metrics dataset. The same view in Operate is read-only and shows only what the viewer can open. Regulated data never appears there: the inventory names apps, widgets and subjects by reference, never by content.

### Flows

A flow is an authored, ordered list of screens that pushes a person through them one at a time: intake, then triage, then orders. Starting a flow puts the session in a **full-canvas** state, where the current step fills the page in place of the working set's tabs and the navigation, with the step's position and Back and Next. The running flow and its step are part of the page state, so a flow resumes on reload, stays in step across the person's tabs and devices, and can later be advanced by the operate agent through the same events. Exiting a flow returns to the working set as it was. A flow stores references and order only, like a view.

### Page state machine

The page state is one value:

- the open console, its state-machine state and the navigation history used by Back
- the open view, and the screen shown in each of its regions
- the focused widget, if any
- the open app, if any, and its Chat or App presentation
- the presentation: a console's canvas or full chat
- whether the chat panel is open
- the approval being reviewed, if any

Every change is an event, applied by one pure transition function:

- `openConsole`, `consoleEvent`, `navigateBack`
- `openView`, `showScreen`, `focusWidget`
- `openApp`, `closeApp`, `setAppPresentation`
- `toggleChat`, `setPresentation`
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
- Executable code in console state machines. Guards are declarative conditions over the page state.
- Consoles or roles as an authorization mechanism. They select what a person is offered, never what they may access.

## Open Questions

Proposed answers, to confirm:

- **Session scope:** decided: one session per person, shared live across their tabs and devices (see Sessions).
- **First layouts:** a primary region with a secondary one (a chart beside a side panel), tabs, and a grid for rollups.
- **Apps in views:** render through the existing sandboxed gadget host, sized to the region. A dedicated app region would weaken isolation, which matters more with regulated data.
- **Publishing:** require the kind to be set explicitly before publishing. Publishing creates a new pinned version, and upgrading what a space runs is a separate, explicit step, so changes to live operations are controlled.

Still open:

- **The console's name.** "Role console" is a working name for the collection of screens, views and the flows between them. Candidates: console, station, desk, post, playbook.
- Where console definitions live: in the operate space's Overseer next to screens and flows, or also as portable consumer config (`inferos.canvas.json`, the wrapper's `views/`).
- Where an operator's role comes from: workspace collaborator roles alone, an InferOps membership or role read through the gatekeeper, or both.
- Whether InferOS adopts declarative chat widgets (template widgets like InferOps `widget-kit` or ChatKit) alongside gadget widgets, or renders only gadget and InferOps widgets in the conversation. If it does, decide whether one template format serves both InferOps and InferOS.
- The state machine definition format: a small native statechart JSON, or an existing format such as XState's, validated like canvases.

- Which subject types come first, and where their authoritative data lives (InferOps, or another system behind a gatekeeper).
- How roles map from the subject's system into Operate (per space, per subject, or both), and how that mapping selects consoles.
- Which model providers a deployment may use with regulated data, and how a space declares that it holds it.

## Related

- Design: [`inferops-canvas.md`](inferops-canvas.md) (screens, widgets, guarded composition)
- Design: [`agent-authoring.md`](agent-authoring.md) (blueprints, schedules)
- Architecture: [`../architecture/inferops-canvas.md`](../architecture/inferops-canvas.md) (workspace kind as built)
