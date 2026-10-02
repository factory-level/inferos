---
title: InferOps canvas and transactional widgets
covers:
  - packages/workshop-frontend/src/GadgetUI.tsx
  - packages/workshop-frontend/src/features/canvas
  - packages/workshop-frontend/src/pages/inferops-canvas
  - packages/workshop-frontend/src/routes/workspace_.$id.inferops-canvas.tsx
  - packages/workshop-frontend/src/routes/inferops-canvas.tsx
  - packages/workshop-frontend/src/components/AppShell/Sidebar.tsx
  - packages/workshop-frontend/src/hooks/useWorkspaceWorkpieces.ts
  - packages/workshop-frontend/src/hooks/useResizableSplit.ts
  - packages/workshop-frontend/src/components/GadgetPresence.tsx
  - packages/workshop-shared/src/api.ts
  - packages/workshop-shared/src/canvas.ts
  - scripts/consumer/views.ts
  - packages/workshop-backend/src/overseer.ts
  - packages/workshop-backend/src/canvas-store.ts
  - packages/workshop-backend/src/canvas-catalog.ts
  - packages/workshop-backend/src/deployment-config.ts
  - packages/workshop-backend/src/agent.ts
  - scripts/consumer/canvas.ts
  - packages/workshop-backend/src/env.d.ts
  - packages/ui
updated: 2026-10-02
---

# InferOps canvas and transactional widgets

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](../design/inferops-canvas.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-frontend/src/GadgetUI.tsx` | Sandboxed iframe host and RPC handshake; also hosts gadget widgets on the canvas page. |
| `packages/workshop-frontend/src/pages/inferops-canvas/InferOpsCanvasPage.tsx` | InferOps Canvas page at `/workspace/$id/inferops-canvas`: workspace chat beside the composed views. |
| `packages/workshop-frontend/src/pages/inferops-canvas/InferOpsCanvasHome.tsx` | Top-level InferOps Canvas page at `/inferops-canvas` (sidebar entry): screens across workspaces and screen creation. |
| `packages/workshop-frontend/src/features/canvas/` | View picker, read-only renderer, gadget widget host and layout editor. |
| `packages/workshop-frontend/src/hooks/` | Workpiece-list subscription and chat/pane split shared with the workspace editor. |
| `packages/workshop-frontend/src/components/GadgetPresence.tsx` | Existing human presence display. |
| `packages/workshop-shared/src/api.ts` | Human presence protocol and native client/server contracts. |
| `packages/workshop-backend/src/overseer.ts` | Session roster and agent execution orchestration. |
| `packages/ui` | Shared Kumo-based interactions. |

## Data and Control Flow

InferOS hosts sandboxed Gadgets and human participant presence; these are not an implemented InferOps canvas or agent activity feed. InferOps has a versioned widget definition, visual/text registries, inferops:// target references and one project/board widget. Its text resolver coalesces repeated URIs, then resolves distinct URIs independently. ProjectKanban currently depends on InferOps authFetch and its own UI environment. The board DTO contains a full board and decimal-string revisions, not a cursor-page protocol. Personal canvas pins are scoped by tenant/workspace/principal and store x/y positions; they are not the guarded shared composition contract proposed here.

## Configuration

Current board widget freshness is 60 seconds. The InferOps board hook pauses polling when the document is hidden and merges revisions while protecting pending changes. Existing personal pins have their own RLS boundary. InferOS frontend changes must follow frontend-conventions and reuse Kumo/@gadgets/ui.

## Divergences from Design

A guarded composition schema and pure edit engine now exist; workspace-authorized definition storage now exists; an InferOS widget host/data adapter, live agent activity and measured Kanban performance remain unimplemented. Importing the existing React component alone would not resolve authentication, styling, iframe or sharing boundaries.

## Open Questions

- Choose ownership and persistence for shared canvas configuration; current InferOps pins are personal and cannot simply be widened.
- Decide whether the canonical InferOps widget client package can be safely adapted to Kumo and capability RPC or needs a thin host-specific renderer.
- Set measured payload, latency and memory budgets from representative device/network fixtures.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.

## Implemented guarded definition and edit engine

`@gadgets/workshop-shared/canvas` exports v1 definition, content, section, widget and operation types, `parseCanvasDefinition`, `applyCanvasOperations` and a revision-conflict error. The parser reconstructs detached objects, accepts only known fields and rejects unknown definition/widget versions. Two widgets are registered. `inferops.project-board` v1 has a canonical target reference, software/content workflow filter and explicit completed-card visibility; presentation filters do not authorize data. `inferos.gadget` v1 has a `gadget:<workpieceId>` reference to a gadget in the workspace that owns the definition and no parameters. That reference is resolved only through the owning workspace's already-authorized session, grants nothing, and is meaningless in another workspace. No transaction DTO, credentials, ownership or sharing grants are embedded in portable content.

View, section and widget IDs occupy one unique namespace per definition. Titles are bounded plain text. Sections have one to three desktop columns; sizes are normal (one column), wide (up to two), or full (all available columns). The renderer must collapse layouts responsively. Structural limits are 12 sections, 48 total widgets and 32 operations per batch; these bound validation work and are not measured performance budgets.

Edits add/remove/move/configure sections or widgets, rename the view, or restore validated prior content. Move indices refer to the destination after removal. Every intermediate composition validates, and a failure returns no partially modified caller state. A successful batch advances one canonical decimal-string revision using BigInt; stale expected revisions return a conflict with the current revision. Restore keeps the view identity and advances revision; it never invokes or reverses InferOps transactions. An unchanged-content edit still consumes a revision.

This engine performs no storage, authorization or feature enforcement. Its result is suitable for preview. Before persisting, a server caller must check installation flags and workspace edit authority, resolve resource capabilities independently, and compare/write inside one storage transaction. A test of this pure engine is not evidence that concurrent durable writes are safe.

Bootstrap writes `views/operations.json` with the configured target reference. `views:check` runs the pinned validator, bounds file count/size, rejects links/executable files, duplicate view IDs and any widget other than a project board (gadget references are workspace-local, so a portable starter cannot carry one), and reports runtime readiness false. It does not load the InferOps fixture, connect a provider or publish a view. Supporting pins expose a builder Canvas page when composable views are enabled; importing the starter creates a new definition.

## Workspace-scoped definition storage

The existing Overseer durable object's typed storage now has a `canvases` collection. `WorkspaceCanvasStore` uses that collection and the object's synchronous transaction mechanism; it does not introduce a separate database or domain-data cache. Owner/build sessions expose list, get, create, edit and delete methods on the existing Overseer capability. The use-only surface explicitly denies all five methods, covered by the exhaustive use-role suite. Unrelated users still fail the native workspace-open authorization, and IDs are resolved only inside the current workspace's collection.

Every storage operation requires deployment bindings `COMPOSABLE_VIEWS` and `DURABLE_VIEWS` to equal the string `true`. These are structural installation switches, separate from admin soft settings and rollout flags. Disabling either denies reads and mutations without deleting stored records. The consumer launcher maps the corresponding config flags to these bindings. Public server configuration exposes effective flags; the frontend hides the editor's Canvas button and the Canvas page explains that composition is disabled. The board data adapter remains pending.

Creation accepts content only, mints a new UUID and starts at revision zero. It enforces 64 active definitions per workspace. Imports/recreation never reuse the deleted view's identity, avoiding stale-edit confusion. Edit and delete compare expected revisions in the same synchronous transaction as the write. Invalid edit batches leave persisted content unchanged. Delete removes only the definition; underlying InferOps data is untouched. Unknown stored schema versions fail validation rather than being silently rewritten.

Definitions inherit the native workspace build-access boundary; they do not yet have independent sharing controls. The existing sharing manager's session/revocation behavior remains authoritative. Reading a definition is not reading a referenced board: no target is resolved and no resource grant is created by this API. The future renderer/data adapter must separately obtain authorized capabilities before loading any referenced data. Existing InferOps personal pins remain untouched.

Real Workers/RPC tests cover concurrent revision conflicts, rollback, scope isolation, build/use roles, quota and recreation identity. A harness configuration update reloads Workers with durable views disabled, proves access is denied, then reenables them and reads the original definition. This demonstrates Worker-reload retention, not a cloud rollout, OS crash recovery, schema migration or completed consumer view experience.

## Canvas page and builder composition UI

`/workspace/$id/inferops-canvas` is a fullscreen page (the root already treats every `/workspace/` path as chrome-free). It opens the workspace through the same `useWorkspaceOpen` flow as the editor, so share keys, observer confirmation and open failures behave identically, and use-only collaborators are redirected to the editor route, which shows them only the deployed gadget UI. The workspace's chat runs in a resizable left column (`ChatInterface`, with the remembered width shared with the editor) and the canvas fills the rest; on narrow screens a Chat/Canvas toggle shows one at a time. Chat selection lives in the `chat` search parameter. Opening a gadget from chat navigates to the editor with that gadget selected. The editor's InferOps Canvas button navigates to this page. The selected view lives in the `view` search parameter, so a screen can be linked to directly.

Outside edit mode the active view renders read-only. Sections are size containers, so column counts follow the canvas pane's width rather than the viewport: two- and three-column sections collapse to one column below 48rem, and three-column sections show two columns until 64rem. Gadget widgets resolve their reference against the live workpiece list and open a `GadgetClient` through the workspace's `Overseer` (`getGadget`), disposing it when the widget goes away. They then render through the existing sandboxed `GadgetUI` host, keyed by the gadget's head commit so an accepted change reloads it. A widget does not load its bundle until it has been within 200px of the screen. Missing gadgets and drafts that are still pending in a conversation are never opened; each shows an explanatory state instead. Board widgets show their reference and the explicit unconnected state.

Edit mode uses Kumo controls and the shared guarded operation engine. Sections can be renamed. Each section adds a board by reference or an accepted gadget from a picker. A separate move form selects a widget and destination section, appends it there, and returns focus to the source selector. This avoids removing the focused control along with a moved card. Existing upward ordering and undo can refine or reverse the move. It supports temporary in-memory views or saved definitions through the existing Overseer capability. Temporary views are labelled unsaved and last only while the page stays open. Saved changes compare revisions; rejected writes retain the displayed snapshot and offer an explicit reload. Undo restores prior content with a new revision and retains up to 20 session-local snapshots per view. Import validates bounded JSON and sends only content, so stored identities and workspace authority are never imported.

Async responses from an earlier workspace are ignored. A slow file read cannot initiate a create against a workspace that has since been left. Layout controls do not load or mutate domain records or gadget code. Board data, gadget console logs in chat, individual sharing and performance benchmarks remain follow-up work.

Export revalidates the active definition and uses the existing browser file-download helper. The JSON contains only the strict portable schema, including required resource references. It contains no ownership, grants, credentials or transactional rows. The filename uses the validated view ID rather than the display title. Import preserves section/widget identities within the new composition but creates a fresh view ID and revision zero; it never carries authority from the source workspace. Exporting a temporary view is allowed, and does not implicitly save it to the server. Exported views that contain gadget widgets are rejected by the consumer starter validator, because gadget references are workspace-local.

## Composition catalog

`CanvasCatalog` (in `@gadgets/workshop-shared/canvas`) is what an installation offers for composition: the widget kinds people and agents may add, blueprints offered as widgets (instantiated as gadgets, placed as `inferos.gadget`), and screen templates new canvases may start from. Templates hold layout and `inferops.project-board` references only, since gadget IDs are workspace-local; `parseCanvasCatalog` reuses the definition parser, so IDs, limits and widget rules match saved canvases exactly.

The deployer sets it through the `CANVAS_CATALOG` JSON binding. `readCanvasCatalog` (`canvas-catalog.ts`) treats an unset binding as every registered kind with no blueprints or templates, and a malformed one as an empty catalog, logged at `error`: a catalog only ever narrows composition, so failing closed loses nothing it could grant. `getServerConfig` publishes it as `canvasFeatures.catalog`.

`applyCanvasOperations` takes an optional `allowedKinds`. Every widget an add, configure, add-section or restore brings in must be of an allowed kind; widgets already on the canvas are left alone, so narrowing the catalog never strands a composition. `WorkspaceCanvasStore` passes the catalog's kinds to every edit and checks created content the same way, so the builder UI and the agent are held to one rule.

The catalog grants nothing. It does not resolve a board reference or bind a gadget to a resource, and enabling a kind is not permission to read the data it shows.

## Agent canvas tools

When durable views are enabled the chat agent has two tools, `listCanvases` and `editCanvas`, which reach the workspace's canvases through the `AgentHooks.getCanvasAccess` hook. That hook returns the same `WorkspaceCanvasStore` paths the builder UI uses, so the agent's edits obey the same revision checks, limits and catalog. With durable views off the tools are not offered at all, and spawned sub-agents never get them.

`listCanvases` returns each canvas's layout and revision plus the catalog (kinds, blueprint widgets, template titles). `editCanvas` creates a canvas (optionally from a template) or applies a batch of the engine's own operations against an expected revision; a stale revision returns the current one so the agent re-lists before retrying. Edits apply when the call runs rather than riding the chat's proposed changes: a canvas holds references and layout, not code or domain data, and the builder UI applies the same edits immediately. Replay returns the recorded output and never re-applies an edit.

A blueprint widget such as the InferOps Kanban board is placed in three steps the tool description spells out: `createGadget` from the blueprint, wire the binding its notes describe (requesting the connection first), then add it with `editCanvas` as an `inferos.gadget` widget. A gadget created in the chat renders on the canvas once the user accepts the chat's changes.

## Canvas configuration CLI

`scripts/consumer/canvas.ts` configures composition before any custom code is written, in this repository (`pnpm canvas <command>`) or in a consumer wrapper (`pnpm canvas <command>`, through the wrapper runtime). It reads and writes `inferos.canvas.json` at that root: enabled widget kinds, blueprint widgets, screen templates, and which `custom-gatekeepers/` packages run. `list` shows what the checkout builds beside what is enabled; `enable`/`disable`, `add-screen`/`remove-screen` and `gatekeeper enable|disable|all` edit the file, re-validating before every write so the CLI never writes a configuration the Workshop would reject. Names the checkout does not build are errors rather than being dropped, and a blueprint widget requires the gadget kind it is placed as.

`pnpm dev-server` (and `run-local`) reads the same file — from `--consumer-root`, or this checkout's root — and passes the resolved catalog as `CANVAS_CATALOG` and binds only the selected custom gatekeepers. In-repo there is no `inferos.config.json` to carry feature flags, so the presence of `inferos.canvas.json` turns composable and durable views on; a wrapper's own flags always take precedence.

## First-class InferOps Canvas page

When composable views are enabled the sidebar shows **InferOps Canvas**, linking to `/inferops-canvas`. That page lists saved screens across the user's most recently active build workspaces (at most 24): screens are stored per workspace, so it opens each workspace once with a pipelined `openGadget(id).listCanvases()` and disposes the stub right away. A workspace that needs observer setup before it can be opened is listed without its screens. The page also creates a screen in a chosen workspace, blank or from a catalog template, and opens it.

On a workspace's page the pane offers only the catalog's widget kinds. Catalog blueprint widgets appear as buttons that start a new chat (with the user's last-chosen model) asking the agent to build and place that widget, since doing so means creating a gadget and wiring a connection. Saved views are re-read every five seconds while the page is visible and no operation is in flight, so the agent's edits show up without a reload.
