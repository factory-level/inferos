---
title: A console is its own object and belongs to no workspace
status: proposed
date: 2026-11-13
---

# 0021. A console is its own object and belongs to no workspace

## Context

A console was a row in one workspace's storage. It could only show screens of that workspace, and its authoring and publishing authority was the person's role on that workspace. Creating a console therefore began with choosing a workspace, and a person with none was told to create one in Build first. Operate found consoles by opening up to 24 workspaces. The owner decided on 2026-11-12 that a console is a first-class thing that needs no workspace; the design change is [inferops#2661](https://github.com/factory-level/inferops/pull/2661).

## Decision

1. A console that belongs to no workspace is one Durable Object (`ConsoleDurableObject`). It holds the console, its pages, its draft and publication, and who it is shared with. It names no workspace and none names it.
2. It has an RPC interface written for consoles: `ConsoleAuthoring` for its owner and `build` collaborators, and `ConsoleReading`, which has no draft and no write, for `use` collaborators. Access is read again at every call.
3. It reuses the workspace's stores unchanged (`WorkspaceCanvasStore`, `WorkspaceConsoleStore`, `SharingManager`) over storage of the same shape. The collections only a workspace fills stay empty.
4. A person's consoles are listed in their own user object, in a table separate from their workspaces.
5. The Build chat that helps author a console runs in a hidden per-person host, and its page tools call the console object as the person who sent the message.
6. The first round offers the built-in InferOps widget kinds only. The `inferos.gadget` kind, registered widgets, host boards, bound views and flows are refused on a console object.
7. A console records the company its creator was working in. Nothing reads it yet.
8. A console is shared with named people. Share links are not offered.

## Consequences

- A person with no workspace can create, publish and share a console.
- Two kinds of console exist until workspace-stored ones are migrated, and Operate lists both.
- A console object cannot place a widget a workspace built until a way to reference one is designed.
- The chat host is a workspace object under the hood. The console never references it.
- The store's gadget, flow and bound-view code runs against empty tables on every save and publication.

## Alternatives Considered

- A hidden workspace container per console: the smallest change, but the console's id, roles and metadata would be a workspace's, and every caller of the workspace list would have to filter it out.
- An own object implementing the workspace's read methods through a shared interface: fewer Operate sites change, but the session's `workspaceId` field would hold a console id.
- Splitting the console store into a core and workspace parts, or writing a new small store: the first edits the most reviewed console file, the second duplicates the publish rules.
- One hidden chat host per console, or the browser applying the chat's edits: an extra object per console, or turns that cannot finish with the tab closed.

## Related

- Design: [`workspaces-and-canvases.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workspaces-and-canvases.md)
- Implementation plan: [`plans/first-class-consoles.md`](../../plans/first-class-consoles.md)
