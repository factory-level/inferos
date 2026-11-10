import { useEffect, useState } from 'react'
import { Badge, Banner, Button, Select } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasPage } from '@gadgets/workshop-shared/canvas-model'
import type { ConsoleDraftProblem, OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateFlow } from '@gadgets/workshop-shared/operate-flow'
import { applyOperateEvent, INITIAL_OPERATE_PAGE, type OperateEvent, type OperatePageState } from '@gadgets/workshop-shared/operate-session'
import type { WorkspaceSettings } from '@gadgets/workshop-shared/workspace-settings'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { openDraftEvent, previewScreen, previewWidgetEvent, type PreviewNotice } from './draftPreview'
import { DraftPreviewPage } from './DraftPreviewPage'
import { DraftProblemsList } from './DraftProblemsList'

const ignore = () => {}

type Loaded = { draft: OperateConsole; flows: OperateFlow[]; workspace: WorkspaceSettings }

/**
 * A simulated preview of a console's draft (FAC-96), for its builder: the draft's own pages, laid
 * out as operators would get them, with nothing live. No connection is opened, no gadget code runs,
 * nothing is dispatched, and the published console and other operators are untouched. It reads only
 * the workspace's own draft (`getConsole`, `getConsolePage`, `listFlows`, `getWorkspaceConfiguration`),
 * the gadgets' `states.json` from git, and what would stop it publishing (`validateConsoleDraft`).
 * Navigation, flow routes and page states move the preview's own page through the same reducer
 * Operate uses (`applyOperateEvent`), kept here and never saved. An action says what it would
 * request instead of requesting it.
 */
export const ConsoleDraftPreview = ({ workspaceId, consoleId, onClose }: { workspaceId: string; consoleId: string; onClose: () => void }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer } = useWorkspaceOpen({ id: workspaceId, authenticatedApi, onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore })
  const { workpieces } = useWorkspaceWorkpieces(overseer, workspaceId)
  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)

  const [loaded, setLoaded] = useState<Loaded | { error: string } | null>(null)
  const [problems, setProblems] = useState<ConsoleDraftProblem[] | { error: string } | null>(null)
  const [check, setCheck] = useState(0)
  const [page, setPage] = useState<OperatePageState>(INITIAL_OPERATE_PAGE)
  const [pages, setPages] = useState<Map<string, CanvasPage | null>>(new Map())
  const [notices, setNotices] = useState<PreviewNotice[]>([])
  const stub = overseer?.stub

  useEffect(() => {
    if (!stub) return
    let current = true
    Promise.all([stub.getConsole(consoleId, 'draft'), stub.listFlows(), stub.getWorkspaceConfiguration()]).then(([draft, flows, configuration]) => {
      if (!current) return
      if (!draft) { setLoaded({ error: 'This console has no draft.' }); return }
      setLoaded({ draft, flows: flows.filter(flow => draft.flows?.includes(flow.id)), workspace: configuration.settings })
      if (draft.views.length > 0) setPage(applyOperateEvent(INITIAL_OPERATE_PAGE, openDraftEvent(workspaceId, draft)))
    }, (error: unknown) => { if (current) setLoaded({ error: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [stub, consoleId, workspaceId])

  useEffect(() => {
    if (!stub) return
    let current = true
    setProblems(null)
    stub.validateConsoleDraft(consoleId).then(
      list => { if (current) setProblems(list) },
      (error: unknown) => { if (current) setProblems({ error: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [stub, consoleId, check])

  const draft = loaded && 'draft' in loaded ? loaded.draft : null
  const screenId = draft ? previewScreen(draft, page) : null
  useEffect(() => {
    if (!stub || !screenId || pages.has(screenId)) return
    let current = true
    stub.getConsolePage(consoleId, screenId, 'draft').then(
      read => { if (current) setPages(previous => new Map(previous).set(screenId, read)) },
      () => { if (current) setPages(previous => new Map(previous).set(screenId, null)) })
    return () => { current = false }
  }, [stub, consoleId, screenId, pages])

  // The same reducer Operate uses, on the preview's own page; an event it refuses changes nothing.
  const move = (event: OperateEvent) => {
    try {
      setPage(applyOperateEvent(page, event))
    } catch (error) {
      setNotices([{ kind: 'not-shown', page: error instanceof Error ? error.message : String(error) }])
    }
  }
  const shown = screenId ? pages.get(screenId) : undefined
  const onEvent = (targetRef: string, event: string) => {
    if (!draft || !shown) return
    const result = previewWidgetEvent(shown, targetRef, event, draft, page)
    setNotices(result.notices)
    if (result.move) move(result.move)
  }
  const onRequest = (action: string) => setNotices([{ kind: 'would-request', action, target: 'this widget' }])

  if (!loaded) return <p aria-busy="true" className="p-6 text-sm text-kumo-subtle">Opening the draft preview…</p>
  if ('error' in loaded) return <div className="space-y-3 p-6 text-sm"><p role="alert" className="text-kumo-danger">Couldn’t open the draft preview: {loaded.error}</p>
    <Button size="sm" onClick={onClose}>Back to consoles</Button></div>

  const view = loaded.draft.views.find(candidate => candidate.id === page.console?.viewId)
  const flow = page.flow
  const flowPage = flow?.pages?.[flow.index]
  return <section aria-label={`Draft preview of ${loaded.draft.title}`} className="space-y-4 p-5">
    <Banner variant="secondary" title="Simulated preview of the draft"
      description="Nothing here is live: InferOps data isn’t read, widgets don’t run, and nothing is sent. Operators keep seeing the published console." />
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" onClick={onClose}>Back to consoles</Button>
      {!flow && loaded.draft.views.map(candidate => <Button key={candidate.id} size="sm" variant={candidate.id === view?.id ? 'primary' : 'secondary'}
        onClick={() => move({ type: 'openView', viewId: candidate.id })}>{candidate.title}</Button>)}
      {!flow && loaded.flows.length > 0 && <Select label="Run a flow" value="" renderValue={() => 'Choose a flow'} onValueChange={value => {
        const chosen = loaded.flows.find(item => item.id === value)
        if (chosen) move({ type: 'startFlow', workspaceId, flowId: chosen.id, title: chosen.title, steps: [...chosen.steps], ...(chosen.pages ? { pages: chosen.pages } : {}) })
      }}>{loaded.flows.map(item => <Select.Option key={item.id} value={item.id}>{item.title}</Select.Option>)}</Select>}
      {flow && <>
        <Badge variant="info">Flow: {flow.title}</Badge>
        {flowPage?.routes?.map(route => <Button key={route.to} size="sm" variant="secondary" onClick={() => move({ type: 'navigateFlow', to: route.to })}>{route.label}</Button>)}
        {flow.pages && (flow.history?.length ?? 0) > 0 && <Button size="sm" variant="secondary" onClick={() => move({ type: 'backFlow' })}>Back</Button>}
        {!flow.pages && flow.index + 1 < flow.steps.length && <Button size="sm" variant="secondary" onClick={() => move({ type: 'goToStep', index: flow.index + 1 })}>Next step</Button>}
        {flowPage?.states && flowPage.states.length > 1 && <Select label="Page state" value={flow.pageState ?? ''} renderValue={value => String(value || 'State')}
          onValueChange={value => { if (value) move({ type: 'setFlowPageState', state: String(value) }) }}>
          {flowPage.states.map(state => <Select.Option key={state} value={state}>{state}</Select.Option>)}</Select>}
        <Button size="sm" variant="ghost" onClick={() => move({ type: 'exitFlow' })}>Leave the flow</Button>
      </>}
    </div>
    {view?.type === 'rollup' && !page.console?.screenId && !flow && <div className="flex flex-wrap gap-2">
      {view.screens.map(id => <Button key={id} size="sm" variant="secondary" onClick={() => move({ type: 'showScreen', screenId: id })}>Open screen {id}</Button>)}
    </div>}
    {notices.map((notice, index) => <p key={index} role="status" className="text-sm text-kumo-default">
      {notice.kind === 'would-request'
        ? `Would request ${notice.action} of ${notice.target}: it would need the person’s own grant and approval. Nothing was sent.`
        : `Would move to ${notice.page}, which this console doesn’t show.`}
    </p>)}
    {screenId && shown === undefined && <p aria-busy="true" className="text-sm text-kumo-subtle">Reading screen {screenId}…</p>}
    {screenId && shown === null && <p role="alert" className="text-sm text-kumo-danger">Screen {screenId} isn’t part of this draft.</p>}
    {shown && <DraftPreviewPage page={shown} workspace={loaded.workspace} gadgets={gadgets} reader={stub!} onEvent={onEvent} onRequest={onRequest} />}
    <DraftProblemsList problems={problems} onCheck={() => setCheck(n => n + 1)} />
  </section>
}
