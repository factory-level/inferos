import { useCallback, useState } from 'react'
import { Button, Checkbox } from '@cloudflare/kumo'
import { canonicalHostBoardTarget, consoleScreens, DEFAULT_CONSOLE_CUSTOMIZATION, type BoundViewEntry, type HostBoardEntry } from '@gadgets/workshop-shared/operate-console'
import { parseWidgetToolFile, WIDGET_TOOLS_FILE } from '@gadgets/workshop-shared/widget-tools'
import type { BoardConnection } from './ConsoleCommandBindings'
import { useServerConfig } from '../../ServerConfigContext'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { invalidateWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { consoleContentForSave, type ConsoleEntry } from './consoles'
import { ConsoleBoundViewRegistry } from './ConsoleBoundViewRegistry'
import { ConsoleHostBoardRegistry } from './ConsoleHostBoardRegistry'
import { ConsolePlacedAppsNotice } from './ConsolePlacedAppsNotice'
import { usePublishedConsolePlacements } from './usePublishedConsolePlacements'
import { ConsoleWidgetIndex } from './ConsoleWidgetIndex'
import { ConsoleWidgetRegistry } from './ConsoleWidgetRegistry'
import { useConsoleWidgetCandidates } from './useConsoleWidgetCandidates'

const ignore = () => {}
const options = [
  { key: 'screens', title: 'Personal, shareable screens', description: 'Allow users to create their own screens for this console.' },
  { key: 'widgets', title: 'Custom widgets', description: 'Allow users to add their own widgets.' },
  { key: 'tools', title: 'Application tools', description: 'Allow users to add application tools.' },
  { key: 'skills', title: 'Custom skills', description: 'Allow users to add skills for the assistant.' },
] as const

/** Console policy and widgets are saved through the existing build capability, with revision conflict checks. */
export const ConsoleSettings = ({ entry, onClose, onEdit, onOpenBuild }: {
  entry: ConsoleEntry
  onClose: () => void
  onEdit: () => void
  /** Leaves Operate for the configuration workspace (Build). */
  onOpenBuild: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer, metadata, error: accessError } = useWorkspaceOpen({ id: entry.workspace.id, authenticatedApi,
    onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore })
  const [customization, setCustomization] = useState(entry.console.customization ?? { ...DEFAULT_CONSOLE_CUSTOMIZATION })
  const [widgets, setWidgets] = useState(entry.console.widgets ?? [])
  // Undefined until edited: the saved boards are then kept as they are (see `consoleContentForSave`).
  const [hostBoards, setHostBoards] = useState<HostBoardEntry[] | undefined>(undefined)
  const shownHostBoards = hostBoards ?? entry.console.hostBoards ?? []
  // Likewise for bound views; saved ones count toward the shared limit even while bound views are off.
  const [boundViews, setBoundViews] = useState<BoundViewEntry[] | undefined>(undefined)
  const shownBoundViews = boundViews ?? entry.console.boundViews ?? []
  const serverConfig = useServerConfig()
  const hostBoardsOn = serverConfig?.hostBoards === true
  const boundViewsOn = hostBoardsOn && serverConfig?.boundViews === true
  const { workpieces } = useWorkspaceWorkpieces(overseer, entry.workspace.id)
  const candidates = [...workpieces.values()].flatMap(piece => piece.type === 'gadget' && piece.chatId === undefined &&
    !piece.frozenFor && piece.installedFrom?.kind === 'widget' ? [piece] : [])
  const widgetCandidates = useConsoleWidgetCandidates(overseer, candidates)
  // A console published before apps were fenced lists none; its published pages say which it places.
  const legacyPublication = entry.console.published && entry.console.published.apps === undefined ? entry.console.published : null
  const placed = usePublishedConsolePlacements(overseer?.stub, entry.console.id,
    legacyPublication ? consoleScreens(legacyPublication.content) : [], legacyPublication !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editable = !!overseer && !!metadata && metadata.role !== 'use' && !accessError
  // FAC-14: what binding a widget's declared commands reads. Stable per overseer, since each read is
  // an effect's dependency. A command is declared in the commit's tools.json; a board resolves only
  // through this workspace's own connections (getGatekeeperByResourceUrl), and only an InferOps
  // board connection is offered. Publication checks every binding again.
  const stub = overseer?.stub
  const loadCommands = useCallback(async (commitId: string) => {
    if (!stub) return []
    const [[, file] = ['', { kind: 'absent' as const }]] = await stub.readFilesAtCommit(commitId, [WIDGET_TOOLS_FILE])
    return file.kind === 'text' ? parseWidgetToolFile(file.text).commands : []
  }, [stub])
  const resolveBoard = useCallback(async (target: string): Promise<BoardConnection | null> => {
    if (!stub) return null
    const connection = await stub.getGatekeeperByResourceUrl(target)
    if (!connection) return null
    try {
      const [gatekeeperId, spec] = await Promise.all([connection.getId(), connection.getCreationSpec()])
      return spec.type === 'gatekeeper' && spec.vendorId.toLowerCase() === 'inferops' &&
        canonicalHostBoardTarget(spec.resourceUrl) === target ? { gatekeeperId, target } : null
    } finally {
      connection[Symbol.dispose]()
    }
  }, [stub])
  const boardTargets = shownHostBoards.map(board => board.requirement.target)
  const save = async () => {
    if (!overseer || !editable || saving) return
    setSaving(true); setError(null)
    try {
      await overseer.stub.replaceConsole(entry.console.id, entry.console.revision, consoleContentForSave({ title: entry.console.title, views: entry.console.views, fullChat: entry.console.fullChat, customization,
        ...(widgets.length > 0 || entry.console.widgets ? { widgets } : {}) }, entry.console.hostBoards, hostBoards,
        { saved: entry.console.boundViews, edited: boundViews }))
      invalidateWorkspaceScreens()
      onClose()
    } catch {
      setError('Could not save settings. Your choices are still here. Check your access, that every widget on the console\'s screens is registered, or reopen settings if someone else changed this console.')
    } finally { setSaving(false) }
  }
  return <section className="mx-auto w-full max-w-2xl space-y-8 px-6 py-10" aria-label="Console settings">
    <header className="flex items-start justify-between gap-4"><div>
      <h1 className="text-xl font-semibold text-kumo-default">Settings</h1>
      <p className="mt-1 text-sm text-kumo-subtle">{entry.console.title}</p>
    </div><Button variant="ghost" disabled={saving} onClick={onClose}>Done</Button></header>
    <ConsolePlacedAppsNotice published={entry.console.published} placed={placed} workpieces={workpieces} consoleTitle={entry.console.title} />
    <div className="space-y-5">
      <div><h2 className="text-sm font-medium text-kumo-default">User customization</h2>
        <p className="mt-1 text-sm text-kumo-subtle">Personal additions leave the shared pages unchanged. Pages can be reused across consoles. Settings save to the draft; operators get them when you publish.</p></div>
      {options.map(option => <div key={option.key} className="space-y-1">
        <Checkbox label={option.title} checked={customization[option.key]} disabled={!editable || saving}
          onCheckedChange={checked => setCustomization({ ...customization, [option.key]: checked })} />
        <p className="pl-6 text-sm text-kumo-subtle">{option.description}</p>
      </div>)}
      {!editable && <p role="status" className="text-sm text-kumo-subtle">Console owners and editors manage these settings.</p>}
    </div>
    <ConsoleWidgetRegistry widgets={widgets} published={entry.console.published?.content.widgets} candidates={widgetCandidates}
      hostBoardCount={shownHostBoards.length + shownBoundViews.length} disabled={!editable || saving}
      commands={stub ? { boardTargets, editable, loadCommands, resolveBoard } : undefined} onChange={setWidgets} />
    {overseer && <ConsoleWidgetIndex overseer={overseer.stub} consoleId={entry.console.id}
      hasWidgets={(entry.console.published?.content.widgets ?? []).length > 0} editable={editable} />}
    {hostBoardsOn && <ConsoleHostBoardRegistry hostBoards={shownHostBoards} published={entry.console.published?.content.hostBoards}
      widgetCount={widgets.length + shownBoundViews.length} assistantOnly={entry.console.fullChat === 'only'} disabled={!editable || saving} onChange={setHostBoards} />}
    {boundViewsOn && <ConsoleBoundViewRegistry boundViews={shownBoundViews} published={entry.console.published?.content.boundViews}
      candidates={candidates} hostBoards={shownHostBoards} otherCount={widgets.length + shownHostBoards.length}
      assistantOnly={entry.console.fullChat === 'only'} disabled={!editable || saving} onChange={setBoundViews} />}
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    {editable && <>
      <Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</Button>
      <div className="flex flex-wrap items-center gap-3 border-t border-kumo-line pt-5">
        <Button disabled={saving} onClick={onEdit}>Edit pages and starting screen</Button>
        <button type="button" onClick={onOpenBuild} className="cursor-pointer rounded-md text-sm text-kumo-subtle underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Open configuration workspace</button>
      </div>
    </>}
  </section>
}
