import { Badge, Button } from '@cloudflare/kumo'
import type { WikiStructurePage } from '@inferos/gatekeeper-inferops/src/types'
import type { WikiNavigation as Navigation, WikiTreeNode } from './wikiPage'

type Select = { selected: string | null; onSelect: (slug: string) => void }

const NESTED = 'space-y-0.5 [&_ul]:ml-3 [&_ul]:border-l [&_ul]:border-kumo-line [&_ul]:pl-2'

const PageButton = ({ page, shared, selected, onSelect }: Select & { page: Pick<WikiStructurePage, 'slug' | 'title'>; shared?: boolean }) =>
  <Button size="sm" variant="ghost" aria-current={page.slug === selected ? 'page' : undefined}
    aria-label={shared ? `${page.title}, filed in several pillars` : undefined} className={`w-full justify-start truncate ${page.slug === selected ? 'font-semibold' : ''}`} onClick={() => onSelect(page.slug)}>
    {page.title}{shared && <Badge variant="neutral">Shared</Badge>}
  </Button>

const PageTree = ({ nodes, selected, onSelect }: Select & { nodes: readonly WikiTreeNode[] }) =>
  <ul className={NESTED}>
    {nodes.map(({ page, children }) => <li key={page.id}>
      <PageButton page={page} selected={selected} onSelect={onSelect} />
      {children.length > 0 && <PageTree nodes={children} selected={selected} onSelect={onSelect} />}
    </li>)}
  </ul>

/**
 * The Wiki's navigation: by its structure (the company root, each pillar's Master with the pages it
 * files, then the unfiled pages), or by the page tree. A page filed in several pillars is listed
 * under each, marked shared; every entry selects the page by its slug, so each opens the same page.
 */
export const WikiNavigation = ({ navigation, selected, onSelect }: Select & { navigation: Navigation }) => {
  if (navigation.kind === 'tree') return <PageTree nodes={navigation.tree} selected={selected} onSelect={onSelect} />
  const { root, pillars, unfiled } = navigation
  return <ul className={NESTED}>
    {root && <li><PageButton page={root} selected={selected} onSelect={onSelect} /></li>}
    {pillars.map(pillar => <li key={pillar.key}>
      {pillar.master ? <PageButton page={pillar.master} selected={selected} onSelect={onSelect} />
        : <p className="px-2 py-1 text-xs font-medium text-kumo-subtle">{pillar.title}</p>}
      {pillar.members.length > 0 && <ul aria-label={`Pages in ${pillar.title}`}>
        {pillar.members.map(({ page, shared }) => <li key={page.id}>
          <PageButton page={page} shared={shared} selected={selected} onSelect={onSelect} />
        </li>)}
      </ul>}
    </li>)}
    {unfiled.length > 0 && <li>
      <p className="px-2 py-1 text-xs font-medium text-kumo-subtle">Unfiled pages</p>
      <ul aria-label="Unfiled pages">
        {unfiled.map(page => <li key={page.id}><PageButton page={page} selected={selected} onSelect={onSelect} /></li>)}
      </ul>
    </li>}
  </ul>
}
