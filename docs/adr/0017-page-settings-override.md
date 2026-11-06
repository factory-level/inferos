---
title: A page may override the workspace's settings, by registry key only
status: proposed
date: 2026-11-06
---

# 0017. A page may override the workspace's settings, by registry key only

Amends [ADR 0014](0014-nested-canvas-model.md), decision 4.

## Context

ADR 0014 decision 4 says containment carries nothing: no permission, setting or event reaches a parent or child by being nested. It refuses any field that asks for that (`inherit`, `override`, `extends`, …) as `undefined-inheritance`.

FAC-95 asks for the [design](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/workspaces-and-canvases.md)'s two configuration levels. A workspace owns settings such as base UI (alerts, notifications) and chat-pane widget availability. A page may set page-specific settings. A person must be able to tell a workspace-wide setting from a page override, and trace each one to the configuration that owns it.

That needs one override, which ADR 0014 refused, so this record says exactly which.

## Decision

Proposed by dev.design on 2026-11-06 for FAC-95, for a person to accept.

1. **One registry of settings.** `WORKSPACE_SETTINGS` in `packages/workshop-shared/src/workspace-settings.ts` names each setting, the values it takes, its default and what it permits. v1 has three keys: `baseUi.alerts`, `baseUi.notifications` and `chatPane.widgets`. A new setting is a new registry entry, never a new field.
2. **Two levels, one shape.**
   - **The workspace:** its settings are one revisioned record (`WorkspaceConfiguration`).
   - **A page:** a nested page may set `CanvasPage.settings`, the same keys with their values.
   - **Resolution:** a page's value overrides the workspace's, and the workspace's overrides the default (`resolveWorkspaceSetting`).
   - **No deeper levels:** nothing else overrides anything. An object or widget has no settings, and nothing passes down the tree.
3. **This is the only exception to decision 4.** `settings` on a page is accepted only as registry keys with their values; an unknown key or value is `invalid-setting`. Every other inheritance or override field (`override`, `overrides`, `inherit`, `extends`, …) is still refused as `undefined-inheritance`, on a page and on every node.
4. **A page with settings stays nested.** Version 1 has nowhere to keep them, so `canvasDefinitionFromPage` returns null for such a page and the store keeps it beside its row. Removing every override lets it return to its row.
5. **A setting grants nothing.** It decides presentation only: whether a widget may ask the host to draw base UI, or which widgets the chat pane may open. Every action still needs the person's own grant and approval (FAC-92).
6. **Who may change them:**
   - **Page settings:** the same as any page edit (build access), through one `setSettings` operation.
   - **The workspace's settings:** building as well. In a shared workspace the deployment's shared-configuration service must agree (FAC-44), and a stale revision is refused.
   - **Publication:** a console publication freezes both (`ConsolePublication.settings`, and each published page's `settings`). So FAC-99's Admin check governs what operators get, and a later change reaches them only through a republish.
7. **Traceable.** `traceConfiguration` lists each setting with the level that owns its value, each page hook with the page or node that holds it, and each workspace hook read-only, with what each may do.

## Consequences

- ADR 0014's statement that containment carries nothing still holds: settings live on a page, and nothing reaches a node by nesting.
- Notification delivery stays undefined. FAC-114 left destinations open; `baseUi.notifications` records the choice and its owner only.
- An older reader that predates this sees no `settings` on a version 1 row, and a nested page with settings fails its parse there. That's the same fail-closed rollback story as any nested page in ADR 0014.

## Alternatives considered

- **A general `overrides` map on every node.** Rejected: it reopens the cascade ADR 0014 closed, and an object or widget has no settings to override.
- **Settings only at the workspace.** Rejected: FAC-95 requires page overrides that persist and can be told apart.
- **A separate page-settings record beside the page.** Rejected: the page is the unit of saving and of the revision check (ADR 0014 decision 1), so its settings save with it.
