import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Badge } from '@cloudflare/kumo'
import type { BoundViewTone } from '@gadgets/workshop-shared/bound-view'
import { reportBoundViewFailure, type BoundViewFailureSite } from './contain'
import type { BoundViewCell, BoundViewLeaf, BoundViewTree } from './evaluate'

// Trusted host code: the only place an evaluated bound view becomes DOM. Every authored or
// snapshot value is a text child of a `<bdi>`; no value ever reaches an attribute (no `href`,
// `src`, `style`, `class`, `id`, `aria-*` or `on*`), and nothing becomes a link. Classes, variants
// and layout come from the constant tables below, keyed by enums the evaluator produced. React keys
// are positional (node path and row index), never values.

const TONE: Record<BoundViewTone, 'secondary' | 'info' | 'success' | 'warning' | 'error'> = {
  neutral: 'secondary', info: 'info', success: 'success', warning: 'warning', danger: 'error',
}
const TEXT_SIZE = { sm: 'text-xs', md: 'text-sm', lg: 'text-base font-medium' } as const
const TEXT_TONE = { default: 'text-kumo-default', muted: 'text-kumo-subtle' } as const
const STACK_GAP = { sm: 'flex flex-col gap-2', md: 'flex flex-col gap-4' } as const
const COLUMNS: Record<number, string> = { 2: 'grid gap-4 md:grid-cols-2', 3: 'grid gap-4 md:grid-cols-3', 4: 'grid gap-4 md:grid-cols-4' }

const Leaf = ({ leaf }: { leaf: BoundViewLeaf }) => {
  if (leaf.type === 'badge') return <Badge variant={TONE[leaf.tone]}><bdi>{leaf.label}</bdi></Badge>
  if (leaf.type === 'text') return <span className={TEXT_TONE[leaf.tone]}><bdi>{leaf.text}</bdi></span>
  return <span>{leaf.label !== null && <><span className="text-kumo-subtle"><bdi>{leaf.label}</bdi></span>{' '}</>}<bdi>{leaf.value}</bdi></span>
}

const Cell = ({ cell }: { cell: BoundViewCell }) => cell.type === 'badge'
  ? <Badge variant={TONE[cell.tone]}><bdi>{cell.label}</bdi></Badge>
  : <bdi>{cell.value}</bdi>

const Node = ({ node }: { node: BoundViewTree }): ReactNode => {
  switch (node.type) {
    case 'stack': return <div className={STACK_GAP[node.gap]}>{node.children.map((child, index) => <Node key={index} node={child} />)}</div>
    case 'columns': return <div className={COLUMNS[node.children.length] ?? COLUMNS[2]}>{node.children.map((child, index) => <Node key={index} node={child} />)}</div>
    case 'text': return <p className={`${TEXT_SIZE[node.size]} ${TEXT_TONE[node.tone]}`}><bdi>{node.text}</bdi></p>
    case 'empty': return <p className="text-kumo-subtle"><bdi>{node.text}</bdi></p>
    case 'field': return <p>{node.label !== null && <><span className="text-kumo-subtle"><bdi>{node.label}</bdi></span>{' '}</>}<bdi>{node.value}</bdi></p>
    case 'count': return <p><span className="text-kumo-subtle"><bdi>{node.label}</bdi></span>{' '}<bdi className="font-medium text-kumo-default">{String(node.value)}</bdi></p>
    case 'list':
      if (node.empty !== null) return <p className="text-kumo-subtle"><bdi>{node.empty}</bdi></p>
      return <div className="flex flex-col gap-3">{node.sections.map((section, index) => <section key={index} className="flex flex-col gap-1">
        {section.header && <h3 className="text-xs font-medium text-kumo-subtle"><bdi>{section.header.key}</bdi> · {String(section.header.count)}</h3>}
        <ul className="flex flex-col gap-1">{section.rows.map((row, rowIndex) => <li key={rowIndex} className="flex flex-wrap items-center gap-2 rounded-md border border-kumo-line px-2 py-1">
          {row.map((leaf, leafIndex) => <Leaf key={leafIndex} leaf={leaf} />)}
        </li>)}</ul>
      </section>)}</div>
    case 'table':
      return <div className="overflow-x-auto"><table className="w-full text-left">
        <thead><tr>{node.headers.map((header, index) => <th key={index} scope="col" className="border-b border-kumo-line px-2 py-1 text-xs font-medium text-kumo-subtle"><bdi>{header}</bdi></th>)}</tr></thead>
        <tbody>{node.empty !== null
          ? <tr><td colSpan={node.headers.length} className="px-2 py-2 text-kumo-subtle"><bdi>{node.empty}</bdi></td></tr>
          : node.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b border-kumo-line px-2 py-1 align-top"><Cell cell={cell} /></td>)}</tr>)}</tbody>
      </table></div>
  }
}

/** Renders an evaluated bound view. Text only; see the module comment for what never happens. */
export const BoundViewRenderer = ({ tree }: { tree: BoundViewTree }) =>
  <div className="flex flex-col gap-3 text-sm text-kumo-default"><Node node={tree} /></div>

// A render error inside the dedicated root is caught here and shown as nothing; the root's
// `onCaughtError` hook (which swallows it) tells the view to show its fixed failure state.
class BoundViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override render() { return this.state.failed ? null : this.props.children }
}

/**
 * The dedicated root's error hooks: each drops the error unread and sends only the constant
 * failure report to `site`.
 */
export const boundRootOptions = (site: BoundViewFailureSite) => {
  const failed = () => reportBoundViewFailure(site)
  return { onCaughtError: failed, onRecoverableError: failed, onUncaughtError: failed }
}

/** A dedicated root holding one rendered bound view (see {@link mountBoundRoot}). */
export type BoundRoot = {
  /** Schedules `tree` to render; the DOM changes when React commits. */
  render: (tree: BoundViewTree) => void
  /** Unmounts the root and removes its element. Call it only outside React render and commit. */
  unmount: () => void
}

/**
 * Mounts a dedicated React root for a bound view in a new element appended to `container`. Its
 * `onCaughtError`, `onRecoverableError` and `onUncaughtError` hooks drop the error and send only the
 * constant failure report to `site`, so no error from rendering data reaches the console, the
 * window or the Workshop's reporter; the main root's hooks are untouched. A new root is mounted for
 * each renderable snapshot set after a teardown, so it never holds an earlier set's DOM.
 */
export const mountBoundRoot = (container: HTMLElement, site: BoundViewFailureSite): BoundRoot => {
  const element = container.ownerDocument.createElement('div')
  container.append(element)
  const root = createRoot(element, boundRootOptions(site))
  return {
    render: tree => root.render(<BoundViewBoundary><BoundViewRenderer tree={tree} /></BoundViewBoundary>),
    unmount: () => {
      try { root.unmount() } finally { element.remove() }
    },
  }
}
