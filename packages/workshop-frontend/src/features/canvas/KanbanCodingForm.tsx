import { useState } from 'react'
import { Button, Dialog, Select } from '@cloudflare/kumo'
import type { Issue, Run } from '@inferos/gatekeeper-inferops/src/types'
import type { BoardActivity, BoardActivityItem } from './boardActivity'
import type { ProposalResult } from './boardData'
import type { CodingDispatchState } from './codingDispatch'
import { CodingRunDetails } from './CodingRunStatus'
import { DISPATCH_ACTION_TAG, codingErrorText, isActiveRun, isCancellable, repoUnavailableReason, selectableRepos } from './codingRuns'

/**
 * Coding dispatch for a board's project, offered only when the workspace also holds the project's
 * coding-dispatch connection; absent, a board shows no coding control at all.
 */
export type CodingControl = {
  state: Exclude<CodingDispatchState, { status: 'unavailable' }>
  /** Actions on the project's coding-dispatch connection, from the action log: whose dispatch awaits approval, and how one was decided. */
  activity: BoardActivity
  /** Proposes handing the issue, at its revision, to the coding runner against the repository. */
  onDispatch: (issue: Issue, repoId: string) => Promise<ProposalResult>
  /** Proposes stopping the run. */
  onCancel: (run: Run) => Promise<ProposalResult>
  onRefresh: () => void
}

type Proposal = { kind: 'dispatch' | 'cancel' } & (
  /** `after`: the newest dispatch action of the issue in the log when it was proposed, so an older decision is not read as this one's. */
  | { phase: 'proposing' | 'queued'; after: number }
  | { phase: 'refused'; text: string }
)

const newest = (items: readonly BoardActivityItem[]) => items.toSorted((a, b) => b.id - a.id)[0]

/**
 * The coding control for one issue: its latest run and what that run reported, a cancel for an
 * active run, and a dispatch to a repository the deployment allows. A dispatch or cancel is only
 * proposed: the form says so until the approval is decided, and the run's own state, re-read from
 * InferOps, says what happened after. Nothing here is shown as done before InferOps reports it.
 */
export const KanbanCodingForm = ({ issue, run, coding }: { issue: Issue; run: Run | undefined; coding: CodingControl }) => {
  const [repoChoice, setRepoChoice] = useState<string | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const { state } = coding

  const dispatches = [...coding.activity.active, ...coding.activity.recent]
    .filter(item => item.issue === issue.identifier && item.tag === DISPATCH_ACTION_TAG)
  const since = proposal?.phase === 'proposing' || proposal?.phase === 'queued' ? proposal.after : 0
  const decision = newest(dispatches.filter(item => item.id > since))
  const awaitingDispatch = run?.pending === 'dispatch' || decision?.kind === 'awaiting' ||
    (proposal?.kind === 'dispatch' && proposal.phase === 'queued' && decision === undefined)

  const propose = async (kind: Proposal['kind'], call: () => Promise<ProposalResult>) => {
    setProposal({ kind, phase: 'proposing', after: newest(dispatches)?.id ?? 0 })
    const result = await call()
    setProposal(previous => previous?.phase !== 'proposing' ? previous
      : result.ok ? { ...previous, phase: 'queued' } : { kind, phase: 'refused', text: codingErrorText(result, issue.identifier, kind) })
  }

  const proposing = proposal?.phase === 'proposing'
  const status = proposing
    ? proposal.kind === 'dispatch' ? `Proposing to dispatch ${issue.identifier}…` : `Proposing to cancel the run of ${issue.identifier}…`
    : awaitingDispatch
      ? `Dispatch of ${issue.identifier} is awaiting approval. Nothing runs until it is approved; if it can no longer be applied, the approval says why.`
      : decision?.kind === 'applied' ? `Dispatch of ${issue.identifier} approved: InferOps queued the run.`
        : decision?.kind === 'rejected' ? `Dispatch of ${issue.identifier} was rejected; nothing was queued.`
          : proposal?.kind === 'cancel' && proposal.phase === 'queued' && run !== undefined && isActiveRun(run)
            ? `Cancel of the ${run.status} run of ${issue.identifier} is awaiting approval. The run stops once it is approved.`
            : ''

  const repos = state.status === 'ready' ? state.repos : []
  const selectable = selectableRepos(repos)
  const others = repos.filter(repo => repoUnavailableReason(repo) !== null)
  const repoId = repoChoice !== null && selectable.some(repo => repo.id === repoChoice) ? repoChoice : selectable[0]?.id ?? null
  const shownRun = run?.pending === 'dispatch' ? undefined : run
  const canDispatch = state.status === 'ready' && issue.workflow === 'software' && issue.pending !== 'create' &&
    !awaitingDispatch && !proposing && !(shownRun && isActiveRun(shownRun))

  return <div className="space-y-4">
    <Dialog.Title>Coding task for {issue.identifier}</Dialog.Title>
    <Dialog.Description className="text-sm text-kumo-subtle">
      Hands this issue to the local coding runner once the dispatch is approved. The runner works in a local checkout and reports a patch and test results; nothing is pushed, merged or deployed.
    </Dialog.Description>
    <p role="status" aria-live="polite" className={status ? 'text-sm text-kumo-default' : 'sr-only'}>{status}</p>
    {proposal?.phase === 'refused' && <p role="alert" className="text-sm text-kumo-danger">{proposal.text}</p>}

    {state.status === 'disabled' && <p className="text-sm text-kumo-subtle">
      {state.message} Runs already queued stay in InferOps; dispatch is offered again once coding is turned back on.
    </p>}
    {state.status === 'error' && <div className="space-y-2">
      <p role="alert" className="text-sm text-kumo-danger">Could not read coding runs: {state.message}</p>
      <Button size="sm" onClick={coding.onRefresh}>Try again</Button>
    </div>}

    {state.status === 'ready' && <>
      {state.error && <p role="alert" className="text-xs text-kumo-danger">Showing the last runs read; refresh failed: {state.error}</p>}
      {shownRun ? <div className="space-y-2">
        <CodingRunDetails run={shownRun} repo={repos.find(repo => repo.id === shownRun.repoId)} />
        {isCancellable(shownRun) && <Button size="sm" variant="secondary" disabled={proposing}
          onClick={() => void propose('cancel', () => coding.onCancel(shownRun))}>Propose cancel</Button>}
      </div> : !awaitingDispatch && <p className="text-sm text-kumo-subtle">{issue.identifier} has no coding run yet.</p>}
      {state.followStopped && <p className="text-xs text-kumo-subtle">Stopped checking for updates automatically. Refresh to check again.</p>}

      {canDispatch && (selectable.length === 0
        ? <p className="text-sm text-kumo-subtle">No repository can take a dispatch here: each must be enabled in InferOps and on this deployment's coding allowlist.</p>
        : <form className="space-y-3" onSubmit={event => {
          event.preventDefault()
          if (repoId) void propose('dispatch', () => coding.onDispatch(issue, repoId))
        }}>
          <Select label="Repository" value={repoId ?? ''}
            renderValue={value => selectable.find(repo => repo.id === value)?.slug ?? ''}
            onValueChange={value => { if (value) setRepoChoice(String(value)) }}>
            {selectable.map(repo => <Select.Option key={repo.id} value={repo.id}>{repo.slug}</Select.Option>)}
          </Select>
          <p className="text-xs text-kumo-subtle">The run starts from the repository's default branch ({selectable.find(repo => repo.id === repoId)?.defaultBaseRef}).</p>
          <Button type="submit" variant="primary" disabled={repoId === null}>{shownRun ? 'Propose a new dispatch' : 'Propose dispatch'}</Button>
        </form>)}
      {canDispatch && others.length > 0 && <div className="text-xs text-kumo-subtle">
        <p>Not offered:</p>
        <ul aria-label="Repositories not offered" className="list-disc pl-4">
          {others.map(repo => <li key={repo.id}>{repo.slug}: {repoUnavailableReason(repo)}</li>)}
        </ul>
      </div>}
      {issue.workflow !== 'software' && <p className="text-sm text-kumo-subtle">Only software issues can be coded.</p>}
    </>}

    <div className="flex items-center justify-end gap-2">
      {state.status === 'ready' && <Button size="sm" variant="ghost" aria-busy={state.refreshing || undefined}
        disabled={state.refreshing} onClick={coding.onRefresh}>{state.refreshing ? 'Refreshing…' : 'Refresh runs'}</Button>}
      <Dialog.Close render={<Button type="button" variant="secondary">Close</Button>} />
    </div>
  </div>
}
