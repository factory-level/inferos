import { useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, ChatCircleIcon, CheckIcon, XIcon } from '@phosphor-icons/react'
import type { OperateEvent, OperateFlowRun } from '@gadgets/workshop-shared/operate-session'
import { WorkshopButton } from '../../components/WorkshopControls'
import { FlowScreen } from './FlowScreen'
import { OperateChatPanel } from './OperateChatPanel'
import type { SessionWorkspace } from './useSessionWorkspace'

/**
 * The full-canvas state: a running flow's current step fills the page, in place of the session's
 * tabs and the app's navigation. Back and Next move the step through the session, so every tab
 * and device of the person's shows the same step.
 */
export const FlowPage = ({ flow, chatOpen, onEvent, sessionWorkspace }: {
  flow: OperateFlowRun
  chatOpen: boolean
  onEvent: (event: OperateEvent) => void
  /** The session workspace, where the operate chat runs; null while it opens. */
  sessionWorkspace: SessionWorkspace | null
}) => {
  const [stepTitle, setStepTitle] = useState<string | null>(null)
  const last = flow.index === flow.steps.length - 1
  const position = `Step ${flow.index + 1} of ${flow.steps.length}`

  return (
    <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
      {/* Narrow widths wrap the title onto its own row, so the step's name is never squeezed out by the controls. */}
      <header className="flex min-h-14 flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-kumo-line px-4 py-2 sm:h-14 sm:flex-nowrap sm:py-0">
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <p className="m-0 truncate text-[11px] leading-4 font-medium uppercase tracking-[0.06em] text-kumo-inactive">{flow.title}</p>
          <h1 aria-live="polite" className="m-0 truncate text-[14px] leading-5 font-medium text-kumo-default">
            {position}{stepTitle ? ` · ${stepTitle}` : ''}
          </h1>
        </div>
        <ol aria-hidden className="hidden items-center gap-1 sm:flex">
          {flow.steps.map((_, index) => (
            <li key={index} className={`h-1.5 w-6 rounded-full ${index <= flow.index ? 'bg-kumo-brand' : 'bg-kumo-control'}`} />
          ))}
        </ol>
        <WorkshopButton disabled={flow.index === 0} onClick={() => onEvent({ type: 'goToStep', index: flow.index - 1 })}>
          <ArrowLeftIcon size={13} aria-hidden className="mr-1" />Back
        </WorkshopButton>
        {last
          ? <WorkshopButton tone="primary" onClick={() => onEvent({ type: 'exitFlow' })}>
              <CheckIcon size={13} aria-hidden className="mr-1" />Finish
            </WorkshopButton>
          : <WorkshopButton tone="primary" onClick={() => onEvent({ type: 'goToStep', index: flow.index + 1 })}>
              Next<ArrowRightIcon size={13} aria-hidden className="ml-1" />
            </WorkshopButton>}
        <button type="button" aria-pressed={chatOpen} onClick={() => onEvent({ type: 'setChatOpen', open: !chatOpen })}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${chatOpen ? 'bg-kumo-control text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>
          <ChatCircleIcon size={14} aria-hidden />Operate chat
        </button>
        <button type="button" aria-label={`Exit ${flow.title}`} onClick={() => onEvent({ type: 'exitFlow' })}
          className="grid h-8 w-8 place-items-center rounded-lg text-kumo-subtle hover:bg-kumo-control hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
          <XIcon size={14} aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {chatOpen && <OperateChatPanel workspace={sessionWorkspace} />}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          <FlowScreen key={`${flow.index}/${flow.steps[flow.index]}`} workspaceId={flow.workspaceId}
            screenId={flow.steps[flow.index]!} onTitle={setStepTitle} />
        </main>
      </div>
    </div>
  )
}
