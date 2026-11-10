import type { WorkspaceSettingValue } from '@gadgets/workshop-shared/workspace-settings'
import type { OperateConsoleRun } from '@gadgets/workshop-shared/operate-session'
import type { ConsoleEntry } from './consoles'

/** A screen's resolved `chatPane.widgets` (FAC-98), with the screen it was resolved for. */
export type ResolvedChatWidgets = { key: string; value: WorkspaceSettingValue<'chatPane.widgets'> | null }

/**
 * The identity a `chatPane.widgets` value is resolved for: the run's workspace, console, source and
 * revision, and the screen it shows (its own, or its screen view's). A value read for another key is
 * someone else's, and reads as unknown.
 */
export const chatWidgetsKey = (run: OperateConsoleRun, entry: ConsoleEntry | undefined): string => {
  const view = entry?.console.views.find(candidate => candidate.id === run.viewId)
  const screenId = run.screenId ?? (view?.type === 'screen' ? view.screen : null)
  return JSON.stringify([run.workspaceId, run.consoleId, run.source, run.revision, screenId])
}
