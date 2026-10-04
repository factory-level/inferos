import type { GadgetMetadataWithTimestamps, GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { ConsoleView, OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateConsoleRun, OperateEvent } from '@gadgets/workshop-shared/operate-session'
import type { WorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { gadgetIdOf } from '../canvas/canvasLayout'

/** A console together with the workspace it lives in and that workspace's screens. */
export type ConsoleEntry = {
  workspace: GadgetMetadataWithTimestamps
  console: OperateConsole
  screens: readonly CanvasDefinition[]
}

/** Every console across the listed workspaces, in workspace order. */
export const consoleEntries = (workspaces: readonly WorkspaceScreens[]): ConsoleEntry[] =>
  workspaces.flatMap(({ workspace, screens, consoles }) =>
    consoles.map(saved => ({ workspace, console: saved, screens: screens ?? [] })))

/** The listed console a session has open, if it is still there. */
export const findConsole = (workspaces: readonly WorkspaceScreens[], run: OperateConsoleRun): ConsoleEntry | undefined =>
  consoleEntries(workspaces).find(entry =>
    entry.workspace.id === run.workspaceId && entry.console.id === run.consoleId)

/** The event that opens a console at its first view. */
export const openConsoleEvent = ({ workspace, console: saved }: ConsoleEntry): OperateEvent => ({
  type: 'openConsole', workspaceId: workspace.id, consoleId: saved.id, title: saved.title,
  fullChat: saved.fullChat, viewId: saved.views[0].id,
})

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
