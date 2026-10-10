import type { GadgetMetadataWithTimestamps, GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { parseOperateConsoleContent, publishedConsole, type BoundViewEntry, type ConsoleSource, type ConsoleView, type HostBoardEntry, type OperateConsole, type OperateConsoleContent } from '@gadgets/workshop-shared/operate-console'
import type { OperateConsoleRun, OperateEvent } from '@gadgets/workshop-shared/operate-session'
import type { WorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { gadgetIdOf } from '../canvas/canvasLayout'

/**
 * A console together with the workspace it lives in. `console` and `screens` are the revision
 * shown: as listed, a builder's draft over the workspace's current screens (an operator lists only
 * the published revision); see `consoleRevision` for the published one. `publishedScreens` are the
 * screens as the console last published them.
 */
export type ConsoleEntry = {
  workspace: GadgetMetadataWithTimestamps
  console: OperateConsole
  screens: readonly CanvasDefinition[]
  publishedScreens: readonly CanvasDefinition[]
}

/** Every console across the listed workspaces, in workspace order. */
export const consoleEntries = (workspaces: readonly WorkspaceScreens[]): ConsoleEntry[] =>
  workspaces.flatMap(({ workspace, screens, consoles, publishedScreens }) =>
    consoles.map(saved => ({ workspace, console: saved, screens: screens ?? [], publishedScreens: publishedScreens[saved.id] ?? [] })))

/**
 * A listed console as one of its revisions: its draft as listed, or its published revision with
 * the screens as published. Undefined if it has never been published.
 */
export const consoleRevision = (entry: ConsoleEntry, source: ConsoleSource): ConsoleEntry | undefined => {
  if (source === 'draft') return entry
  const published = publishedConsole(entry.console)
  return published ? { ...entry, console: published, screens: entry.publishedScreens } : undefined
}

/** The listed console a session has open, as the revision it opened, if it is still there. */
export const findConsole = (workspaces: readonly WorkspaceScreens[], run: OperateConsoleRun): ConsoleEntry | undefined => {
  const entry = consoleEntries(workspaces).find(candidate =>
    candidate.workspace.id === run.workspaceId && candidate.console.id === run.consoleId)
  return entry && consoleRevision(entry, run.source)
}

/**
 * Whether a builder's listed console is unpublished, has changes since it was published (to the
 * console, or to a screen it published), or is published as it stands.
 */
export const publicationStatus = ({ console: saved, screens, publishedScreens }: ConsoleEntry)
    : 'unpublished' | 'changed' | 'published' => {
  if (!saved.published) return 'unpublished'
  if (saved.published.revision !== saved.revision) return 'changed'
  const current = new Map(screens.map(screen => [screen.id, screen.revision]))
  return publishedScreens.some(screen => current.get(screen.id) !== screen.revision) ? 'changed' : 'published'
}

/**
 * The event that opens a listed console at its first view: its published revision, or (a builder's
 * preview) its draft. Undefined if that revision doesn't exist.
 */
export const openConsoleEvent = (entry: ConsoleEntry, source: ConsoleSource): OperateEvent | undefined => {
  const shown = consoleRevision(entry, source)?.console
  return shown && {
    type: 'openConsole', workspaceId: entry.workspace.id, consoleId: shown.id, title: shown.title,
    source, revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0].id,
  }
}

/** The screen ids a view shows: a rollup's in order, or a screen view's one. */
export const viewScreens = (view: ConsoleView): string[] => view.type === 'rollup' ? view.screens : [view.screen]

/** One widget placed on a screen, named for the per-view inventory. */
export type InventoryItem = { id: string; kind: 'board' | 'wiki' | 'gadget'; label: string }

/**
 * What a screen shows, by name: its InferOps boards (by the board key their reference names), its
 * Wiki widgets, and its gadgets (by title, from the workspace's gadgets). It reads only the screen's
 * definition, so it can't drift from what the screen renders.
 */
export const screenInventory = (screen: CanvasDefinition,
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>): InventoryItem[] =>
  screen.sections.flatMap(section => section.widgets.map((widget): InventoryItem => {
    if (widget.kind === 'inferos.gadget') {
      const gadget = gadgets.get(gadgetIdOf(widget.targetRef))
      return { id: widget.id, kind: 'gadget', label: gadget?.title || 'Untitled gadget' }
    }
    if (widget.kind === 'inferops.wiki') return { id: widget.id, kind: 'wiki', label: 'InferMind Wiki' }
    const key = widget.targetRef.split('/').at(-1) ?? widget.targetRef
    return { id: widget.id, kind: 'board', label: `Board ${key}` }
  }))

/**
 * Checks console content for saving, with its host boards as `edited`, or (undefined) as `saved`
 * when the editor did not change them, and its bound views likewise as `views.edited` or
 * `views.saved`. Every check runs over the entries the console will hold, so the combined widget,
 * host-board and bound-view limit counts saved entries too, and a bound view's requirements are
 * checked against the boards kept; unedited lists are then left out, since the kernel keeps saved
 * entries when a list is omitted, and an editor that never touched them cannot drop or alter
 * them. An edited list, empty included, replaces them.
 */
export const consoleContentForSave = (content: Omit<OperateConsoleContent, 'hostBoards' | 'boundViews'>,
  saved: HostBoardEntry[] | undefined, edited: HostBoardEntry[] | undefined,
  views: { saved: BoundViewEntry[] | undefined; edited: BoundViewEntry[] | undefined } = { saved: undefined, edited: undefined }): OperateConsoleContent => {
  const boards = edited ?? saved
  const boundViews = views.edited ?? views.saved
  const parsed = parseOperateConsoleContent({ ...content, ...(boards === undefined ? {} : { hostBoards: boards }),
    ...(boundViews === undefined ? {} : { boundViews }) })
  const { hostBoards, boundViews: parsedViews, ...rest } = parsed
  return { ...rest, ...(edited !== undefined && hostBoards !== undefined ? { hostBoards } : {}),
    ...(views.edited !== undefined && parsedViews !== undefined ? { boundViews: parsedViews } : {}) }
}
