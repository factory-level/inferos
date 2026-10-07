import { useEffect, useState, type RefObject } from 'react'
import { Badge, Button, Loader } from '@cloudflare/kumo'
import { ArrowClockwise } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasWikiWidget as Widget } from '@gadgets/workshop-shared/canvas'
import type { WikiDocument } from '@inferos/gatekeeper-inferops/src/types'
import { CanvasBoardWidget } from './CanvasBoardWidget'
import { useWikiData } from './useWikiData'
import { WikiAgentText } from './WikiAgentText'
import { WikiIssueEmbed } from './WikiIssueEmbed'
import { WikiMarkdown } from './WikiMarkdown'
import { WikiNavigation } from './WikiNavigation'
import { WikiPageBody } from './WikiPageBody'
import { WikiSection } from './WikiSection'
import type { WikiStructureState } from './wikiData'
import { authoredBody, bodyEditable, firstNavigationPage, generatedBlock, pageText, parseWikiReference, wikiNavigation } from './wikiPage'

// A Master's generated block, from the structure read: labelled as generated, never editable here.
const GeneratedBlock = ({ document, structure, onOpenPage }: {
  document: WikiDocument
  structure: WikiStructureState
  onOpenPage: (slug: string) => void
}) => {
  if (structure.status === 'loading') {
    return <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Reading the pages this page lists…</p>
  }
  if (structure.status === 'error') {
    return <p role="alert" className="text-sm text-kumo-danger">Could not read the pages this page lists: {structure.message}</p>
  }
  const text = generatedBlock(document, structure.structure)
  return text === null ? null : <section aria-label="Generated page list" className="space-y-2 rounded-lg border border-dashed border-kumo-line p-3">
    <Badge variant="neutral">Generated from the Wiki structure, not editable</Badge>
    <WikiMarkdown text={text} onOpenPage={onOpenPage} />
  </section>
}

/**
 * One InferMind workspace's Wiki on the canvas: its navigation (the Wiki structure, or the page
 * tree for a Wiki that is not organized) and the chosen page as the page contract reads it: its
 * body as Markdown, else its sections, then a Master's generated page list. A board or issue
 * reference that stands alone as a paragraph shows live through the scope's board adapter, only
 * where the workspace holds its own connection to that board; a page reference or `/wiki/<slug>`
 * link of the same Wiki opens that page. With `editable`, the body (or, for a page without one, each
 * section) can be edited, the edit being a proposal through the approval path. The agent view shows
 * the page as an agent reads it.
 */
export const CanvasWikiWidget = ({ widget, overseer, editable, scrollRoot }: {
  widget: Widget
  scrollRoot?: RefObject<HTMLElement | null>
  overseer: RpcStub<Overseer>
  /**
   * Offer section edits. Only the workspace's own canvas passes it; an Operate session or flow
   * shows the Wiki read-only, as the Wiki is authored, not operated.
   */
  editable?: boolean
}) => {
  const { snapshot, data } = useWikiData(overseer, widget.targetRef)
  const [chosen, setChosen] = useState<string | null>(null)
  const [agentView, setAgentView] = useState(false)
  const { list, structure } = snapshot
  const organized = structure.status === 'ready' ? structure.structure : null
  const navigation = list.status === 'ready' ? wikiNavigation(list.documents, organized) : null
  // The default page waits for the structure read, so it does not jump from the tree's first page to the root.
  const slug = chosen ?? widget.params.page ?? (navigation && structure.status !== 'loading' ? firstNavigationPage(navigation) : null)
  const listed = list.status === 'ready' && slug !== null && list.documents.some(page => page.slug === slug)
  const page = slug === null ? undefined : snapshot.pages.get(slug)
  const host = new URL(data?.target ?? widget.targetRef).hostname
  // Read the shown page once the list says it exists; re-reads come from refreshes and decisions.
  useEffect(() => { if (listed && slug !== null) data?.openPage(slug) }, [data, listed, slug])

  const renderEmbed = (href: string, label: string) => {
    const reference = parseWikiReference(href)
    switch (reference.kind) {
      case 'board': return <CanvasBoardWidget scrollRoot={scrollRoot} overseer={overseer} presentation="card" widget={{ id: `wiki-${reference.boardRef}`,
        kind: 'inferops.project-board', version: 1, targetRef: reference.boardRef, size: 'full', params: { workflow: reference.workflow, showCompleted: false } }} />
      case 'issue': return <WikiIssueEmbed overseer={overseer} boardRef={reference.boardRef} identifier={reference.identifier} href={href} />
      case 'page': return reference.host === host
        ? <Button size="sm" onClick={() => setChosen(reference.slug)}>Open page: {label || reference.slug}</Button>
        : <p className="text-sm text-kumo-subtle">A page of another Wiki, not shown here: <code className="break-all">{href}</code></p>
      case 'unsupported': return <p className="text-sm text-kumo-subtle">{label || 'Embedded widget'}: this kind of reference is not shown on the canvas. <code className="break-all">{href}</code></p>
    }
  }

  const document = page?.status === 'ready' ? page.document : undefined
  const stale = list.status === 'ready' && (list.refreshing || list.error) || page?.status === 'ready' && (page.refreshing || page.error)
    || structure.status === 'ready' && (structure.refreshing || structure.error)
  const failed = (list.status === 'ready' ? list.error : undefined) ?? (page?.status === 'ready' ? page.error : undefined)
    ?? (structure.status === 'ready' ? structure.error : undefined)
  const body = document ? authoredBody(document) : null
  return <article aria-label={`InferMind Wiki ${widget.targetRef}`} className="flex min-w-0 flex-col rounded-lg border border-kumo-line bg-kumo-base">
    <header className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-kumo-default">{document ? document.title : 'InferMind Wiki'}</h3>
        <p className="truncate text-xs text-kumo-subtle" title={widget.targetRef}>{widget.targetRef}</p>
      </div>
      {stale && (failed ? <Badge variant="warning">Refresh failed</Badge>
        : <Badge variant="neutral" icon={<Loader size="sm" aria-label="" />}>Refreshing</Badge>)}
      <Button size="sm" aria-pressed={agentView} disabled={!document} onClick={() => setAgentView(value => !value)}>Agent view</Button>
      <Button size="sm" shape="square" variant="ghost" icon={ArrowClockwise} aria-label="Refresh Wiki"
        disabled={list.status === 'loading'} onClick={() => data?.refresh()} />
    </header>
    <div className="p-3">
      {list.status === 'loading' && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Loading the Wiki…</p>}
      {list.status === 'unbound' && <p className="text-sm text-kumo-subtle">
        Not connected. This workspace has no connection to this Wiki. Connect it, for example by asking in the chat, to read it here.
      </p>}
      {list.status === 'disabled' && <p role="status" className="text-sm text-kumo-subtle">
        {list.message} The connection to this Wiki is kept; it shows the Wiki again once InferOps is turned back on.
      </p>}
      {list.status === 'error' && <div className="space-y-2">
        <p role="alert" className="text-sm text-kumo-danger">
          {list.code === 'FORBIDDEN' || list.code === 'UNAUTHORIZED' ? 'No access to this Wiki' : 'Could not read the Wiki'}: {list.message}
        </p>
        <Button size="sm" onClick={() => data?.refresh()}>Try again</Button>
      </div>}
      {failed && <p role="alert" className="mb-2 text-xs text-kumo-danger">Showing the last read; refresh failed: {failed}</p>}
      {list.status === 'ready' && structure.status === 'error' && <p role="alert" className="mb-2 text-xs text-kumo-danger">
        Could not read how this Wiki is organized, so its pages are shown as a tree: {structure.message}
      </p>}
      {navigation && (list.status === 'ready' && list.documents.length === 0
        ? <p className="text-sm text-kumo-subtle">This Wiki has no pages you can open.</p>
        : <div className="flex flex-wrap gap-4">
          <nav aria-label="Wiki pages" className="w-full min-w-0 @3xl:w-56 @3xl:shrink-0">
            <WikiNavigation navigation={navigation} selected={slug} onSelect={setChosen} />
          </nav>
          <div className="min-w-0 flex-1 space-y-3">
            {slug === null && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Loading the Wiki…</p>}
            {slug !== null && !listed && <p role="status" className="text-sm text-kumo-subtle">
              The page {slug} is not in this Wiki, or you cannot open it. Choose another page.
            </p>}
            {listed && (!page || page.status === 'loading') && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Loading the page…</p>}
            {page?.status === 'missing' && <p role="status" className="text-sm text-kumo-subtle">This page has no section you can read, or it was deleted: {page.message}</p>}
            {page?.status === 'error' && <div className="space-y-2">
              <p role="alert" className="text-sm text-kumo-danger">Could not read the page: {page.message}</p>
              <Button size="sm" onClick={() => data?.refresh()}>Try again</Button>
            </div>}
            {document && <>
              {agentView && <WikiAgentText document={document} shownText={pageText(document, organized)} onRead={pageSlug => data?.readAgentText(pageSlug)
                ?? Promise.resolve({ ok: false, code: 'NOT_LOADED', message: 'The Wiki is not loaded.' })} />}
              <WikiPageBody key={document.id} document={document} edit={snapshot.bodyEdits.get(document.id)} renderEmbed={renderEmbed}
                onOpenPage={setChosen} onDismissEdit={() => data?.dismissBodyEdit(document.id)}
                onPropose={editable && data && bodyEditable(document) ? next => data.proposeBodyEdit(document, next) : undefined} />
              {/* A page with a body reads as its body; its sections are separate index text, not shown with it. */}
              {body === null && document.masterRole === null && document.sections.length === 0 &&
                <p className="text-sm text-kumo-subtle">This page has no sections.</p>}
              {body === null && document.sections.map(section => <WikiSection key={section.id} section={section} edit={snapshot.edits.get(section.id)}
                renderEmbed={renderEmbed} onOpenPage={setChosen} onDismissEdit={() => data?.dismissEdit(section.id)}
                onPropose={editable && data ? next => data.proposeEdit(document.slug, section, next) : undefined} />)}
              {document.masterRole !== null && <GeneratedBlock document={document} structure={structure} onOpenPage={setChosen} />}
            </>}
          </div>
        </div>)}
    </div>
  </article>
}
