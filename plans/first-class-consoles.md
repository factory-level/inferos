# First-class consoles: create a console without a workspace

*   **Author:** Calvin Edwards
*   **Status:** Proposed
*   **Date:** 2026-11-13

--------------------------------------------------------------------------------

## Overview

In InferOS, a console is the set of pages an operator works in. Today a console
is stored inside a workspace, and a workspace is the place where apps, widgets
and agent workflows are built. This design makes a console its own thing. A
person creates one by giving it a name, builds its pages with a Build chat
beside them, publishes it, and an operator opens it in Operate. No workspace is
chosen, created, opened or named at any step.

The matching change to the product design is proposed in
[inferops#2661](https://github.com/factory-level/inferops/pull/2661).

## The Problem

"New console" opens a four-step setup. Its first step, Basics, asks for a
workspace. The reason is storage, not usefulness to the person:

*   A console is a row in one workspace's storage, limited to 16 per workspace.
*   A console may only show pages ("screens") that are stored in that same
    workspace. The backend refuses any other.
*   Permission to author or publish a console is the person's role on that
    workspace.

The effects a person sees:

*   With no workspace, setup stops at "Create a workspace in Build first, then
    return here to set up a console."
*   With several workspaces, the person must know which one holds the pages
    they want. Pages in two workspaces cannot be combined in one console.
*   Operate finds consoles by opening up to 24 workspaces and asking each for
    its consoles. A console in the 25th is not found.
*   A page can be created in five places (the canvas home, the workspace canvas
    page, the console setup, the Build agent's tool, and scripts). Each has its
    own copy of the template and blank-page logic.
*   No chat can create a console. The Build chat can edit pages, and only
    inside the workspace it runs in.

The proposed solution stores a console, its pages and its sharing in an object
of its own, lists consoles for a person in one place, and gives creation a
single screen with a Build chat that edits the same configuration the direct
controls edit.

## Goals

*   A signed-in person with zero workspaces can create a console by name.
*   A console's pages, draft, publication and collaborators are stored with the
    console, not with any workspace.
*   No URL, stored reference or session record of a first-class console names a
    workspace.
*   The creator has a Build chat that can add and change pages and save the
    console's draft. Publishing, sharing and deleting stay human actions.
*   A published first-class console appears in Operate for the people it is
    shared with, and opens there, without opening any workspace of theirs or
    the author's.
*   Listing a person's consoles is one call and opens nothing.
*   Pages are created through one code path. The other entry points call it.
*   Existing workspace-stored consoles keep working unchanged.

## Non-Goals

*   Placing widgets that a workspace built (gadget widgets, bound views, host
    boards, flows) on a first-class console. The first round offers the three
    built-in InferOps widget kinds: project board, wiki, governed table.
*   Moving existing workspace-stored consoles into the new storage.
*   Sharing a console by link. A console is shared by adding a named person.
*   Running the chat without the workspace engine. The chat helper runs in a
    hidden per-person host that uses that engine.
*   The Operate Mode Redesign layout, beyond what this flow needs.
*   The Dot's temporary canvases.
*   Role assignment, operate spaces and console state machines from the older
    Operate specification.

## Open Questions

*   **Connecting twice.** The chat makes its connections in the assistant
    host, and a board on a page reads through the viewer's own Operate session
    workspace. A person may be asked to connect their InferOps account in both
    places. Whether to merge them is not decided.
*   **Pages that only a workspace can satisfy.** A page with a widget event or
    a run trigger fails the publish checks on a console object, because those
    name gadgets and hooks it does not hold. The plan refuses the gadget widget
    kind at write time; whether the page editor should also hide attachments is
    not decided.
*   **ADR 0020.** That number is cited in code but exists only on the open
    branch `fac-134-adr-0020`. This work uses 0021.
*   **Company rule.** Decided 2026-11-13: a console records the company its
    creator was working in, and nothing is hidden or refused on that basis yet.
    The rule that will read the field is not designed.
*   **Local proof.** All 40 local port blocks are in use, so the worktree for
    this work has no local stack. One must be freed before a browser pass.

## Critical User Journeys (CUJs)

### CUJ 1: Create a console with no workspace

*   **Given**: A signed-in person with build permission and zero workspaces.
    Composable and durable views are on.
*   **When**: They open Consoles in Build, choose New console and type a name.
*   **Then**: The creator opens on an empty draft console. Their workspace list
    is still empty. The address contains a console id and no workspace id.

### CUJ 2: Build a page with the chat

*   **Given**: The creator is open on a draft console with no pages. The person
    has an InferOps account connection.
*   **When**: They ask the chat for "a page with the ENG board".
*   **Then**: A page with a project-board widget appears in the creator, the
    console's draft lists it as a view, and the same change is possible with
    the direct controls. The chat offers no publish, share or delete action.

### CUJ 3: Publish and share

*   **Given**: A draft console with at least one page, and a person who holds
    the publish permission.
*   **When**: They choose Publish, then share the console with another person
    for use.
*   **Then**: A published revision exists. Later edits change the draft and not
    the published revision. A person without the publish permission is refused.

### CUJ 4: An operator opens it

*   **Given**: A second signed-in person the console was shared with for use,
    who has zero workspaces.
*   **When**: They open Operate.
*   **Then**: The console is on their console list. Opening it shows the
    published page. The board asks them to connect their own InferOps account
    and then shows data read with their access. They see no authoring controls.

### CUJ 5: Existing consoles are unaffected

*   **Given**: A workspace-stored console published before this change.
*   **When**: Its operators open Operate after the change.
*   **Then**: It is listed beside first-class consoles and opens as before.

## Technical Plan (Architecture)

Three decisions by the author on 2026-11-12 fix the shape:

1.  A console is stored in an object of its own class, with an RPC interface
    written for consoles.
2.  That object reuses the existing console store unchanged.
3.  The Build chat runs in a hidden per-person host, and its page tools call
    the console object as the person who sent the message.

### Components

```text
 Browser                         Backend worker (server.ts)
 ┌───────────────────┐  RPC     ┌──────────────────────────────┐
 │ Build: /consoles   │────────▶│ AuthenticatedApi              │
 │  ConsoleCreator    │         │  newConsole / listMyConsoles  │
 │  + Build chat      │         │  openConsoleHome / assistant  │
 │ Operate: mosaic,   │         └───┬──────────┬───────────┬───┘
 │  ConsolePage       │             │          │           │
 └───────────────────┘             ▼          ▼           ▼
                        ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
                        │ User object   │ │ Console  │ │ Assistant host    │
                        │  consoles     │ │ object   │ │ (hidden Overseer, │
                        │  list (refs)  │ │ (new)    │ │  one per person)  │
                        └──────────────┘ │ pages    │ │  chats, model,    │
                                ▲         │ draft    │ │  tool allow-list  │
                                │ mirror  │ publish  │ └────────┬─────────┘
                                └─────────│ sharing  │◀─────────┘
                                          └──────────┘  page and draft writes
                                                        as the initiator
```

**Console object** (new Durable Object class, one instance per console). It
holds one console. Its storage declares the eight collections the existing
console store and canvas store read: consoles, canvases, canvas pages,
published page copies, gadgets, flows, workspace settings and bound hooks. The
last four stay empty. It also holds the collaborator and share-link storage
that the existing sharing manager needs, and the owner's profile id. It
constructs the existing canvas store, console store and sharing manager over
that storage.

**Console interface** (new, in the shared API). Opening a console returns one
of two capabilities, chosen by the caller's role when it is minted:

*   Authoring (owner and build collaborators): read the console and its draft
    problems; list, read, create, edit and delete pages; replace the draft at
    an expected revision; publish; manage collaborators; delete the console.
*   Reading (use collaborators): read the published console, its published
    pages and its frozen settings. No draft and no write method exists on it.

Method names and argument shapes match the workspace's for the same operation,
so the frontend's page editor can take either through a narrow prop type. The
interface has no gadget, flow, bound-view, host-board or workpiece method.

**Console list** (user object). A `consoles` collection holds, per console the
person can reach, its id, title, the person's role and whether it is published.
It is written when the person creates a console, when a console is shared with
them, when they open a share link, and when a publication changes. Listing
reads this collection only.

**Assistant host** (hidden Overseer, one per person). Claimed the way the
Operate session's workspace is claimed, recorded in the user object, and left
out of the workspace list. It is marked as an assistant host when first opened.
In it the agent is offered only: list pages, edit pages, edit the console
draft, list connectable resources and request a connection. It holds chats and
nothing else: no gadgets, files, canvases or consoles.

### How a chat reaches a console

A creator chat is created for one console id, and the host stores that id on
the chat record. Only the call that creates the chat sets it, and that call
checks that the caller can author the console. The agent's canvas hook, which
today returns access to the host workspace's own pages, returns access to that
chat's console instead. Each tool call passes the message sender's user id to
the console object, which checks their role before writing. A person who lost
build access mid-conversation is refused at the next write.

The existing hook takes no chat argument. It gains one, as six other agent
hooks already have; the chat id is in scope at every call site.

### How Operate opens a first-class console

A session event that opens a console today carries `workspaceId`. A new
variant of the console reference carries the console's own id and no workspace
field. Stored sessions that hold the old shape stay valid and mean a
workspace-stored console.

The operate session's kernel checks (`getConsole` before navigation, published
flows, bound views) go through one resolver. Given a console reference it
returns a reader with the four methods those checks use, backed by a workspace
or by a console object. For a console object, flow and bound-view lookups
return nothing.

In the frontend, the console list merges two sources: the existing workspace
scan and the new list call. An entry's workspace becomes optional. The console
page branches once, at the top, on the kind of reference: it opens either the
workspace or the console capability and hands a common reader to the views
below. Boards on a first-class console always resolve through the viewer's own
session workspace and their own InferOps connection, which is the path
use-role operators already take.

### Authority

| Action | Check |
| --- | --- |
| Create a console | Signed in; both view flags on; the person holds the shared-configuration `build` permission |
| Edit pages or draft (person or chat) | Owner or build collaborator on the console object, checked at every write |
| Publish | Owner or build collaborator, and the shared-configuration `publish` permission, asked of the person's user object at the time of publishing |
| Read published | Owner, or any collaborator |
| Share, delete | Owner |

A console grants no access to data. A board on a page reads through the
viewer's own connection.

### Widget kinds

Page creation and edits are held to the deployment catalog as today. On a
console object the gadget kind is refused when a page is written, because the
object holds no gadgets and the publish checks would fail later.

### Rollout

Both view flags gate the new object, as they gate consoles today. No new flag
is added. The new class needs a migration tag in the backend worker's config.
Removing the feature later leaves stored console objects unread; nothing else
depends on them.

## Alternatives Considered

### Alternative A: Hidden workspace container per console

The console is stored in a workspace object that is created automatically,
marked as a console and left out of the workspace list.

*   **Pros**: Smallest change. Operate, the console store and sharing are
    unchanged. Gadget widgets, flows and bound views would work at once.
*   **Cons**: The console's id is a workspace id. It carries workspace roles,
    share keys and metadata. Seven callers of the workspace list must each
    filter it out.
*   **Reason for Rejection**: Rejected by author: the goal is that no stored
    reference of a console names a workspace, and one missed filter would show
    the container as a workspace.

### Alternative B: Own object that implements the workspace's read methods

A new object class implements the seven read methods Operate uses, through an
interface shared with the workspace. Operate keeps one code path.

*   **Pros**: Far fewer Operate sites change. Both kinds of console are read by
    the same code.
*   **Cons**: The session field stays named `workspaceId` while holding a
    console id, or is renamed in 27 places. The shared interface grows toward a
    workspace each time Operate needs one more method.
*   **Reason for Rejection**: Rejected by author: chose an interface written
    for consoles, with no workspace concept in it.

### Alternative C: Split the console store into a core and workspace parts

The parts every console needs move into a core over consoles, pages and
published copies. The workspace store builds on it.

*   **Pros**: The new object stores only what it uses. Types state what a
    first-class console cannot do.
*   **Cons**: Edits the kernel's most reviewed console file. Publishing and the
    draft checks interleave widget and page logic, so the split is more than
    moving functions.
*   **Reason for Rejection**: Rejected by author: chose to reuse the store
    unchanged, so existing consoles carry no risk from this work.

### Alternative D: A new small store for first-class consoles

A separate store that shares only the parsers and the canvas store.

*   **Pros**: Existing store untouched. Smallest review surface per file.
*   **Cons**: Publish and draft-check rules exist twice and can drift apart.
*   **Reason for Rejection**: Rejected by author: one set of publish rules for
    both kinds of console.

### Alternative E: One hidden chat host per console

Creating a console also creates a hidden host that stores its chats.

*   **Pros**: No binding between a chat and a console is needed. Chat history
    is separate per console.
*   **Cons**: One extra hidden workspace object per console. Hosts can be
    orphaned when a console is deleted.
*   **Reason for Rejection**: Rejected by author: chose one host per person
    with each chat bound to a console.

### Alternative F: The browser applies the chat's edits

The chat proposes page operations and the creator applies them through the
person's own capability.

*   **Pros**: No kernel path from the host to the console. Every write is the
    person's own by construction.
*   **Cons**: A turn cannot finish with the tab closed. Multi-step edits wait
    on the browser at each step.
*   **Reason for Rejection**: Rejected by author: chose tools that call the
    console object directly.

### Alternative G: Extract the chat runtime from the workspace engine

The console object would host its own chat.

*   **Pros**: No workspace engine involved at all.
*   **Cons**: A large kernel refactor that must land before any creator work.
*   **Reason for Rejection**: Rejected by author: chose the hidden per-person
    host for this round.

### Alternative H: Operate Chat or the Dot as the helper

*   **Pros**: The Operate Chat is already beside the canvas in the redesign.
    The Dot already has an approval flow.
*   **Cons**: The Operate Chat has no write tools today. The Dot needs the
    person's own InferOps sign-in and its canvas path does not complete outside
    tests (not verified).
*   **Reason for Rejection**: Rejected by author: chose a Build chat.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security**: A console object grants no data access. Every write, by a
    person or by the chat, is checked against the writer's role in the console
    object at the time of the write. A chat's console binding is set once, by
    the call that creates the chat, after an authoring check. No tool
    publishes, shares or deletes.
*   **Rollout and rollback**: Both existing view flags gate the feature. The
    new class is added with migration tag `v6`. Rolling back the code leaves
    console objects stored and unread. Stored Operate sessions need no
    migration: a run without a home marker is read as a workspace console.
*   **Kernel review**: Kernel and shared-API changes are in pull requests
    separate from UI changes. Each exported member of the shared API gets a
    doc comment.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Paths are relative to the InferOS repository root. Work is grouped into eight
pull requests in order. Kernel and UI are never mixed. Each pull request
updates the architecture document that covers its paths in the same commit.

### Target Files to Create/Modify

#### Pull request 1: decision record and divergences (docs only)

##### 1. `docs/adr/0021-first-class-consoles.md` (Create)

*   **Type / Scope**: Decision record, status `proposed`.
*   **Proposed Changes**: Records the six author decisions (own object and
    interface, store reused whole, per-person chat host, tools call the console
    object, built-in widgets only, company recorded and not enforced), the
    rejected alternatives, and the link to inferops#2661. Needed because the
    intended design changed.

##### 2. `docs/adr/README.md` (Modify)

*   **Type / Scope**: Index.
*   **Proposed Changes**: Add the 0021 row. The docs check requires it.

##### 3. `docs/architecture/operate-mode.md` (Modify)

*   **Type / Scope**: As-built document.
*   **Proposed Changes**: Under "Divergences from Design", state that consoles
    are still workspace-stored until this work lands, and remove the stale
    "No personal Dot" line. Refresh `updated`.

##### 4. `docs/architecture/inferops-canvas.md` (Modify)

*   **Type / Scope**: As-built document.
*   **Proposed Changes**: Describe the existing `?setup=new` console setup,
    which no document covers today, and record the same divergence.

#### Pull request 2: console object, pages and draft (kernel)

##### 5. `packages/workshop-backend/src/console-object.ts` (Create)

*   **Type / Scope**: Durable Object class `ConsoleDurableObject` plus its two
    capability classes.
*   **Proposed Changes**:
    *   Storage, declared with `createTypedStorage`: collections `consoles`,
        `canvases`, `canvasPages`, `consoleScreens`, `gadgets` (with its
        `byBindingName` unique index, required for the types to match),
        `flows`, `boundHooks`, `collaborators`, `shareKeys` (with `byAlias`);
        singletons `workspaceConfiguration`, `authzGeneration`, `ownerId`,
        `ownerProfileId`, `consoleId`, `company`. Calls
        `watchSharingAuthzInputs` as the Overseer does.
    *   `initialize(ownerUserId, ownerProfileId, company, title)`: callable
        once; stores the owner and company, creates one blank page titled
        "Overview" through `WorkspaceCanvasStore.create`, then creates the
        console through `WorkspaceConsoleStore.create` with one view on that
        page and `fullChat: "available"`. A blank first page is required
        because the store refuses a console with no views.
    *   `open(userId, profileId)`: returns the authoring capability to the
        owner and build collaborators, the reading capability to use
        collaborators, and refuses everyone else with the existing
        access-denied open error.
    *   Authoring capability methods, each with the same name and signature as
        the workspace's: `listCanvases`, `getCanvas`, `getCanvasPage`,
        `createCanvas`, `editCanvas`, `editCanvasPage`, `deleteCanvas`,
        `getConsole`, `getConsoleScreen`, `getConsolePage`, `replaceConsole`,
        `validateConsoleDraft`. Console methods take no console id; the object
        holds one.
    *   Reading capability methods: `getConsole`, `getConsoleScreen`,
        `getConsolePage`, `listCanvases`, each fixed to the published source.
    *   `writeAsAgent(userId, operation)`: the entry the chat host calls
        (pull request 5). Checks the role of `userId` on every call.
    *   Page writes refuse widget kind `inferos.gadget` before reaching the
        store, with the message "Workspace-built widgets are not available on
        this console yet."
    *   Uses `@validateRpc()` and the package logger with component
        `console-object`.

##### 6. `packages/workshop-backend/src/overseer.ts` (Modify)

*   **Type / Scope**: Kernel, two small edits.
*   **Proposed Changes**: Export `BoundHookRecord` (declared but not exported,
    needed for the new storage declaration). Narrow `CanvasWorkspace.storage`
    from the full Overseer storage to the two page collections, so
    `createCanvasAs`, `editCanvasPageAs` and `deleteCanvasAs` accept a console
    object. No behaviour change.

##### 7. `packages/workshop-backend/src/console-store.ts` (Modify)

*   **Type / Scope**: Kernel, one edit.
*   **Proposed Changes**: Export the `ConsoleStorage` type so the new storage
    is checked against it by name. No behaviour change.

##### 8. `packages/workshop-shared/src/api.ts` (Modify)

*   **Type / Scope**: Shared RPC API.
*   **Proposed Changes**: Add `ConsoleSummary` (`id`, `title`, `role`,
    `published`), `ConsoleAuthoring` and `ConsoleReading` interfaces as listed
    for file 5, and on `AuthenticatedApi`: `newConsole(title)` returning the
    authoring capability, `listMyConsoles()` returning summaries, and
    `openConsoleHome(id)` returning either capability with a `role` field.
    Every member documented.

##### 9. `packages/workshop-backend/src/user.ts` (Modify)

*   **Type / Scope**: User object.
*   **Proposed Changes**: Add a `consoles` collection keyed by console id
    holding `ConsoleSummary` plus `created`. Add `recordConsole`,
    `forgetConsole` and `listConsoles`. This is a separate table from
    `gadgets`, so a console never appears in the workspace list.

##### 10. `packages/workshop-backend/src/server.ts` (Modify)

*   **Type / Scope**: Backend entry.
*   **Proposed Changes**: Export `ConsoleDurableObject`. Implement
    `newConsole` (requires both view flags and
    `holdsSharedConfiguration("build")`; reads
    `currentPresentationCompany()`; creates a unique id; initializes the
    object; records the summary), `listMyConsoles` and `openConsoleHome`
    (forgets the summary when the object denies access, as `openGadget` does
    for workspaces).

##### 11. `packages/workshop-backend/cloudflare.config.ts` (Modify)

*   **Type / Scope**: Worker configuration.
*   **Proposed Changes**: Add `{ tag: "v6", new_sqlite_classes:
    ["ConsoleDurableObject"] }` and the class name to the comment list.

##### 12. `packages/workshop-backend/wrangler.jsonc` (Modify, generated)

*   **Proposed Changes**: Regenerated with `pnpm configs:generate`.

##### 13. `packages/workshop-backend/worker-configuration.d.ts` (Modify, generated)

*   **Proposed Changes**: Regenerated with `pnpm types:generate`, which types
    `ctx.exports.ConsoleDurableObject`.

##### 14. `scripts/release/testdata/golden-manifest.json` (Modify, generated)

*   **Proposed Changes**: Regenerated with `UPDATE_GOLDEN=1 node --test
    scripts/release/manifest-lib.test.ts`; the diff is the new migration only.

##### 15. `packages/workshop-backend/vitest.config.ts` (Modify)

*   **Proposed Changes**: Add a `TEST_CONSOLE` binding for the class, which
    puts it in `ctx.exports` under test.

##### 16. `packages/workshop-backend/__tests__/console-object.test.ts` (Create)

*   **Type / Scope**: Workerd unit test.
*   **Proposed Changes**: Initialize once only; owner gets authoring; a
    stranger is refused; a use collaborator gets reading with no write method;
    a gadget widget is refused; draft save at a stale revision conflicts; with
    either view flag off every method refuses.

##### 17. `packages/workshop-backend/__tests__/test-projects.ts` (Modify)

*   **Proposed Changes**: List file 16 in the workerd project. A test enforces
    that every test file is listed once.

##### 18. `packages/integration-tests/__tests__/first-class-consoles.test.ts` (Create)

*   **Type / Scope**: Integration test, following `workshop-consoles.test.ts`.
*   **Proposed Changes**: A user with zero workspaces creates a console;
    `listGadgets` stays empty; `listMyConsoles` returns it; a second user
    cannot open it. Later pull requests extend this file.

##### 19. `docs/architecture/operate-mode.md`, `docs/architecture/inferops-canvas.md` (Modify)

*   **Proposed Changes**: Describe the console object, its storage and the
    console list. Add `console-object.ts` to `covers`.

#### Pull request 3: publish, sharing and reading (kernel)

##### 20. `packages/workshop-backend/src/console-object.ts` (Modify)

*   **Proposed Changes**: Authoring gains `publishConsole(expectedRevision)`
    (asks `holdsSharedConfiguration("publish")` of the caller's user object,
    records `publishedBy`, calls the store's `publish` with no frozen
    installs, then notifies), `deleteConsole`, `listCollaborators`,
    `addCollaborator(username, role)` and `removeCollaborator`, the last four
    owner-only. Sharing writes the collaborator's `consoles` summary and never
    their `gadgets` table. Share links are left out of this round.

##### 21. `packages/workshop-backend/src/user.ts` (Modify)

*   **Proposed Changes**: Add `noticeFirstClassConsoleRevision(consoleId,
    revision)`, which updates the summary's `published` flag and pushes the
    existing console-revision update to open Operate sessions.

##### 22. `packages/workshop-shared/src/api.ts` (Modify)

*   **Proposed Changes**: Add the methods of file 20 to `ConsoleAuthoring`.
    Make `workspaceId` nullable on `OperateSessionUpdate.consoleRevision` so
    the same update serves both kinds.

##### 23. `packages/integration-tests/__tests__/first-class-consoles.test.ts` (Modify)

*   **Proposed Changes**: Publish; edit the draft and confirm the published
    copy is unchanged; share for use and confirm the second user lists it,
    reads published only and has no write method; publish refused without the
    permission when a shared-configuration gatekeeper is set.

##### 24. `docs/architecture/operate-mode.md` (Modify)

*   **Proposed Changes**: Document publishing and sharing of a console object.

#### Pull request 4: Operate opens a first-class console (kernel)

##### 25. `packages/workshop-shared/src/operate-session.ts` (Modify)

*   **Proposed Changes**: Add `home: "workspace" | "console"` to
    `OperateConsoleRun` and the `openConsole` event; `workspaceId` is present
    only for the workspace home. The `openConsole` reducer branch validates
    ids per home. Add a default branch to `applyEvent` that throws the
    session's event error, so an unknown event can no longer overwrite the
    page.

##### 26. `packages/workshop-shared/src/operate-console.ts` (Modify)

*   **Proposed Changes**: Update the `ConsoleRef` comment to say which home
    the id resolves in. No type change.

##### 27. `packages/workshop-shared/src/operate-agui-protocol.ts` (Modify)

*   **Proposed Changes**: `projectOperatePage` emits the run's home and omits
    the workspace id for a console home.

##### 28. `packages/workshop-backend/src/user.ts` (Modify)

*   **Proposed Changes**: `#operatePage` fills `home: "workspace"` on a stored
    run that has none, beside the existing fills for `source` and `revision`.

##### 29. `packages/workshop-backend/src/server.ts` (Modify)

*   **Proposed Changes**: `OperateSessionImpl` takes one more opener, for a
    console object. `#checkConsoleEvent` reads `getConsole` from the console
    object for a console home. `#consoleRun`, `getConsoleBoundView`, the
    published branch of `#checkFlowStart`, `#widgetMachine` and
    `#wiredEffects` return their existing empty or refused result for a
    console home, stated explicitly in each.

##### 30. `packages/workshop-backend/src/overseer.ts` (Modify)

*   **Proposed Changes**: `#agentConsoleMove` and `#sessionConsole` refuse a
    console home with "This console offers no tools." The operate agent does
    not navigate or call tools on a first-class console in this round.

##### 31. `packages/workshop-backend/__tests__/operate-session.test.ts` (Modify)

*   **Proposed Changes**: Reducer tests for both homes; a stored run without
    `home` reads as workspace; an unknown event type is refused.

##### 32. `packages/integration-tests/__tests__/first-class-consoles.test.ts` (Modify)

*   **Proposed Changes**: The second user dispatches `openConsole` with a
    console home, then `openView`; after a republish the next navigation is
    refused with `consoleChanged`.

##### 33. `docs/architecture/operate-mode.md` (Modify)

*   **Proposed Changes**: Document the two homes and the refusals.

#### Pull request 5: chat host and tools (kernel)

##### 34. `packages/workshop-backend/src/user.ts` (Modify)

*   **Proposed Changes**: Add singleton `consoleAssistantWorkspaceId`,
    `claimConsoleAssistantWorkspace(candidateId)` modelled on
    `claimOperateSessionWorkspace`, and leave that id out of `listGadgets`.
    It is not retired on a company change, by the author's decision.

##### 35. `packages/workshop-backend/src/agent.ts` (Modify)

*   **Proposed Changes**: `getCanvasAccess` takes the chat id, as six other
    hooks do. Add `consoleId?: string` to `AiChatAgentContext`. Add
    `CONSOLE_ASSISTANT_TOOLS` (`listCanvases`, `editCanvas`, `editConsole`,
    `listConnectableResources`, `requestConnection`) and apply it when the
    workspace is a console assistant host. Add the `editConsole` tool: read
    the draft, or replace title, views and starting experience at an expected
    revision.

##### 36. `packages/workshop-backend/src/overseer.ts` (Modify)

*   **Proposed Changes**: `open` accepts an assistant-host mark, stored like
    the operate-session mark, owner only. `newConsoleAssistantChat(consoleId,
    message, model)` checks through the console object that the caller can
    author it, then creates the chat with `consoleId` in its context.
    `getCanvasAccess(chatId)` returns access backed by that console object,
    each call passing the initiator's user id, when the chat has a
    `consoleId`; otherwise today's behaviour. A wrapper interface,
    `AssistantOverseerInterface`, exposes only chat, model, action-log and
    connection methods and denies the rest.

##### 37. `packages/workshop-shared/src/api.ts` (Modify)

*   **Proposed Changes**: `AuthenticatedApi.openConsoleAssistant()` returning
    the host's `Overseer` stub, and `Overseer.newConsoleAssistantChat`.

##### 38. `packages/workshop-backend/src/server.ts` (Modify)

*   **Proposed Changes**: Implement `openConsoleAssistant` by claiming and
    opening the host with the mark.

##### 39. `packages/integration-tests/__tests__/first-class-console-chat.test.ts` (Create)

*   **Proposed Changes**: With the scripted model: a chat bound to a console
    adds a page and saves the draft; a chat cannot be created for a console
    the caller cannot author; after build access is removed the next write is
    refused; the tool list contains no file, gadget or code tool.

##### 40. `docs/architecture/inferops-canvas.md` (Modify)

*   **Proposed Changes**: Update "Agent canvas tools" for the console binding
    and the assistant host.

#### Pull request 6: creator and Consoles route (UI)

##### 41. `packages/workshop-frontend/src/routes/consoles.tsx` (Create)

*   **Proposed Changes**: Route `/consoles`; renders the list page.

##### 42. `packages/workshop-frontend/src/routes/consoles_.$id.tsx` (Create)

*   **Proposed Changes**: Route `/consoles/$id` with validated `chat` and
    `view` search values; renders the creator keyed by id. The trailing
    underscore stops it nesting inside the list.

##### 43. `packages/workshop-frontend/src/routeTree.gen.ts` (Modify, generated)

*   **Proposed Changes**: Regenerated by a build; committed.

##### 44. `packages/workshop-frontend/src/pages/consoles/ConsolesPage.tsx` (Create)

*   **Proposed Changes**: Lists `listMyConsoles()`; "New console" asks for a
    name, calls `newConsole` and navigates to the creator. Disabled with a
    stated reason when durable views are off.

##### 45. `packages/workshop-frontend/src/pages/consoles/ConsoleCreatorPage.tsx` (Create)

*   **Proposed Changes**: Opens the console capability and the assistant host.
    Lays out the page editor, the view outline (`ConsoleViewEditor`), the
    draft problems (`DraftProblemsList`), Publish, and the chat
    (`ChatInterface`, as `OperateChatPanel` renders it). "Ask about this
    selection" starts a chat with `newConsoleAssistantChat`.

##### 46. `packages/workshop-frontend/src/pages/consoles/useConsoleHome.ts` (Create)

*   **Proposed Changes**: Hook that opens `openConsoleHome(id)`, holds the
    stub in an object as the RPC rule requires, and disposes it on cleanup.

##### 47. `packages/workshop-frontend/src/features/canvas/CanvasWorkspacePane.tsx` (Modify)

*   **Proposed Changes**: The `overseer` prop becomes optional. Without it the
    pane hides workspace settings, page configuration and attachments, and
    boards read through the `resourceScope` it is given.

##### 48. `packages/workshop-frontend/src/features/canvas/screenContent.ts` (Create)

*   **Proposed Changes**: The one place that builds new-page content:
    `BLANK_SCREEN_TEMPLATE` and `screenContent(catalog, templateId, title)`.

##### 49. `packages/workshop-frontend/src/features/operate/ConsolePublishDialog.tsx` (Modify)

*   **Proposed Changes**: Takes a publish function and a role, in place of
    opening the entry's workspace itself, so it serves both kinds.

##### 50. `packages/workshop-frontend/src/components/AppShell/Sidebar.tsx` (Modify)

*   **Proposed Changes**: Add a Consoles item when composable views are on.

##### 51. Tests (Create/Modify)

*   `pages/consoles/ConsolesPage.test.tsx`, `ConsoleCreatorPage.test.tsx`,
    `features/canvas/screenContent.test.ts` (Create);
    `features/canvas/CanvasWorkspacePane.test.tsx`,
    `features/operate/ConsolePublishDialog.test.tsx`,
    `components/AppShell/Sidebar.test.tsx`,
    `features/operate/operateMode.test.ts` (Modify): creation by name,
    keyboard and focus on the name dialog, the pane without an overseer, both
    publish sources, the new nav link, and `/consoles` classified as Build.

#### Pull request 7: Operate lists and opens them (UI)

##### 52. `packages/workshop-frontend/src/features/operate/consoles.ts` (Modify)

*   **Proposed Changes**: `ConsoleEntry` becomes a union: a workspace entry as
    today, or a first-class entry with `id` and `role`. `findConsole` and
    `openConsoleEvent` branch on it.

##### 53. `packages/workshop-frontend/src/pages/inferops-canvas/useWorkspaceScreens.ts` (Modify)

*   **Proposed Changes**: Also calls `listMyConsoles()` and, per published
    console, reads its console and screens through the reading capability.

##### 54. `packages/workshop-frontend/src/features/operate/ConsolePage.tsx` (Modify)

*   **Proposed Changes**: Branches once on the run's home to obtain a common
    reader (`getConsolePage`, settings, role). Boards on a console home use
    the session workspace scope.

##### 55. `ConsoleMosaic.tsx`, `OperateSidebar.tsx`, `OperateSessionPage.tsx`, `chatPaneWidgets.ts` in `features/operate/` (Modify)

*   **Proposed Changes**: Keys, labels, the role check and the edit link use
    the entry kind. Editing a first-class console and "New console" navigate
    to `/consoles`. Approvals pass no screen workspace for a console home.

##### 56. Tests (Modify)

*   `consoles.test.ts`, `useWorkspaceScreens.test.tsx`, `ConsolePage.test.tsx`,
    `ConsoleMosaic.test.tsx`, `OperateSidebar.test.tsx`,
    `OperateSessionPage.test.tsx`: both entry kinds listed and opened.

#### Pull request 8: one creation path and seed (UI and scripts)

##### 57. `InferOpsCanvasHome.tsx`, `features/operate/ConsoleScreenEditor.tsx`, `features/canvas/CanvasWorkspacePane.tsx` (Modify)

*   **Proposed Changes**: Each uses `screenContent` in place of its own copy
    of the template logic. The canvas home's "new screen in a workspace" form
    is replaced by a link to Consoles.

##### 58. `packages/workshop-frontend/src/features/operate/ConsoleBuilder.tsx` (Modify)

*   **Proposed Changes**: Edits existing workspace consoles only. The create
    path and its "Create a workspace in Build first" message are removed.

##### 59. `packages/workshop-backend/scripts/dev-setup.ts`, `scripts/local/lifecycle.ts`, `scripts/local/lifecycle.test.ts` (Modify)

*   **Proposed Changes**: A `--first-class-console` flag seeds and publishes
    one; `pnpm local seed` passes it; the test that pins the argument list is
    updated.

##### 60. `docs/wiki/local-development.md`, `docs/architecture/inferops-canvas.md` (Modify)

*   **Proposed Changes**: Document the seed flag and the single creation path.

### Verification Plan

*   **Compilation/Build**: `pnpm build`.
*   **Unit Tests**: `pnpm --filter @gadgets/workshop-backend test:run`,
    `pnpm --filter @gadgets/workshop-frontend test:run`.
*   **Static Analysis & Linting**: `pnpm lint`, `pnpm docs:check`,
    `pnpm configs:check`.
*   **Test Coverage Requirement**: No numeric target. Every authority rule in
    the Authority table has a refusing test.
*   **E2E/Integration**: `pnpm --filter @gadgets/integration-tests test:run`
    for `first-class-consoles.test.ts` and `first-class-console-chat.test.ts`;
    `pnpm check:full` before each hand-off. Then a browser pass of CUJ 1 to
    CUJ 5 on a local stack (`pnpm local start --inferops`, `pnpm local seed`),
    with two users who have zero workspaces, confirming that no address
    contains a workspace id. This needs one local port block freed first.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
