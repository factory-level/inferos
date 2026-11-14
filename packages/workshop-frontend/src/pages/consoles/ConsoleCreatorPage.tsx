import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Badge, Button, Input, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { CollaboratorInfo, ConsoleAuthoring, OperateSession, Overseer } from '@gadgets/workshop-shared/api'
import { DEFAULT_CANVAS_CATALOG, type CanvasCatalog, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { ConsoleDraftProblem, ConsoleView, OperateConsole } from '@gadgets/workshop-shared/operate-console'
import { useAuthenticatedApi } from '../../AuthContext'
import ChatInterface from '../../ChatInterface'
import { getStoredSelectedModel } from '../../modelSelection'
import { CanvasWorkspacePane } from '../../features/canvas/CanvasWorkspacePane'
import { ConsoleViewEditor } from '../../features/operate/ConsoleViewEditor'
import { DraftProblemsList } from '../../features/operate/DraftProblemsList'
import { invalidateMyConsoles } from '../../features/operate/useMyConsoles'
import { useSessionWorkspace } from '../../features/operate/useSessionWorkspace'
import { useServerConfig } from '../../ServerConfigContext'

const NO_GADGETS = new Map<never, never>()
const noConsoleLogs = () => ''
const ignore = () => {}

/** What a console that belongs to no workspace may place: the deployment's catalog without what only a workspace holds. */
const consoleCatalog = (catalog: CanvasCatalog): CanvasCatalog =>
  ({ ...catalog, blueprints: [], widgetKinds: catalog.widgetKinds.filter(kind => kind !== 'inferos.gadget') })

const messageOf = (caught: unknown) => caught instanceof Error ? caught.message : String(caught)

/**
 * One console's creator (ADR 0021): its chat helper, its pages, and the console's own draft, checks,
 * publication and sharing. The helper is a Build chat bound to this console: it changes the same
 * pages and draft these controls do, as the person asking, and can't publish, share or delete. The console is opened by its own id through the person's
 * own access; no workspace is chosen, created or named. Boards and Wikis on a page preview through
 * the person's own operate session workspace, where their own connections are, exactly as they
 * will resolve for them in Operate.
 */
export const ConsoleCreatorPage = ({ consoleId, chatId, viewId, widgetId }: {
  consoleId: string
  /** The helper chat shown, if one has been started. */
  chatId: number | null
  /** The page open in the editor. */
  viewId: string | null
  /** A board widget of that page opened in its full view. */
  widgetId: string | null
}) => {
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const canvasFeatures = useServerConfig()?.canvasFeatures

  // Stubs are held inside objects: a stub is callable, which useState would call (see AGENTS.md).
  const [authoring, setAuthoring] = useState<{ stub: RpcStub<ConsoleAuthoring> } | null>(null)
  const [session, setSession] = useState<{ stub: RpcStub<OperateSession> } | null>(null)
  const [assistant, setAssistant] = useState<{ stub: RpcStub<Overseer>; id: string } | null>(null)
  const [request, setRequest] = useState('')
  const [openError, setOpenError] = useState<string | null>(null)
  const [draft, setDraft] = useState<OperateConsole | null>(null)
  const [title, setTitle] = useState('')
  const [views, setViews] = useState<ConsoleView[]>([])
  const [pages, setPages] = useState<readonly CanvasDefinition[]>([])
  const [problems, setProblems] = useState<ConsoleDraftProblem[] | { error: string } | null>(null)
  const [collaborators, setCollaborators] = useState<readonly CollaboratorInfo[]>([])
  const [invitee, setInvitee] = useState('')
  const [busy, setBusy] = useState(false)
  const sessionWorkspace = useSessionWorkspace(session)

  useEffect(() => {
    const stub = authenticatedApi.openConsoleAuthoring(consoleId)
    const operate = authenticatedApi.getOperateSession()
    // The person's own hidden console assistant, where this console's helper chats run.
    const host = authenticatedApi.openConsoleAssistant()
    let cancelled = false
    host.getMetadata().then(metadata => { if (!cancelled) setAssistant({ stub: host, id: metadata.id }) },
      caught => console.error('Failed to open the console assistant:', caught))
    Promise.all([stub.getConsole('draft'), stub.listCanvases(), stub.listCollaborators()]).then(([saved, canvases, people]) => {
      if (cancelled) return
      if (!saved) { setOpenError('This console is unavailable. It may have been removed.'); return }
      setAuthoring({ stub }); setSession({ stub: operate })
      setDraft(saved); setTitle(saved.title); setViews(saved.views); setPages(canvases); setCollaborators(people)
    }, caught => {
      console.error('Failed to open the console:', caught)
      if (!cancelled) setOpenError("This console can't be opened. You may not have access to it.")
    })
    return () => {
      cancelled = true
      stub[Symbol.dispose](); operate[Symbol.dispose](); host[Symbol.dispose]()
      setAuthoring(null); setSession(null); setAssistant(null)
    }
  }, [authenticatedApi, consoleId])

  const stub = authoring?.stub
  const check = useCallback(() => {
    if (!stub) return
    setProblems(null)
    stub.validateConsoleDraft().then(setProblems, caught => setProblems({ error: messageOf(caught) }))
  }, [stub])
  useEffect(() => { check() }, [check, draft?.revision])

  // The page editor keeps its own list; the outline reads the pages again when it is asked to.
  const refreshPages = () => { stub?.listCanvases().then(setPages, caught => console.error('Failed to list pages:', caught)) }

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true)
    try { await action() } catch (caught) {
      console.error(failure, caught)
      toasts.add({ title: messageOf(caught) || failure, variant: 'error' })
    } finally { setBusy(false) }
  }
  const save = () => run(async () => {
    if (!stub || !draft) return
    const saved = await stub.replaceConsole(draft.revision, { ...draft, title, views })
    setDraft(saved); setTitle(saved.title); setViews(saved.views)
    invalidateMyConsoles()
    toasts.add({ title: 'Draft saved. Operators see it once you publish.' })
  }, 'The draft could not be saved.')
  const publish = () => run(async () => {
    if (!stub || !draft) return
    const published = await stub.publishConsole(draft.revision)
    setDraft(published)
    invalidateMyConsoles()
    toasts.add({ title: `${published.title} is published.` })
  }, 'The console could not be published.')
  const share = () => run(async () => {
    if (!stub) return
    const added = await stub.addCollaborator(invitee.trim(), 'use')
    if (!added) throw new Error(`No account named ${invitee.trim()} was found.`)
    setInvitee(''); setCollaborators(await stub.listCollaborators())
  }, 'The console could not be shared.')
  const unshare = (profileId: string) => run(async () => {
    if (!stub) return
    await stub.removeCollaborator(profileId)
    setCollaborators(await stub.listCollaborators())
  }, 'That person could not be removed.')

  const showChat = (chat: number | null, options?: { replace?: boolean }) => navigate({
    to: '/consoles/$id', params: { id: consoleId }, replace: options?.replace,
    search: (previous: Record<string, unknown>) => ({ ...previous, chat: chat ?? undefined }),
  })
  // Starts a helper chat bound to this console, with the person's last-chosen model.
  const askHelper = async (text: string) => {
    if (!assistant) { toasts.add({ title: 'The chat helper is still opening. Try again in a moment.', variant: 'error' }); return }
    try {
      const modelId = getStoredSelectedModel(await assistant.stub.listModels())
      if (!modelId) { toasts.add({ title: 'Add a model in your profile first, then ask again.', variant: 'error' }); return }
      await showChat(await assistant.stub.newConsoleAssistantChat(consoleId, text, modelId))
      setRequest('')
    } catch (caught) {
      console.error('Failed to start the chat helper:', caught)
      toasts.add({ title: messageOf(caught), variant: 'error' })
    }
  }
  // While a helper chat is shown, its edits to the draft and pages appear here without a reload,
  // unless the person has unsaved changes of their own in the outline.
  const helping = chatId !== null
  const untouched = !!draft && title === draft.title && JSON.stringify(views) === JSON.stringify(draft.views)
  const revision = draft?.revision
  useEffect(() => {
    if (!stub || !helping || !untouched) return
    const timer = setInterval(() => {
      Promise.all([stub.getConsole('draft'), stub.listCanvases()]).then(([saved, canvases]) => {
        setPages(canvases)
        if (saved && saved.revision !== revision) { setDraft(saved); setTitle(saved.title); setViews(saved.views); invalidateMyConsoles() }
      }, caught => console.error('Failed to refresh the console:', caught))
    }, 4000)
    return () => clearInterval(timer)
  }, [stub, helping, untouched, revision])

  const select = (search: { view?: string | null; widget?: string | null }, replace: boolean) => navigate({
    to: '/consoles/$id', params: { id: consoleId }, replace,
    search: (previous: Record<string, unknown>) => ({ ...previous,
      ...('view' in search ? { view: search.view ?? undefined, widget: undefined } : {}),
      ...('widget' in search ? { widget: search.widget ?? undefined } : {}) }),
  })

  if (openError) return <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 text-center">
    <p role="alert" className="max-w-lg text-sm text-kumo-danger">{openError}</p>
    <Link to="/consoles" className="text-sm text-kumo-brand">Back to consoles</Link>
  </div>
  if (!canvasFeatures?.durableViews) return <p role="status" className="p-6 text-sm text-kumo-subtle">Saved views are not enabled for this deployment.</p>
  if (!stub || !draft || !sessionWorkspace) return <p role="status" className="p-6 text-sm text-kumo-subtle">Opening the console…</p>

  const dirty = title !== draft.title || JSON.stringify(views) !== JSON.stringify(draft.views)
  const unpublished = draft.published === null ? 'Draft' : draft.published.revision !== draft.revision ? 'Unpublished changes' : 'Published'
  const blocked = Array.isArray(problems) ? problems.length > 0 : true
  return <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
    <header className="flex min-h-14 flex-shrink-0 flex-wrap items-center gap-3 border-b border-kumo-line px-4 py-2">
      <Link to="/consoles" className="flex min-w-0 items-center gap-2 text-sm text-kumo-subtle hover:text-kumo-default">
        <ArrowLeft size={16} aria-hidden /><span className="truncate">Consoles</span>
      </Link>
      <h1 className="min-w-0 truncate text-sm font-medium text-kumo-default">{draft.title}</h1>
      <Badge variant={unpublished === 'Published' ? 'success' : unpublished === 'Draft' ? 'secondary' : 'warning'}>{unpublished}</Badge>
      <div className="ml-auto flex gap-2">
        <Button size="sm" disabled={busy || !dirty || title.trim().length === 0 || views.length === 0} onClick={() => void save()}>Save draft</Button>
        <Button size="sm" variant="primary" disabled={busy || dirty || blocked || unpublished === 'Published'}
          title={dirty ? 'Save the draft first' : blocked ? 'Fix what stops publishing first' : undefined} onClick={() => void publish()}>Publish</Button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <section aria-label="Chat helper" className="flex min-h-0 w-full flex-shrink-0 flex-col border-b border-kumo-line lg:w-80 lg:border-b-0 lg:border-r">
        {chatId !== null && assistant
          ? <ChatInterface key={`${assistant.id}/${chatId}`} workspaceId={assistant.id} overseer={assistant.stub} selectedChatId={chatId}
              onNavigateToChat={showChat} pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
              onConsumeConsoleLogs={noConsoleLogs} onDiscardConsoleLogs={ignore} constrainChatWidth
              onOpenGadget={ignore} outputOfWorkpiece={() => undefined} />
          : <form className="space-y-3 p-4" onSubmit={event => { event.preventDefault(); void askHelper(request.trim()) }}>
              <p className="text-sm font-medium text-kumo-default">Chat helper</p>
              <p className="text-sm text-kumo-subtle">Say what this console needs, for example a page with a board. The helper changes this console's pages and draft only, and never publishes.</p>
              <Input label="Ask the helper" value={request} maxLength={2000} onChange={event => setRequest(event.target.value)} />
              <Button type="submit" size="sm" disabled={request.trim().length === 0}>Ask</Button>
            </form>}
      </section>
      <main aria-label="Pages" className="min-h-0 min-w-0 flex-1 overflow-auto">
        <CanvasWorkspacePane key={consoleId} storage={{ kind: 'durable', api: stub }} overseer={sessionWorkspace.stub} gadgets={NO_GADGETS}
          catalog={consoleCatalog(canvasFeatures.catalog ?? DEFAULT_CANVAS_CATALOG)} pagesOnly
          viewId={viewId} onViewChange={view => void select({ view }, true)}
          openWidgetId={widgetId} onOpenWidgetChange={widget => void select({ widget }, widget === null)}
          onAskAgent={askHelper} />
      </main>
      <aside aria-label="Console" className="w-full flex-shrink-0 space-y-6 overflow-auto border-t border-kumo-line p-4 lg:w-96 lg:border-l lg:border-t-0">
        <section aria-label="Name and navigation" className="space-y-4">
          <Input label="Console name" value={title} required maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)} />
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-kumo-default">Navigation</p>
            <Button size="sm" variant="ghost" onClick={refreshPages}>Refresh pages</Button>
          </div>
          <ConsoleViewEditor views={views} screens={pages} onChange={setViews} />
        </section>
        <DraftProblemsList problems={problems} onCheck={check} />
        <section aria-label="Sharing" className="space-y-3">
          <p className="text-sm font-medium text-kumo-default">Shared with</p>
          {collaborators.length === 0 && <p className="text-sm text-kumo-subtle">Only you. Add the people who operate this console.</p>}
          <ul className="space-y-1">
            {collaborators.map(person => <li key={person.profile.id} className="flex items-center gap-2 text-sm text-kumo-default">
              <span className="min-w-0 flex-1 truncate">{person.profile.name}</span>
              <span className="text-xs text-kumo-subtle">{person.role === 'build' ? 'Can edit' : 'Can operate'}</span>
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${person.profile.name}`} onClick={() => void unshare(person.profile.id)}>Remove</Button>
            </li>)}
          </ul>
          <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); void share() }}>
            <div className="min-w-0 flex-1"><Input label="Add an operator by account name" value={invitee} disabled={busy}
              onChange={event => setInvitee(event.target.value)} /></div>
            <Button type="submit" size="sm" disabled={busy || invitee.trim().length === 0}>Add</Button>
          </form>
        </section>
      </aside>
    </div>
  </div>
}
