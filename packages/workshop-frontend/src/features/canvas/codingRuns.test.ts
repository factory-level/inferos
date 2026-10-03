import { expect, it } from 'vitest'
import type { Repo, Run } from '@inferos/gatekeeper-inferops/src/types'
import { codingErrorText, dispatchRefOf, finishedRuns, isCancellable, latestRunOf, needsFollowing, repoUnavailableReason, runPhase, selectableRepos } from './codingRuns'

const run = (id: string, extra: Partial<Run> = {}): Run => ({
  id, issueId: 'i1', issueIdentifier: 'ENG-1', repoId: 'r', status: 'queued', baseRef: null, externalRunId: null, result: null,
  error: null, queuedAt: '2026-10-03T00:00:00.000Z', startedAt: null, finishedAt: null, ...extra,
})

it('reads a failed run with a named reason as blocked or tests-failed, and a pending dispatch as awaiting approval', () => {
  expect(runPhase(run('p', { pending: 'dispatch' }))).toBe('awaiting-approval')
  expect(runPhase(run('a', { status: 'failed', result: { summary: '', reasonCode: 'AUTH_BLOCKED' } }))).toBe('blocked')
  expect(runPhase(run('a', { status: 'failed', result: { summary: '', reasonCode: 'QUOTA_BLOCKED' } }))).toBe('blocked')
  expect(runPhase(run('a', { status: 'failed', result: { summary: '', reasonCode: 'TESTS_FAILED' } }))).toBe('tests-failed')
  expect(runPhase(run('a', { status: 'failed' }))).toBe('failed')
  for (const status of ['queued', 'running', 'succeeded', 'cancelled', 'unknown'] as const) expect(runPhase(run('a', { status }))).toBe(status)
})

it('follows a run while it is active or a change of it awaits approval, and cancels only an active run once', () => {
  expect(needsFollowing(run('a', { status: 'running' }))).toBe(true)
  expect(needsFollowing(run('p', { pending: 'dispatch' }))).toBe(true)
  expect(needsFollowing(run('a', { status: 'succeeded' }))).toBe(false)
  expect(isCancellable(run('a', { status: 'running' }))).toBe(true)
  expect(isCancellable(run('a', { status: 'running', pending: 'cancel' }))).toBe(false)
  expect(isCancellable(run('p', { pending: 'dispatch' }))).toBe(false)
  expect(isCancellable(run('a', { status: 'failed' }))).toBe(false)
})

it("shows an issue's newest run, and names runs that have just finished", () => {
  const runs = [run('p', { pending: 'dispatch' }), run('b', { status: 'succeeded' }), run('c', { issueId: 'i2' })]
  expect(latestRunOf(runs, 'i1')?.id).toBe('p')
  expect(latestRunOf(runs, 'i2')?.id).toBe('c')
  expect(latestRunOf(runs, 'i3')).toBeUndefined()
  expect(finishedRuns([run('a', { status: 'running' }), run('b')], [run('a', { status: 'failed' }), run('b')]).map(r => r.id)).toEqual(['a'])
})

const repo = (slug: string, enabled: boolean, allowed: boolean): Repo => ({ id: slug, slug, defaultBaseRef: 'main', enabled, allowed })

it('offers only enabled, allowed repositories and says why the others are not', () => {
  const repos = [repo('ok', true, true), repo('off', false, true), repo('nope', true, false)]
  expect(selectableRepos(repos).map(r => r.slug)).toEqual(['ok'])
  expect(repos.map(repoUnavailableReason)).toEqual([null, 'disabled in InferOps', "not on this deployment's coding allowlist"])
})

it("maps a board reference to its project's coding-dispatch reference, and nothing else", () => {
  expect(dispatchRefOf('inferops://Acme.Ops/project/board/ENG')).toBe('inferops://acme.ops/project/dispatch/ENG')
  expect(dispatchRefOf('inferops://acme.ops/project/dispatch/ENG')).toBeNull()
  expect(dispatchRefOf('https://example.com/project/board/ENG')).toBeNull()
})

it('explains a refused cancel of a run that already stopped', () => {
  expect(codingErrorText({ ok: false, code: 'CONFLICT', message: 'The run of ENG-1 is already succeeded.' }, 'ENG-1', 'cancel'))
    .toBe('The run has already stopped: The run of ENG-1 is already succeeded.')
})
