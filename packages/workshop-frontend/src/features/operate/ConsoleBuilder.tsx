import { useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import { ChatsCircleIcon, LayoutIcon } from '@phosphor-icons/react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { DEFAULT_CANVAS_CATALOG, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { DEFAULT_CONSOLE_CUSTOMIZATION, MAX_CONSOLE_VIEWS, MAX_WORKSPACE_CONSOLES, parseOperateConsoleContent, type ConsoleFullChat, type ConsoleView } from '@gadgets/workshop-shared/operate-console'
import { useAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { invalidateWorkspaceScreens, type WorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { ConsoleScreenEditor } from './ConsoleScreenEditor'
import { ConsoleViewEditor } from './ConsoleViewEditor'
import { consoleScreens } from '@gadgets/workshop-shared/operate-console'
import type { ConsoleEntry } from './consoles'

const ignore = () => {}
const START_LABELS: Record<ConsoleFullChat, string> = { default: 'Assistant first', available: 'A view first, with Assistant', off: 'A view first, with side chat only', only: 'Assistant only' }
const STEPS = ['Basics', 'Screens and views', 'Starting experience', 'Review']

/** Human-authored console setup uses the workspace's build capability, never the Operate agent. */
export const ConsoleBuilder = ({ workspaces, initial, onCancel, onSaved }: {
  workspaces: readonly WorkspaceScreens[]
  initial?: ConsoleEntry
  onCancel: () => void
  onSaved: (entry: ConsoleEntry) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const catalog = useServerConfig()?.canvasFeatures?.catalog ?? DEFAULT_CANVAS_CATALOG
  const [workspaceId, setWorkspaceId] = useState(initial?.workspace.id ?? (workspaces.length === 1 ? workspaces[0].workspace.id : ''))
  const [title, setTitle] = useState(initial?.console.title ?? '')
  const [views, setViews] = useState<ConsoleView[]>(() => structuredClone(initial?.console.views ?? []))
  const [fullChat, setFullChat] = useState<ConsoleFullChat>(initial?.console.fullChat ?? 'default')
  const [step, setStep] = useState(0)
  const [creatingScreen, setCreatingScreen] = useState(false)
  const [addedScreens, setAddedScreens] = useState<CanvasDefinition[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const entry = workspaces.find(item => item.workspace.id === workspaceId)
  const { overseer, metadata, error: openError, observerConfig } = useWorkspaceOpen({
    id: workspaceId || undefined, authenticatedApi, onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore,
  })
  const { workpieces, ready } = useWorkspaceWorkpieces(overseer, workspaceId)
  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)
  const screens = [...new Map([...(entry?.screens ?? []), ...addedScreens].map(screen => [screen.id, screen])).values()]
  const available = !!overseer && ready && metadata?.id === workspaceId && metadata.role !== 'use' && !openError && !observerConfig
  const limitReached = !initial && (entry?.consoles.length ?? 0) >= MAX_WORKSPACE_CONSOLES
  const validate = () => {
    const content = parseOperateConsoleContent({ title, views, fullChat, customization: initial?.console.customization ?? { ...DEFAULT_CONSOLE_CUSTOMIZATION } })
    if (consoleScreens(content).some(id => !screens.some(screen => screen.id === id))) throw new Error('Choose an available screen for every view.')
    return content
  }
  const next = () => {
    try {
      if (step === 1) validate()
      setError(null); setStep(step + 1)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check the console setup.') }
  }
  const save = async () => {
    if (!overseer || saving || !available) return
    setSaving(true); setError(null)
    try {
      const content = validate()
      const saved = initial
        ? await overseer.stub.replaceConsole(initial.console.id, initial.console.revision, content)
        : await overseer.stub.createConsole(content)
      invalidateWorkspaceScreens()
      onSaved({ workspace: entry!.workspace, console: saved, screens })
    } catch (caught) {
      console.error('Console save failed:', caught)
      setError('Could not save this console. Check your access and fields. If it changed elsewhere, reopen it to review the latest version. Your draft is still here.')
    } finally { setSaving(false) }
  }
  return <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-8">
    <header className="flex items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold text-kumo-default">{initial ? 'Edit console' : 'New console'}</h1>
        <p className="mt-1 text-sm text-kumo-subtle">Your assistant and screens, in one workspace.</p></div>
      <Button disabled={saving || creatingScreen} onClick={() => setConfirmCancel(true)}>Cancel</Button>
    </header>
    {confirmCancel && <div role="alert" className="space-y-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
      <p className="text-sm text-kumo-default">Discard console changes? Screens you already saved will remain available.</p>
      <div className="flex gap-2"><Button onClick={onCancel}>Discard changes</Button><Button variant="primary" onClick={() => setConfirmCancel(false)}>Keep editing</Button></div>
    </div>}
    <ol aria-label="Console setup steps" className="flex flex-wrap gap-4 border-b border-kumo-line pb-4">
      {STEPS.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}
        className={`text-sm ${index === step ? 'font-medium text-kumo-default' : 'text-kumo-subtle'}`}>{index + 1}. {label}</li>)}
    </ol>
    {step === 0 && <div className="space-y-5">
      <Input label="Console name" placeholder="e.g. Operations" value={title} required maxLength={120} onChange={event => setTitle(event.target.value)} />
      <Select label="Workspace" value={workspaceId} disabled={!!initial} placeholder="Choose a workspace"
        renderValue={value => workspaces.find(item => item.workspace.id === value)?.workspace.title ?? 'Choose a workspace'}
        onValueChange={value => { setWorkspaceId(String(value)); setViews([]); setAddedScreens([]); setError(null) }}>
        {workspaces.map(item => <Select.Option key={item.workspace.id} value={item.workspace.id}>{item.workspace.title || 'Untitled workspace'}</Select.Option>)}
      </Select>
      <p className="text-sm text-kumo-subtle">Choose where this console’s screens and widgets live.</p>
      {workspaces.length === 0 && <p className="text-sm text-kumo-subtle">Create a workspace in Build first, then return here to set up a console.</p>}
      {workspaceId && (openError || observerConfig || metadata?.role === 'use') && <p role="alert" className="text-sm text-kumo-danger">This workspace is not ready for setup. Open it in Build to check your access and connections.</p>}
      {limitReached && <p role="alert" className="text-sm text-kumo-danger">This workspace already has {MAX_WORKSPACE_CONSOLES} consoles. Choose another workspace.</p>}
    </div>}
    {step === 1 && <div className="space-y-5">
      <div><h2 className="font-medium text-kumo-default">Build your navigation</h2><p className="mt-1 text-sm text-kumo-subtle">Reuse pages from this workspace in any console, then arrange their navigation.</p></div>
      {creatingScreen && overseer
        ? <ConsoleScreenEditor key={workspaceId} overseer={overseer.stub} gadgets={gadgets} catalog={catalog}
            onCancel={() => setCreatingScreen(false)} onSaved={screen => {
              setAddedScreens(previous => [...previous, screen]); setCreatingScreen(false)
              setViews(previous => [...previous, { id: crypto.randomUUID(), type: 'screen', title: screen.title, screen: screen.id }])
            }} />
        : <>
            <ConsoleViewEditor views={views} screens={screens} onChange={setViews} />
            <Button disabled={!available || views.length >= MAX_CONSOLE_VIEWS} onClick={() => setCreatingScreen(true)}>Create a new screen</Button>
          </>}
    </div>}
    {step === 2 && <div className="space-y-5">
      <h2 className="font-medium text-kumo-default">What opens first?</h2>
      <Select label="Starting experience" value={fullChat} renderValue={value => START_LABELS[value as ConsoleFullChat]} onValueChange={value => setFullChat(value as ConsoleFullChat)}>
        <Select.Option value="default">Assistant first</Select.Option>
        <Select.Option value="available">A view first, with Assistant</Select.Option>
        <Select.Option value="off">A view first, with side chat only</Select.Option>
        {initial?.console.fullChat === 'only' && <Select.Option value="only">Assistant only</Select.Option>}
      </Select>
      <p className="text-sm text-kumo-subtle">Assistant opens a centered conversation. Choosing a screen docks the same conversation beside your work.</p>
      {fullChat !== 'only' && <Select label="Default view" value={views[0]?.id ?? ''} renderValue={value => views.find(view => view.id === value)?.title ?? 'Choose a view'}
        onValueChange={value => { const selected = views.find(view => view.id === value); if (selected) setViews([selected, ...views.filter(view => view.id !== value)]) }}>
        {views.map(view => <Select.Option key={view.id} value={view.id}>{view.title}</Select.Option>)}
      </Select>}
      {fullChat === 'only' && <p className="text-sm text-kumo-subtle">This console keeps its saved views, but only shows Assistant.</p>}
    </div>}
    {step === 3 && <section aria-label="Console preview" className="overflow-hidden rounded-xl border border-kumo-line">
      <div className="border-b border-kumo-line px-5 py-3 font-medium text-kumo-default">{title}</div>
      <div className="flex min-h-64">
        <div className="w-40 shrink-0 space-y-2 bg-kumo-elevated p-4 text-sm text-kumo-subtle">
          {fullChat !== 'off' && <p className="flex items-center gap-2"><ChatsCircleIcon aria-hidden />Assistant</p>}
          {fullChat !== 'only' && views.map(view => <p className="flex items-center gap-2" key={view.id}><LayoutIcon className="shrink-0" aria-hidden /><span className="truncate">{view.title}</span></p>)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
          <p className="font-medium text-kumo-default">{fullChat === 'default' || fullChat === 'only' ? 'How can I help?' : views[0]?.title}</p>
          <p className="text-sm text-kumo-subtle">{fullChat === 'default' || fullChat === 'only' ? 'Starts with your shared assistant conversation' : 'Starts with this view and side chat'}</p>
          <p className="text-xs text-kumo-subtle">{views.length} views · {new Set(views.flatMap(view => view.type === 'screen' ? [view.screen] : view.screens)).size} screens</p>
        </div>
      </div>
    </section>}
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    {!creatingScreen && <footer className="flex items-center justify-between border-t border-kumo-line pt-4">
      <Button disabled={step === 0 || saving} onClick={() => { setStep(step - 1); setError(null) }}>Back</Button>
      {step < STEPS.length - 1
        ? <Button variant="primary" disabled={!title.trim() || !workspaceId || !available || limitReached || (step === 1 && views.length === 0)} onClick={next}>Continue</Button>
        : <Button variant="primary" disabled={saving || !available} onClick={() => void save()}>{saving ? 'Saving…' : initial ? 'Save console' : 'Create console'}</Button>}
    </footer>}
  </div>
}
