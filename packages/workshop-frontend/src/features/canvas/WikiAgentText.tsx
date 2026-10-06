import { useEffect, useState } from 'react'
import { Badge, Loader } from '@cloudflare/kumo'
import type { WikiDocument } from '@inferos/gatekeeper-inferops/src/types'
import type { AgentTextResult } from './wikiData'

/**
 * The page as an agent reads it (`readDocumentText` through the same connection), beside a
 * comparison with the page shown, so a person can check the agent sees what they see. It is read
 * when shown and again whenever the page read changes; each read is an observation in the action
 * log.
 */
export const WikiAgentText = ({ document, shownText, onRead }: {
  document: WikiDocument
  /**
   * The page shown, as the page contract composes it (`pageText`); null when it cannot be composed
   * here (a Master whose structure is not read), and then nothing is compared.
   */
  shownText: string | null
  onRead: (slug: string) => Promise<AgentTextResult>
}) => {
  const [result, setResult] = useState<{ document: WikiDocument; value: AgentTextResult } | null>(null)
  useEffect(() => {
    let cancelled = false
    void onRead(document.slug).then(value => { if (!cancelled) setResult({ document, value }) })
    return () => { cancelled = true }
  // A new read of the page (a refresh, a decided edit) is a new document object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document])
  const current = result?.document === document ? result.value : null
  const compared = current?.ok === true && shownText !== null
  const matches = compared && current.text === shownText
  return <section aria-label="Agent view" className="space-y-2 rounded-lg border border-kumo-line p-3">
    <div className="flex flex-wrap items-center gap-2">
      <h4 className="text-sm font-medium text-kumo-default">What an agent reads</h4>
      {compared && <Badge variant={matches ? 'success' : 'warning'}>{matches ? 'Same as this page' : 'Differs from this page'}</Badge>}
    </div>
    {!current && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Reading the agent text…</p>}
    {current && !current.ok && <p role="alert" className="text-sm text-kumo-danger">Could not read the agent text: {current.message}</p>}
    {compared && !matches && <p className="text-xs text-kumo-subtle">The page changed between the two reads. Refresh to compare again.</p>}
    {current?.ok && shownText === null && <p className="text-xs text-kumo-subtle">Not compared: the Wiki structure this page lists is not read here.</p>}
    {current?.ok && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-kumo-elevated p-2 font-mono text-xs text-kumo-default">{current.text}</pre>}
  </section>
}
