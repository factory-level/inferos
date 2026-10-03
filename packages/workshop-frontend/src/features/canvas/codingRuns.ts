// Pure rules for the coding runs a board shows: how a run reads, which run an issue's card shows,
// which repositories may be picked, and what a refused dispatch or cancel tells the person. The
// runs themselves come from the project's coding-dispatch binding; InferOps stays authoritative.
import type { Repo, Run, RunReasonCode } from '@inferos/gatekeeper-inferops/src/types'
import { canonicalBoardRef, type ProposalResult } from './boardData'

/**
 * How a run reads on a card. `awaiting-approval` is a dispatch proposed through this connection
 * that is not decided yet; `blocked` and `tests-failed` are failed runs whose reason the runner
 * named, since each asks for something different of the person.
 */
export type RunPhase =
  | 'awaiting-approval' | 'queued' | 'running' | 'succeeded' | 'blocked' | 'tests-failed' | 'failed' | 'cancelled' | 'unknown'

export const RUN_PHASES: Record<RunPhase, { label: string; variant: 'warning' | 'neutral' | 'info' | 'success' | 'error' }> = {
  'awaiting-approval': { label: 'Dispatch awaiting approval', variant: 'warning' },
  queued: { label: 'Coding queued', variant: 'neutral' },
  running: { label: 'Coding running', variant: 'info' },
  succeeded: { label: 'Coding succeeded', variant: 'success' },
  blocked: { label: 'Coding blocked', variant: 'error' },
  'tests-failed': { label: 'Tests failed', variant: 'error' },
  failed: { label: 'Coding failed', variant: 'error' },
  cancelled: { label: 'Coding cancelled', variant: 'neutral' },
  unknown: { label: 'Coding outcome unknown', variant: 'warning' },
}

/** The action tag the gatekeeper gives a dispatch, which the action log carries. */
export const DISPATCH_ACTION_TAG = 'inferops.code-dispatch'

const BLOCKED: ReadonlySet<RunReasonCode | undefined> = new Set(['AUTH_BLOCKED', 'QUOTA_BLOCKED'])

export const runPhase = (run: Run): RunPhase => {
  if (run.pending === 'dispatch') return 'awaiting-approval'
  if (run.status === 'failed' && BLOCKED.has(run.result?.reasonCode)) return 'blocked'
  if (run.status === 'failed' && run.result?.reasonCode === 'TESTS_FAILED') return 'tests-failed'
  return run.status
}

/** A real run that has not finished. A provisional (pending dispatch) run does not exist yet. */
export const isActiveRun = (run: Run): boolean => run.pending !== 'dispatch' && (run.status === 'queued' || run.status === 'running')

/** Whether the run may change without anyone acting here: it is active, or a change of it awaits approval. */
export const needsFollowing = (run: Run): boolean => run.pending !== undefined || isActiveRun(run)

/** A cancel may be proposed for an active run that has no cancel pending already. */
export const isCancellable = (run: Run): boolean => isActiveRun(run) && run.pending !== 'cancel'

/**
 * The run an issue's card shows: its newest. The gatekeeper lists runs newest first, with
 * dispatches still awaiting approval ahead of every real run.
 */
export const latestRunOf = (runs: readonly Run[], issueId: string): Run | undefined => runs.find(run => run.issueId === issueId)

/** What the runner said about a blocked run, in terms of what the person can do about it. */
export const blockedReasonText = (code: RunReasonCode | undefined): string | null => {
  switch (code) {
    case 'AUTH_BLOCKED': return "The coding tool's sign-in is missing or expired. The runner is paused until someone signs it in again."
    case 'QUOTA_BLOCKED': return "The coding tool's plan has run out of usage. The runner is paused until the quota resets."
    default: return null
  }
}

/** A run as one sentence, for announcements and the card's accessible text. */
export const describeRun = (identifier: string, run: Run): string => {
  const phase = runPhase(run)
  const cancel = run.pending === 'cancel' ? ' A cancel is awaiting approval.' : ''
  switch (phase) {
    case 'awaiting-approval': return `Dispatch of ${identifier} is awaiting approval.`
    case 'queued': return `Coding run of ${identifier} is queued.${cancel}`
    case 'running': return `Coding run of ${identifier} is running.${cancel}`
    case 'succeeded': return `Coding run of ${identifier} succeeded.`
    case 'blocked': return `Coding run of ${identifier} is blocked. ${blockedReasonText(run.result?.reasonCode) ?? ''}`.trim()
    case 'tests-failed': return `Coding run of ${identifier} failed its tests.`
    case 'failed': return `Coding run of ${identifier} failed.`
    case 'cancelled': return `Coding run of ${identifier} was cancelled.`
    case 'unknown': return `Coding run of ${identifier} stopped with an unknown outcome; its work may be partly done.`
  }
}

/** Runs of `previous` that were active and are now finished in `current`, for announcing. */
export const finishedRuns = (previous: readonly Run[], current: readonly Run[]): Run[] => {
  const active = new Set(previous.filter(isActiveRun).map(run => run.id))
  return current.filter(run => active.has(run.id) && !isActiveRun(run))
}

/** Repositories a dispatch may name: listed in the workspace, enabled there, and allowed by this deployment. */
export const selectableRepos = (repos: readonly Repo[]): Repo[] => repos.filter(repo => repo.allowed && repo.enabled)

/** Why a repository cannot be picked, or null when it can. */
export const repoUnavailableReason = (repo: Repo): string | null =>
  !repo.allowed ? "not on this deployment's coding allowlist"
    : !repo.enabled ? 'disabled in InferOps'
      : null

/** The coding-dispatch reference for the same project as a board reference, or null for anything else. */
export const dispatchRefOf = (boardRef: string): string | null => {
  const match = /^(inferops:\/\/[^/]+)\/project\/board\/([^/]+)$/.exec(canonicalBoardRef(boardRef))
  return match ? `${match[1]}/project/dispatch/${match[2]}` : null
}

/** What a refused dispatch or cancel tells the person, by the gatekeeper's code. */
export const codingErrorText = (result: Extract<ProposalResult, { ok: false }>, identifier: string, kind: 'dispatch' | 'cancel'): string => {
  const verb = kind === 'dispatch' ? 'dispatched' : 'cancelled'
  switch (result.code) {
    case 'STALE_REVISION': return `${identifier} changed in InferOps since the board loaded. The board was re-read; try again.`
    case 'RUN_ACTIVE': return `${identifier} already has a queued or running run, or a dispatch awaiting approval. Follow it or cancel it first.`
    case 'DISABLED': return 'Coding dispatch is turned off for this deployment.'
    case 'FORBIDDEN': return `Not ${verb}: ${result.message}`
    case 'CONFLICT': return kind === 'cancel' ? `The run has already stopped: ${result.message}` : `Not ${verb}: ${result.message}`
    default: return `Not ${verb}: ${result.message}`
  }
}

/** "1.2 s" or "3 min 4 s", for a test command's duration. */
export const formatDuration = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`
}
