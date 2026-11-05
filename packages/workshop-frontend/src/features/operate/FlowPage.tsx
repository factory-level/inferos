import { useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, ChatCircleIcon, CheckIcon, XIcon } from '@phosphor-icons/react'
import { MAX_OPERATE_FLOW_HISTORY, type OperateEvent, type OperateFlowPage, type OperateFlowRun } from '@gadgets/workshop-shared/operate-session'
import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'
import { FlowScreen, type FlowConsole } from './FlowScreen'
import { refusalMessage } from './sessionRefusal'

// A page name as people read it: "check-details" is shown as "Check details".
const pageLabel = (page: OperateFlowPage) => {
  const words = page.name.replace(/-+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The full-canvas state: a running flow's current step fills the page, in place of the session's
 * tabs and the app's navigation. Every move goes through the session, so every tab and device of
 * the person's shows the same step. A flow in order moves by Back and Next. A flow that names its
 * pages offers the current page's routes and Back along the path taken, and shows that path; a
 * route is page navigation only and is never drawn among a screen's widget actions. A refused move
 * leaves the flow where it is and says why, in the session's words; one that failed only for now
 * (`flowNavigationFailed`) can be tried again.
 */
export const FlowPage = ({ flow, console: shown, chatOpen, onEvent }: {
  flow: OperateFlowRun
  /** The console open on the page, through which a use-role viewer sees the steps. */
  console: FlowConsole
  chatOpen: boolean
  /** Sends one event to the session; rejects when the session refuses it. */
  onEvent: (event: OperateEvent) => Promise<unknown>
}) => {
  const scrollRoot = useRef<HTMLElement>(null)
  const [stepTitle, setStepTitle] = useState<string | null>(null)
  // What the session last refused, the move to try again when the failure was only for now, and
  // where the run was then. A refusal belongs to that position: once the run moves, here or from
  // another tab or device, it is dropped for good, so returning to the same place (Back, then the
  // same route forward) does not bring it back. It is dropped during render, React's pattern for
  // resetting state on a changed input, not in an Effect.
  const position = `${flow.index}/${flow.history?.length ?? 0}`
  const [refused, setRefusal] = useState<{ message: string; retry: OperateEvent | null; position: string } | null>(null)
  if (refused && refused.position !== position) setRefusal(null)
  const refusal = refused?.position === position ? refused : null
  const send = (event: OperateEvent) => {
    setRefusal(null)
    onEvent(event).catch(caught => {
      console.error('The flow could not move:', caught)
      const retryable = getOperateSessionErrorCode(caught) === OPERATE_SESSION_ERROR_CODES.flowNavigationFailed
      setRefusal({ message: refusalMessage(caught), retry: retryable ? event : null, position })
    })
  }
  const pages = flow.pages
  const page = pages?.[flow.index]
  const history = flow.history ?? []
  const last = flow.index === flow.steps.length - 1
  const heading = page ? stepTitle ?? pageLabel(page) : `Step ${flow.index + 1} of ${flow.steps.length}${stepTitle ? ` · ${stepTitle}` : ''}`
  const finish = <WorkshopButton tone="primary" onClick={() => send({ type: 'exitFlow' })}>
    <CheckIcon size={13} aria-hidden className="mr-1" />Finish
  </WorkshopButton>

  return (
    <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
      {/* Narrow widths wrap the title onto its own row, so the step's name is never squeezed out by the controls. */}
      <header className={`flex min-h-14 flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-kumo-line px-4 py-2 ${pages ? '' : 'sm:h-14 sm:flex-nowrap sm:py-0'}`}>
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <p className="m-0 truncate text-[11px] leading-4 font-medium uppercase tracking-[0.06em] text-kumo-inactive">{flow.title}</p>
          <h1 aria-live="polite" className="m-0 truncate text-[14px] leading-5 font-medium text-kumo-default">{heading}</h1>
        </div>
        {pages && page
          ? <div role="group" aria-label="Flow navigation" className="flex flex-wrap items-center gap-2">
              <WorkshopButton disabled={history.length === 0} onClick={() => send({ type: 'backFlow' })}>
                <ArrowLeftIcon size={13} aria-hidden className="mr-1" />Back
              </WorkshopButton>
              {/* Keyed by position too: a page may offer two routes with the same label and destination. */}
              {(page.routes ?? []).map((route, at) => (
                <WorkshopButton key={`${at}/${route.to}/${route.label}`} tone="primary" onClick={() => send({ type: 'navigateFlow', to: route.to })}>
                  {route.label}<ArrowRightIcon size={13} aria-hidden className="ml-1" />
                </WorkshopButton>
              ))}
              {(page.routes ?? []).length === 0 && finish}
            </div>
          : <>
              <ol aria-hidden className="hidden items-center gap-1 sm:flex">
                {flow.steps.map((_, index) => (
                  <li key={index} className={`h-1.5 w-6 rounded-full ${index <= flow.index ? 'bg-kumo-brand' : 'bg-kumo-control'}`} />
                ))}
              </ol>
              <WorkshopButton disabled={flow.index === 0} onClick={() => send({ type: 'goToStep', index: flow.index - 1 })}>
                <ArrowLeftIcon size={13} aria-hidden className="mr-1" />Back
              </WorkshopButton>
              {last ? finish
                : <WorkshopButton tone="primary" onClick={() => send({ type: 'goToStep', index: flow.index + 1 })}>
                    Next<ArrowRightIcon size={13} aria-hidden className="ml-1" />
                  </WorkshopButton>}
            </>}
        <button type="button" aria-pressed={chatOpen} onClick={() => send({ type: 'setChatOpen', open: !chatOpen })}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${chatOpen ? 'bg-kumo-control text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>
          <ChatCircleIcon size={14} aria-hidden />Operate chat
        </button>
        <button type="button" aria-label={`Exit ${flow.title}`} onClick={() => send({ type: 'exitFlow' })}
          className="grid h-8 w-8 place-items-center rounded-lg text-kumo-subtle hover:bg-kumo-control hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
          <XIcon size={14} aria-hidden />
        </button>
      </header>
      {pages && page && <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-kumo-line px-4 py-2">
        <nav aria-label="Path taken" className="min-w-0 flex-1">
          <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-[12px] leading-4 text-kumo-subtle">
            {history.length >= MAX_OPERATE_FLOW_HISTORY && <li aria-label="Earlier pages">…</li>}
            {history.map((index, at) => (
              <li key={`${at}/${index}`} className="flex items-center gap-1">
                {pageLabel(pages[index]!)}<span aria-hidden className="text-kumo-inactive">›</span>
              </li>
            ))}
            <li aria-current="step" className="font-medium text-kumo-default">{pageLabel(page)}</li>
          </ol>
        </nav>
        {(page.states ?? []).length > 0 && <div role="group" aria-label="Page state" className="flex flex-wrap items-center gap-1">
          {page.states!.map(state => (
            <WorkshopButton key={state} aria-pressed={flow.pageState === state} tone={flow.pageState === state ? 'primary' : 'secondary'}
              onClick={() => { if (flow.pageState !== state) send({ type: 'setFlowPageState', state }) }}>
              {state}
            </WorkshopButton>
          ))}
        </div>}
      </div>}
      {refusal && <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-kumo-line bg-kumo-danger-tint px-4 py-2">
        <p role="alert" className="m-0 min-w-0 flex-1 text-[13px] leading-[18px] text-kumo-danger">{refusal.message}</p>
        {refusal.retry && <WorkshopButton onClick={() => send(refusal.retry!)}>Try again</WorkshopButton>}
      </div>}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main ref={scrollRoot} className="min-h-0 min-w-0 flex-1 overflow-auto bg-kumo-tint">
          {/* The path's length is part of the key, so a page reached again (a retry) starts afresh. */}
          <FlowScreen scrollRoot={scrollRoot} key={`${flow.index}/${flow.steps[flow.index]}/${history.length}`} run={flow}
            console={shown} onTitle={setStepTitle} />
        </main>
      </div>
    </div>
  )
}
