import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES } from '@gadgets/workshop-shared/api'
import type { OperateEvent, OperateHandover } from '@gadgets/workshop-shared/operate-session'
import { BoardConnectPrompt } from './BoardConnectPrompt'
import type { SessionWorkspace } from './useSessionWorkspace'

const boardName = (boardRef: string) => boardRef.split('/').at(-1) ?? boardRef

/**
 * One handover waiting in this session. Opening it is this person's own `openBoard` in their own
 * session workspace, so it shows only a board they can already reach; when they can't, they are
 * offered to connect it with their own account, never the sender's.
 */
const HandoverItem = ({ handover, workspace, onEvent }: {
  handover: OperateHandover
  workspace: SessionWorkspace | null
  onEvent: (event: OperateEvent) => Promise<void>
}) => {
  const [state, setState] = useState<'idle' | 'opening' | 'unreachable' | 'failed'>('idle')
  const open = async () => {
    if (!workspace) return
    setState('opening')
    try {
      await onEvent({ type: 'openBoard', board: { workspaceId: workspace.id, boardRef: handover.boardRef } })
      if (handover.issueId !== null) await onEvent({ type: 'openIssue', issueId: handover.issueId })
      await onEvent({ type: 'dismissHandover', id: handover.id })
    } catch (caught) {
      setState(getOperateSessionErrorCode(caught) === OPERATE_SESSION_ERROR_CODES.boardUnavailable ? 'unreachable' : 'failed')
    }
  }

  return <li className="space-y-2 rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <p className="m-0 min-w-0 flex-1">
        <span className="font-medium">{handover.from.name}</span> handed you board {boardName(handover.boardRef)}
        {handover.issueId !== null && ' and an issue on it'}
        {handover.note && <span className="text-kumo-subtle">: “{handover.note}”</span>}
      </p>
      <Button size="sm" variant="primary" disabled={!workspace || state === 'opening'} onClick={() => void open()}>Open</Button>
      <Button size="sm" variant="ghost" onClick={() => void onEvent({ type: 'dismissHandover', id: handover.id }).catch(() => setState('failed'))}>Dismiss</Button>
    </div>
    {state === 'failed' && <p role="alert" className="text-kumo-danger">Could not open this handover. Try again.</p>}
    {state === 'unreachable' && workspace && <div role="alert" className="space-y-2">
      <p className="text-kumo-subtle">This board isn't connected for you. A handover shares the reference only: connect it with your own InferOps account to open it.</p>
      <BoardConnectPrompt scope={workspace.stub} targetRef={handover.boardRef} onConnected={() => void open()} />
    </div>}
  </li>
}

/** Handovers other people sent into this session, until opened or dismissed. */
export const HandoverInbox = ({ handovers, workspace, onEvent }: {
  handovers: readonly OperateHandover[]
  workspace: SessionWorkspace | null
  onEvent: (event: OperateEvent) => Promise<void>
}) => handovers.length === 0 ? null
  : <section aria-label="Handovers" className="shrink-0 px-5 pb-3">
      <ul className="space-y-2">
        {handovers.toReversed().map(handover => <HandoverItem key={handover.id} handover={handover} workspace={workspace} onEvent={onEvent} />)}
      </ul>
    </section>
