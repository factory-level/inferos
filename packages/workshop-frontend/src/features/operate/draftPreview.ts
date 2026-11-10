import { canvasPageEffects, type CanvasPage } from '@gadgets/workshop-shared/canvas-model'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateEvent, OperatePageState } from '@gadgets/workshop-shared/operate-session'

/**
 * What the simulated preview shows for something it doesn't do: an action it would request, a move it
 * can't make, or a draft it would put in the person's chat (FAC-98).
 */
export type PreviewNotice = { kind: 'would-request'; action: string; target: string } | { kind: 'not-shown'; page: string }
  | { kind: 'would-draft'; text: string }

/**
 * Where `event` on the widget placing `targetRef` leads in the preview (FAC-96), as Operate would
 * run it (FAC-94): the first wired navigation becomes a move of the preview's own page, `showScreen`
 * within the open view or `openView` of a screen view showing it, and every requested action becomes a
 * notice of what would be requested. A wired draft prompt (FAC-98) is a notice of the draft it would
 * put in the person's chat. Nothing is ever sent. A navigation to a page the console doesn't show
 * is a notice too, as publication would refuse it.
 */
export function previewWidgetEvent(page: CanvasPage, targetRef: string, event: string, draft: OperateConsole,
    state: OperatePageState): { move: OperateEvent | null; notices: PreviewNotice[] } {
  const notices: PreviewNotice[] = []
  let move: OperateEvent | null = null
  for (const effect of canvasPageEffects(page, targetRef, event)) {
    if (effect.kind === 'request-action') { notices.push({ kind: 'would-request', action: effect.action, target: effect.target }); continue }
    if (effect.kind === 'insert-prompt') { notices.push({ kind: 'would-draft', text: effect.text }); continue }
    if (move) continue
    const view = draft.views.find(candidate => candidate.id === state.console?.viewId)
    const within = view?.type === 'rollup' ? view.screens.includes(effect.page) : view?.screen === effect.page
    const other = draft.views.find(candidate => candidate.type === 'screen' && candidate.screen === effect.page)
    if (within) move = { type: 'showScreen', screenId: effect.page }
    else if (other) move = { type: 'openView', viewId: other.id }
    else notices.push({ kind: 'not-shown', page: effect.page })
  }
  return { move, notices }
}

/** The screen the preview's own page shows: the running flow's step, else the console's screen or screen view. */
export function previewScreen(draft: OperateConsole, state: OperatePageState): string | null {
  if (state.flow) return state.flow.steps[state.flow.index] ?? null
  const run = state.console
  if (!run) return null
  if (run.screenId) return run.screenId
  const view = draft.views.find(candidate => candidate.id === run.viewId)
  return view?.type === 'screen' ? view.screen : null
}

/** The event opening `draft` in the preview's own page, at its first view. */
export function openDraftEvent(workspaceId: string, draft: OperateConsole): OperateEvent {
  return { type: 'openConsole', workspaceId, consoleId: draft.id, title: draft.title, source: 'draft', revision: draft.revision,
    fullChat: draft.fullChat, viewId: draft.views[0]!.id }
}
