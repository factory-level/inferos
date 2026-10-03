import { Badge, Button, Loader } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { PRIORITY_LABELS } from './kanbanBoard'
import type { BoardRequest } from './boardData'
import { useBoardData } from './useBoardData'

const PENDING_LABELS = { create: 'New issue, waiting for approval', update: 'Edit waiting for approval', transition: 'Move waiting for approval' } as const

/**
 * One issue embedded in a Wiki page, read from its project's board through the same scoped board
 * adapter as the Kanban, so it shows the issue the Kanban shows: the same identity, state and
 * revision, and the same pending changes. It resolves only through the workspace's own connection
 * to that board; without one it says so and shows nothing of the issue.
 */
export const WikiIssueEmbed = ({ overseer, boardRef, identifier, href }: {
  overseer: RpcStub<Overseer>
  /** The issue's project board, which the workspace must be connected to. */
  boardRef: string
  /** The issue key, e.g. `ENG-12`. */
  identifier: string
  /** The reference as written in the page. */
  href: string
}) => {
  // The whole board is read whatever the params; these only key the adapter entry.
  const request: BoardRequest = { kind: 'inferops.project-board', version: 1, targetRef: boardRef, params: { workflow: 'software', showCompleted: true } }
  const { state, refresh } = useBoardData(overseer, request)
  const board = 'board' in state ? state.board : undefined
  const column = board?.columns.find(c => c.issues.some(issue => issue.identifier === identifier))
  const issue = column?.issues.find(item => item.identifier === identifier)
  return <article aria-label={`Issue ${identifier}`} className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm">
    {state.status === 'loading' && <p aria-busy="true" className="flex items-center gap-2 text-kumo-subtle"><Loader size="sm" /> Loading {identifier}…</p>}
    {state.status === 'unbound' && <p className="text-kumo-subtle">
      Not connected. This workspace has no connection to the board of {identifier}, so the issue is not shown. <code className="break-all">{href}</code>
    </p>}
    {state.status === 'disabled' && <p role="status" className="text-kumo-subtle">{state.message}</p>}
    {state.status === 'error' && <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-kumo-danger">Could not read {identifier}: {state.message}</p>
      <Button size="sm" onClick={refresh}>Try again</Button>
    </div>}
    {board && !issue && <p className="text-kumo-subtle">
      {identifier} is not on the {board.project.identifier} board. It may have been deleted or moved. <code className="break-all">{href}</code>
    </p>}
    {issue && column && <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-kumo-subtle">{issue.identifier}</span>
        <Badge variant="neutral">{column.state.name}</Badge>
        {issue.priority !== 'none' && <Badge variant="neutral">{PRIORITY_LABELS[issue.priority]}</Badge>}
        {issue.pending && <Badge variant="warning">{PENDING_LABELS[issue.pending]}</Badge>}
        {state.status === 'stale' && <Badge variant="warning">{state.error ? 'Refresh failed' : 'Refreshing'}</Badge>}
      </div>
      <p className="font-medium text-kumo-default">{issue.title}</p>
      {issue.blockedReason && <p className="text-xs text-kumo-danger">Blocked: {issue.blockedReason}</p>}
      <p className="text-xs text-kumo-subtle">Revision {issue.revision}</p>
    </div>}
  </article>
}
