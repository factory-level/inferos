---
title: The nested canvas model separates containment from behavior and passes nothing down the tree
status: proposed
date: 2026-11-02
---

# 0014. The nested canvas model separates containment from behavior and passes nothing down the tree

## Context

The [design](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workspaces-and-canvases.md) has a workspace holding named pages, and a page holding nested objects and widget instances with attached behavior. A person selects the exact page, object, widget or attachment they're editing, and controls and prompts edit the same saved configuration. It says nesting alone doesn't specify permission inheritance, event propagation or setting overrides, and leaves those rules open.

Today's saved form, `CanvasDefinition` in `packages/workshop-shared/src/canvas.ts`, is a flat list of sections holding widgets, with no nesting and no behavior. Read at inferos `314ef907`.

FAC-80 settles the model before anything is built on it. Nothing here is wired in: no saved canvas, renderer, operation or agent tool changes.

This depends on four proposed records: [ADR 0005](0005-inferops-uri-authority.md) (a reference grants nothing), [ADR 0011](0011-system-workflow-authority.md) (a prompt or widget parameter can't select authority), [ADR 0012](0012-run-correlation-and-outcomes.md) (accepted isn't success, and `uncertain` stays distinct), and [InferOps ADR 0008](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0008-record-ownership-and-resource-bindings.md) (references to company records). The containment and attachment rules below hold without them. What each attachment may do at use time is theirs to decide.

## Decision

The contract is `packages/workshop-shared/src/canvas-model.ts`, schema version 2, with fixtures beside it.

1. **A page is the unit of saving and of the revision check.** A page holds its title, ordered children, attachments and a table of nodes. A workspace's saved canvases are its page collection.
2. **Containment is a table of nodes, and it must be one tree.** A page or object lists its children by stable ID. A cycle, a second parent, a node nothing contains and a page inside an object are each rejected by name. A nested document couldn't express those mistakes, so a move could only be checked in the operation that made it. As a table, the saved value itself is checked.
3. **Permitted nesting:** a page holds objects and widgets, an object holds objects and widgets, and a widget holds nothing.
4. **Containment carries nothing.** It says where a node sits and what is removed with it. No permission, setting or event reaches a parent or child by being nested. A field asking for that (`inherit`, `bubbles`, `overrides` and similar) is rejected as `undefined-inheritance`, so it can't be read as a rule nobody defined. A later contract can add a named, explicit override, as FAC-94's scope expects.
5. **Behavior is an attachment on one node:** when that node has this event, run this one effect. An event reaches another node only when an attachment names it. An unwired event stays local.
6. **Three effects are registered.** `raise-event` raises a named event on one node, `navigate` moves to a named page, and `request-action` asks a widget for an action it declares.
7. **Effects can't feed themselves.** A loop through `raise-event` or `request-action` is a `reference-cycle`, including an action retried automatically when it fails. Navigation loops are allowed: returning or retrying is how a person moves between pages, and arriving on a page raises no event, so such a loop can't run by itself.
8. **A link can't claim an outcome.** A widget's action events (`action-accepted`, `action-completed`, `action-failed`, `action-uncertain`) come only from that widget. Raising one is rejected as `reserved-event`. Listening for an event nothing raises is `unknown-event`, which also catches a parent listening as if events bubbled.
9. **Nothing in the model grants anything.** References identify targets. An attachment has no field naming who it runs as, and a field naming authority is rejected as `authority-field`. A `request-action` is refused at use if the acting person or run may not do it, through that widget's existing approval path. A copy of business data is rejected as `entity-copy`. Parsing takes no viewer, so accepting a page says nothing about access.
10. **Stable IDs.** Page, object, widget and attachment IDs share one namespace per page and use the existing ID syntax. An explicit target is `workspace`, `page:<id>`, `page:<id>/node:<id>` or `page:<id>/attachment:<id>`. A target identifies a selection and authorizes nothing.

### Existing section-based canvases

The saved form stays version 1 until FAC-81 wires this in, and each version refuses the other rather than guessing.

| Version 1 | Version 2 |
| --- | --- |
| View `id`, `title`, `revision` | Page `id`, `title`, `revision`, unchanged |
| Order of `sections` | Order of the page's `children` |
| Section `id`, `title`, `columns` | Object node with the same values |
| Order of a section's `widgets` | Order of that object's `children` |
| Widget `id`, `kind`, `version`, `targetRef`, `size`, `params` | Widget node with the same values |
| Nothing | `attachments: []` on the page and every node |

So every reference and all of the layout carries over, and the mapping can be read back to the same version 1 definition. The tests check that in both directions on the fixtures.

### Proposed defaults

- **D1 Depth and size.** Four levels of objects below the page, 96 nodes, 48 widgets, 48 children per parent and 64 attachments per page. Version 1's largest canvas fits. These bound validation and aren't performance claims.
- **D2 Only three effects for now.** State changes wait for FAC-86 and FAC-87, and prompt insertion for FAC-98. An attachment carrying a prompt is rejected until then.
- **D3 Declared actions.** Boards offer `transition-issue`, `create-issue` and `update-issue`. Wikis offer `update-document` and `update-section`. Gadgets declare none, so they neither emit action events nor accept requests. This names what the gatekeeper offers today, and FAC-85 reconciles it with the registry.
- **D4 Revision on migration.** Conversion keeps the revision, because it isn't an edit and an editor holding that revision isn't stale. FAC-81 can overrule this.
- **D5 Workspace-level behavior isn't in the page.** A workspace target exists for selection, while its hooks and page progression are FAC-95's.
- **D6 A widget directly under a page** takes one full-width row, because a page has no column count.

## Consequences

- FAC-81 has a parser and fixtures to wire in, and owns conversion, storage and rollback. Older code rejects a version 2 page, so a rollback after version 2 is written needs its own answer.
- Every reader of `sections` needs a decision in FAC-81: `canvas-store.ts`, `console-store.ts` (including published copies), `overseer.ts`, `agent.ts`, the frontend's canvas layout, `scripts/consumer/views.ts` and `scripts/consumer/canvas.ts`.
- Operations stay version 1 until FAC-83. Adding a listener before the attachment that raises its event is rejected, so an edit batch has to order them.
- **Not defined here, and rejected until it is:** event payloads, including what an action needs from the event that requested it (FAC-94, FAC-97); explicit overrides (FAC-94); states (FAC-86, FAC-87). A `request-action` can be saved in this model, and nothing runs it yet.
- Draft and published states stay in storage (FAC-89). This model holds no publication field.

## Alternatives Considered

- Nest objects directly in the saved JSON: cycles couldn't be expressed, but neither could they be checked in saved data, and every move and attachment lookup would have to walk the tree.
- Inherit settings or permissions down the tree: it's the Unity reading of nesting, and the design explicitly doesn't adopt it. It would make a move change what something can do.
- Let events bubble to parents: a change inside a widget could then affect a page with no visible link, which the design rules out.
- Allow a bounded retry loop in attachments: retry policy belongs to the action's own outcome handling (ADR 0012), since retrying something uncertain can repeat its effect.
- Add a reusable object placed in several spots: nothing needs it yet, and a second parent is simpler to refuse.

## Related

- Design: [`workspaces-and-canvases.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workspaces-and-canvases.md), [`inferops-canvas.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/inferops-canvas.md)
- Architecture: [`../architecture/inferops-canvas.md`](../architecture/inferops-canvas.md#nested-canvas-model-contract)
- [ADR 0005](0005-inferops-uri-authority.md), [ADR 0011](0011-system-workflow-authority.md), [ADR 0012](0012-run-correlation-and-outcomes.md)
