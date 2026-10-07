import { attemptNotice, canApproveAgain } from '../../actionAttempt'
import { useEffect, useId, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { actionChangeTime, type ActionLogEntry, type ActionRequester, type Overseer } from '@gadgets/workshop-shared/api'
import type {
  OperateApprovalOutcome,
  OperateApprovalRef,
  OperateEvent,
  OperatePageState,
} from '@gadgets/workshop-shared/operate-session'
import { formatRelativeTime, PENDING_ERROR_COPY } from '../../Activity'
import { RECENT_ACTIVITY_MS } from '../canvas/boardActivity'
import { useAuthenticatedApi } from '../../AuthContext'
import { ActionFields, entryFields } from '../../components/ActionFields'
import { CountBadge } from '../../components/CountBadge'
import { IncompleteDescriptionNotice, isDescriptionIncomplete } from '../../components/IncompleteDescriptionNotice'
import { ResolveButton } from '../../components/ResolveButton'
import { RestrictedApprovalNotice } from '../../components/RestrictedApprovalNotice'
import { useActions } from '../../useActions'
import { invalidateBoardInEveryScope, useDecidedActionInvalidationInEveryScope } from '../canvas/useBoardData'
import { decideApproval, readAction, type ApprovalDecision, type ApprovalDecisionResult } from './decideApproval'
import type { SessionWorkspace } from './useSessionWorkspace'

/** A workspace whose pending actions the session shows, reached through the viewer's own capability. */
type ApprovalSource = { workspaceId: string; label: string; stub: RpcStub<Overseer>; restricted: boolean }

type Pending = { source: ApprovalSource; action: Extract<ActionLogEntry, { type: 'action' }> }

/** What this tab last decided, with the message the page state has no room for. */
type DecisionNotice = ApprovalDecisionResult & { approval: OperateApprovalRef; title: string }

const REQUESTER_LABELS: Record<ActionRequester, string> = {
  agent: 'Requested by the agent',
  person: 'Requested by a person',
  gadget: 'Requested by a gadget',
  hook: 'Requested by a hook',
}

const approvalKey = ({ workspaceId, actionId }: OperateApprovalRef) => `${workspaceId}/${actionId}`

const sameApproval = (a: OperateApprovalRef | null, b: OperateApprovalRef) =>
  a !== null && a.workspaceId === b.workspaceId && a.actionId === b.actionId

const outcomeText = (title: string, outcome: OperateApprovalOutcome, error?: string) =>
  outcome === 'applied' ? `“${title}” was approved and applied.`
    : outcome === 'rejected' ? `“${title}” was rejected.`
      : `“${title}” was approved, but applying it failed${error ? `: ${error}` : '.'}`

// An earlier unsuccessful apply, shown on the pending item so a reload doesn't hide it.
const attemptLine = (action: ActionLogEntry) => {
  const attempt = attemptNotice(action)
  return attempt && <span className={`mt-0.5 block text-[11.5px] leading-4 ${attempt.tone === 'warning' ? 'text-kumo-warning' : 'text-kumo-danger'}`}>{attempt.text}</span>
}

const sameOutcome = (a: OperatePageState['lastApprovalOutcome'], b: OperatePageState['lastApprovalOutcome']) =>
  a === b || (a !== null && b !== null && sameApproval(a, b) && a.outcome === b.outcome)

/**
 * The action an approval outcome names, read from its workspace's log through `stub` (one of the
 * session's approval sources), so the outcome can be shown with the action's own title and time
 * rather than its id. Undefined while unread or with no source; null when it could not be read.
 */
const useLoggedAction = (stub: RpcStub<Overseer> | null, actionId: number | null): ActionLogEntry | null | undefined => {
  const [read, setRead] = useState<{ stub: RpcStub<Overseer>; actionId: number; entry: ActionLogEntry | null } | null>(null)
  useEffect(() => {
    if (!stub || actionId === null) return
    let cancelled = false
    readAction(stub, actionId).then(
      entry => { if (!cancelled) setRead({ stub, actionId, entry: entry ?? null }) },
      caught => {
        console.error('Failed to read the decided action:', caught)
        if (!cancelled) setRead({ stub, actionId, entry: null })
      })
    return () => { cancelled = true }
  }, [stub, actionId])
  return read && read.stub === stub && read.actionId === actionId ? read.entry : undefined
}

/**
 * The focused screen's workspace, opened for its approvals. A use-role viewer cannot see or decide
 * a workspace's actions, and a workspace that no longer opens has none to show here (the screen
 * itself says it is unavailable), so both give no source.
 */
const useScreenApprovalSource = (workspaceId: string | null): ApprovalSource | null => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [source, setSource] = useState<ApprovalSource | null>(null)
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    const stub: RpcStub<Overseer> = authenticatedApi.openGadget(workspaceId)
    stub.getMetadata().then(metadata => {
      if (cancelled || metadata.role === 'use') return
      setSource({ workspaceId, label: metadata.title || 'This screen', stub, restricted: metadata.containsRestrictedData === true })
    }).catch(caught => console.error('Failed to open a screen workspace for its approvals:', caught))
    return () => {
      cancelled = true
      stub[Symbol.dispose]()
      setSource(null)
    }
  }, [authenticatedApi, workspaceId])
  return source
}

const pendingOf = (source: ApprovalSource | null, actions: readonly ActionLogEntry[]): Pending[] =>
  source ? actions.flatMap(action => action.type === 'action' ? [{ source, action }] : []) : []

/**
 * The approvals of an operate session: pending actions of the session workspace (what its operate
 * chat proposed) and of the focused screen's workspace (what its board cards proposed), decided
 * here through those workspaces' own `approveAction` / `rejectAction`. Other workspaces open in the
 * working set are covered once focused. Opening one for review and the decision's real outcome,
 * read back from the action log, are reported to the session as page events. Renders nothing when
 * there is nothing to decide or report.
 */
export const SessionApprovals = ({ session, screenWorkspaceId, reviewing, lastOutcome, onEvent }: {
  session: SessionWorkspace | null
  /** The focused screen's workspace, or null when no screen is focused. */
  screenWorkspaceId: string | null
  reviewing: OperatePageState['reviewing']
  lastOutcome: OperatePageState['lastApprovalOutcome']
  onEvent: (event: OperateEvent) => Promise<void>
}) => {
  const baseId = useId()
  const sessionSource: ApprovalSource | null = session
    ? { workspaceId: session.id, label: 'Operate chat', stub: session.stub, restricted: session.restricted }
    : null
  const screenSource = useScreenApprovalSource(screenWorkspaceId === session?.id ? null : screenWorkspaceId)
  const sessionActions = useActions(sessionSource?.stub ?? null)
  const screenActions = useActions(screenSource?.stub ?? null)
  // The focused screen's boards re-read on their own workspace's decisions; the session
  // workspace's decisions touch boards shown through other workspaces.
  useDecidedActionInvalidationInEveryScope(session?.stub ?? null)
  const [processing, setProcessing] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<DecisionNotice | null>(null)

  const pending = [...pendingOf(sessionSource, sessionActions.pending), ...pendingOf(screenSource, screenActions.pending)]
  const failedToLoad = (sessionSource && sessionActions.status === 'error') || (screenSource && screenActions.status === 'error')
  const bothSources = sessionSource !== null && screenSource !== null

  const report = (event: OperateEvent) => onEvent(event).catch(caught => {
    console.error(`Failed to report ${event.type} to the operate session:`, caught)
  })

  const review = (approval: OperateApprovalRef) => {
    if (!sameApproval(reviewing, approval)) void report({ type: 'reviewApproval', approval })
  }

  const decide = async ({ source, action }: Pending, decision: ApprovalDecision) => {
    const approval = { workspaceId: source.workspaceId, actionId: action.id }
    const key = approvalKey(approval)
    setProcessing(previous => new Set(previous).add(key))
    try {
      if (!sameApproval(reviewing, approval)) await report({ type: 'reviewApproval', approval })
      const result = await decideApproval(source.stub, action.id, decision)
      // A failed apply leaves the action pending, so no decided entry re-reads its board; the
      // board may have changed underneath it (a stale revision, say), so re-read it here.
      if (result.outcome === 'failed' && action.resourceUrl) invalidateBoardInEveryScope(action.resourceUrl)
      if (result.outcome !== null) await report({ type: 'approvalResolved', approval, outcome: result.outcome })
      setNotice({ ...result, approval, title: action.description.title })
    } finally {
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  // The outcome the page held when this tab opened is history: shown, aged, only while recent, and
  // never announced. One reported since (by another tab or device) is announced like this tab's own.
  const [restored] = useState(lastOutcome)
  const fresh = lastOutcome !== null && !sameOutcome(restored, lastOutcome)
  const outcomeSource = lastOutcome === null ? null
    : [sessionSource, screenSource].find(source => source?.workspaceId === lastOutcome.workspaceId) ?? null
  const logged = useLoggedAction(outcomeSource?.stub ?? null, lastOutcome?.actionId ?? null)
  const decidedAt = logged && logged.type === 'action' && logged.state !== 'pending' ? actionChangeTime(logged).getTime() : null
  const [now, setNow] = useState(() => Date.now())
  const expiresAt = !fresh && decidedAt !== null ? decidedAt + RECENT_ACTIVITY_MS : null
  useEffect(() => {
    if (expiresAt === null) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt])
  const loggedTitle = logged && logged.type === 'action' ? logged.description.title : null
  // The reason a failed apply's log entry kept, for its outcome reported elsewhere or restored.
  const loggedReason = logged && logged.type === 'action' && logged.state === 'failed' ? logged.lastAttempt?.message : undefined

  // This tab's own decision carries its message; a newer outcome reported elsewhere wins.
  const own = notice && (lastOutcome === null || notice.outcome === null || sameApproval(lastOutcome, notice.approval)) ? notice : null
  const shown: { text: string; outcome: OperateApprovalOutcome | null } | null = own
    ? {
        text: own.outcome === null ? `“${own.title}” was not resolved: ${own.error}` : outcomeText(own.title, own.outcome, own.error),
        outcome: own.outcome,
      }
    // Reported elsewhere: under the action's own title once read (its id only if it cannot be).
    : fresh && logged !== undefined
      ? { text: outcomeText(loggedTitle ?? `Action ${lastOutcome.actionId}`, lastOutcome.outcome, loggedReason), outcome: lastOutcome.outcome }
      : null
  const statusText = shown?.text ?? ''
  const statusTone = shown?.outcome === 'applied' ? 'text-kumo-default'
    : shown?.outcome === 'rejected' ? 'text-kumo-subtle' : 'text-kumo-danger'
  // A restored decision, with when it was made and, for a failed apply, the reason the log kept. A
  // failed action that is still pending (a retryable or unknown attempt) is listed instead.
  const earlier = !own && !fresh && lastOutcome !== null && loggedTitle !== null &&
    decidedAt !== null && now - decidedAt < RECENT_ACTIVITY_MS
    ? `${outcomeText(loggedTitle, lastOutcome.outcome, loggedReason)} · ${formatRelativeTime(new Date(decidedAt))}`
    : ''

  if (pending.length === 0 && !statusText && !earlier && !failedToLoad) return null

  return (
    <section aria-labelledby={`${baseId}-heading`} className="flex-shrink-0 border-b border-kumo-line px-4 py-2.5">
      <div className="flex items-center gap-2">
        <h2 id={`${baseId}-heading`} className="m-0 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
          {pending.length > 0 || failedToLoad ? 'Needs your approval' : 'Recent activity'}
        </h2>
        <CountBadge count={pending.length} />
      </div>
      {failedToLoad && <p className="m-0 mt-1 text-[12.5px] text-kumo-danger">{PENDING_ERROR_COPY}</p>}
      {pending.some(({ source }) => source.restricted) && <RestrictedApprovalNotice className="mt-2" />}
      {pending.length > 0 && (
        <ul className="m-0 mt-1 max-h-[40vh] list-none overflow-y-auto p-0">
          {pending.map(item => {
            const { source, action } = item
            const approval = { workspaceId: source.workspaceId, actionId: action.id }
            const key = approvalKey(approval)
            const isReviewing = sameApproval(reviewing, approval)
            const detailsId = `${baseId}-details-${key}`
            const fields = entryFields(action)
            const busy = processing.has(key)
            const meta = [
              action.resourceTitle,
              action.requestedBy && REQUESTER_LABELS[action.requestedBy],
              bothSources && `in ${source.label}`,
              formatRelativeTime(action.createdAt),
            ].filter(Boolean).join(' · ')
            return (
              <li key={key} className="border-t border-kumo-line py-2 first:border-t-0">
                <div className="flex items-start gap-2">
                  <button type="button" aria-expanded={isReviewing} aria-controls={isReviewing ? detailsId : undefined}
                    onClick={() => review(approval)}
                    className="min-w-0 flex-1 cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
                    <span className="block truncate text-[13px] font-medium leading-[18px] text-kumo-default">{action.description.title}</span>
                    <span className="mt-0.5 block truncate text-[11.5px] leading-4 text-kumo-inactive">{meta}</span>
                    {attemptLine(action)}
                  </button>
                  <div className="flex flex-shrink-0 items-center gap-0.5">
                    <ResolveButton tone="deny" disabled={busy} onClick={() => void decide(item, 'reject')} describedBy={isReviewing ? detailsId : undefined} />
                    <ResolveButton tone="approve" disabled={busy || !canApproveAgain(action)} onClick={() => void decide(item, 'approve')} describedBy={isReviewing ? detailsId : undefined} />
                  </div>
                </div>
                {(isReviewing || source.restricted) && (
                  <div id={detailsId} className="mt-1.5">
                    <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-[18px] text-kumo-subtle">{action.description.description}</p>
                    {fields.length > 0 && <ActionFields fields={fields} uncapped className="mt-2" />}
                    {isDescriptionIncomplete(action) && <IncompleteDescriptionNotice className="mt-2 px-2.5 py-2" />}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {earlier && <p className="m-0 mt-1.5 text-[12.5px] leading-[18px] text-kumo-subtle">{earlier}</p>}
      <p role="status" aria-live="polite" className={`m-0 text-[12.5px] leading-[18px] ${statusText ? `mt-1.5 ${statusTone}` : ''}`}>
        {statusText}
      </p>
    </section>
  )
}
