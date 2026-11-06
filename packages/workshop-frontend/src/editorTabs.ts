import type { WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { formatOf } from './components/format/formats'

/** The editor pane's tabs. */
export type RightTab = 'app' | 'preview' | 'code' | 'connections'

// The first tab is named after what the selected workpiece is ("Document" for a gadget built from
// a document blueprint), falling back to "App" when it declares no format. A worktree has no app
// and no bindings, so it gets only Code. A workflow has no app, so its first tab shows its triggers.
// With authored widgets on, a gadget with an app view also gets the build preview of its chat draft.
/** The tabs for the selected workpiece. */
export const rightTabs = (
  summary: WorkpieceSummary | undefined,
  outputView: 'app' | 'triggers',
  authoredWidgets: boolean,
): { value: RightTab; label: string }[] => {
  if (summary?.type === 'worktree') return [{ value: 'code', label: 'Code' }]
  return [
    { value: 'app', label: outputView === 'triggers' ? 'Triggers' : formatOf(summary?.output).noun },
    ...(authoredWidgets && outputView === 'app' ? [{ value: 'preview' as const, label: 'Build preview' }] : []),
    { value: 'code', label: 'Code' },
    { value: 'connections', label: 'Connections' },
  ]
}
