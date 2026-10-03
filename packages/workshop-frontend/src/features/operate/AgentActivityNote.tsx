import { RobotIcon } from '@phosphor-icons/react'
import type { OperateEvent, OperateEventRecord, OperateRef } from '@gadgets/workshop-shared/operate-session'
import { formatRelativeTime } from '../../Activity'

/** What an event did to the page, as a phrase following "Agent". */
export const describeAgentEvent = (event: OperateEvent, titleOf: (ref: OperateRef) => string): string => {
  switch (event.type) {
    case 'open': return `opened ${titleOf(event.ref)}`
    case 'close': return `closed ${titleOf(event.ref)}`
    case 'focus': return `switched to ${titleOf(event.ref)}`
    case 'setSubject': return event.subject === null ? 'cleared the subject' : `set the subject to “${event.subject}”`
    case 'setChatOpen': return event.open ? 'opened the chat' : 'closed the chat'
    case 'setAppPresentation': return 'changed how the app is shown'
    case 'startFlow': return `started ${event.title}`
    case 'goToStep': return `moved the flow to step ${event.index + 1}`
    case 'exitFlow': return 'left the flow'
    case 'reviewApproval': return 'opened an approval for review'
    case 'approvalResolved': return `reported an approval ${event.outcome}`
  }
}

/**
 * Says what the operate agent last did to the page, so a change nobody on this tab made is
 * attributed rather than unexplained. The log's actor is the kernel's record, never the client's.
 */
export const AgentActivityNote = ({ records, titleOf }: {
  records: readonly OperateEventRecord[]
  titleOf: (ref: OperateRef) => string
}) => {
  const last = records.findLast(record => record.actor === 'agent')
  return (
    <p role="status" aria-live="polite" className="m-0 flex min-w-0 items-center gap-1.5 truncate text-[12px] text-kumo-subtle">
      {last && <>
        <RobotIcon size={13} aria-hidden className="flex-shrink-0" />
        <span className="truncate">Agent {describeAgentEvent(last.event, titleOf)}</span>
        <span className="text-kumo-inactive">· {formatRelativeTime(last.at)}</span>
      </>}
    </p>
  )
}
