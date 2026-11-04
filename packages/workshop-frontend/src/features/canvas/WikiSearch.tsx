import { useRef, useState } from 'react'
import { Badge, Button, Input, Loader } from '@cloudflare/kumo'
import { MagnifyingGlass } from '@phosphor-icons/react'
import type { WikiSearchResult } from './wikiData'
import { snippetParts } from './wikiSnippet'

type Searched = { status: 'idle' } | { status: 'searching'; query: string } | { status: 'done'; query: string; result: WikiSearchResult }

/** The longest query InferOps searches, after trimming. */
const MAX_QUERY = 500

/**
 * Search one Wiki and open a result's page. Results are the sections the connection's sign-in can
 * read, best first; a snippet is shown as text with InferOps' matched words marked, never as HTML.
 * A search that could not run says "search unavailable" and offers a retry: it never reads as no
 * results.
 */
export const WikiSearch = ({ onSearch, onOpenPage }: {
  onSearch: (query: string) => Promise<WikiSearchResult>
  onOpenPage: (slug: string) => void
}) => {
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState<Searched>({ status: 'idle' })
  // Only the newest search's answer lands, however the answers arrive.
  const latest = useRef(0)
  const trimmed = query.trim()

  const run = async (text: string) => {
    const id = ++latest.current
    setSearched({ status: 'searching', query: text })
    const result = await onSearch(text)
    if (id === latest.current) setSearched({ status: 'done', query: text, result })
  }

  return <div className="space-y-2">
    <form role="search" aria-label="Search this Wiki" className="flex items-end gap-2"
      onSubmit={event => { event.preventDefault(); if (trimmed) void run(trimmed) }}>
      <div className="min-w-0 flex-1">
        <Input aria-label="Search this Wiki" placeholder="Search this Wiki" value={query} maxLength={MAX_QUERY}
          onChange={event => setQuery(event.target.value)} />
      </div>
      <Button size="sm" type="submit" icon={MagnifyingGlass} disabled={!trimmed || searched.status === 'searching'}>Search</Button>
    </form>
    {searched.status === 'searching' && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Searching…</p>}
    {searched.status === 'done' && <SearchResults searched={searched} onOpenPage={onOpenPage}
      onRetry={() => void run(searched.query)} onClear={() => setSearched({ status: 'idle' })} />}
  </div>
}

const SearchResults = ({ searched, onOpenPage, onRetry, onClear }: {
  searched: Extract<Searched, { status: 'done' }>
  onOpenPage: (slug: string) => void
  onRetry: () => void
  onClear: () => void
}) => {
  const { query, result } = searched
  const clear = <Button size="sm" variant="ghost" onClick={onClear}>Clear search</Button>
  if (!result.ok) {
    return <div className="space-y-2">
      <p role="alert" className="text-sm text-kumo-danger">
        {result.code === 'UNAVAILABLE' ? 'Search unavailable, so this is not an empty result' : 'Could not search this Wiki'}: {result.message}
      </p>
      <div className="flex gap-2">{result.code === 'UNAVAILABLE' && <Button size="sm" onClick={onRetry}>Try again</Button>}{clear}</div>
    </div>
  }
  if (result.hits.length === 0) {
    return <div className="space-y-2">
      <p role="status" className="text-sm text-kumo-subtle">No section you can read matches “{query}”.</p>
      {clear}
    </div>
  }
  return <div className="space-y-2">
    <p role="status" className="text-xs text-kumo-subtle">{result.hits.length} section{result.hits.length === 1 ? '' : 's'} match “{query}”, best first.</p>
    <ul aria-label="Search results" className="space-y-1">
      {result.hits.map(hit => <li key={hit.sectionId}>
        <Button size="sm" variant="ghost" className="h-auto w-full flex-col items-start gap-0.5 py-1 text-left"
          aria-label={`Open ${hit.documentTitle}, section ${hit.tag}`} onClick={() => onOpenPage(hit.documentSlug)}>
          <span className="flex w-full items-center gap-2">
            <span className="truncate font-medium text-kumo-default">{hit.documentTitle}</span>
            <span className="truncate text-xs text-kumo-subtle">{hit.tag}</span>
            {hit.pending && <Badge variant="neutral">Edit pending</Badge>}
          </span>
          <span className="line-clamp-3 whitespace-pre-wrap break-words text-xs font-normal text-kumo-subtle">
            {snippetParts(hit.snippet).map((part, index) => part.highlight
              ? <mark key={index} className="bg-kumo-tint px-0.5 text-kumo-default">{part.text}</mark>
              : <span key={index}>{part.text}</span>)}
          </span>
        </Button>
      </li>)}
    </ul>
    {clear}
  </div>
}
