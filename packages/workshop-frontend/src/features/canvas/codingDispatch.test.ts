import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { Run } from '@inferos/gatekeeper-inferops/src/types'
import { CodingDispatchData, FOLLOW_DELAYS_MS, FOLLOW_LIMIT } from './codingDispatch'

const DISPATCH = 'inferops://demo.local/project/dispatch/DEMO'
const running: Run = {
  id: 'r1', issueId: 'i1', issueIdentifier: 'DEMO-1', repoId: 'repo', status: 'running', baseRef: null, externalRunId: null,
  result: null, error: null, queuedAt: '2026-10-03T00:00:00.000Z', startedAt: null, finishedAt: null,
}
const listRuns = vi.fn<() => Promise<Run[]>>()
const listRepos = vi.fn<() => Promise<never[]>>(async () => [])
const dispose = vi.fn<() => void>()
const session = { listRuns, listRepos, [Symbol.dispose]: dispose }
const lookup = vi.fn<(url: string) => Promise<object | null>>()
const overseer = { getGatekeeperByResourceUrl: lookup } as unknown as RpcStub<Overseer>
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  listRuns.mockReset().mockResolvedValue([running])
  listRepos.mockClear(); dispose.mockClear()
  lookup.mockReset().mockResolvedValue({ openSession: async () => session, [Symbol.dispose]: () => {} })
})
afterEach(() => { vi.useRealTimers() })

it('stays unavailable, and reads nothing more, when the workspace holds no coding-dispatch connection', async () => {
  lookup.mockResolvedValue(null)
  const data = new CodingDispatchData(overseer, DISPATCH)
  await flush()
  expect(data.state).toEqual({ status: 'unavailable' })
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(lookup).toHaveBeenCalledTimes(1)
  data.dispose()
})

it('stops following after the limit and says so; a refresh follows afresh', async () => {
  const data = new CodingDispatchData(overseer, DISPATCH)
  await flush()
  const waited = FOLLOW_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + (FOLLOW_LIMIT - FOLLOW_DELAYS_MS.length) * FOLLOW_DELAYS_MS.at(-1)!
  await vi.advanceTimersByTimeAsync(waited)
  expect(listRuns).toHaveBeenCalledTimes(1 + FOLLOW_LIMIT)
  expect(data.state).toMatchObject({ status: 'ready', followStopped: true })
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(listRuns).toHaveBeenCalledTimes(1 + FOLLOW_LIMIT)
  data.refresh()
  await flush()
  expect(data.state).not.toHaveProperty('followStopped')
  expect(listRuns).toHaveBeenCalledTimes(2 + FOLLOW_LIMIT)
  data.dispose()
})

it('coalesces refreshes asked for during a read into one more read, and stops following on a failed read', async () => {
  let release!: (runs: Run[]) => void
  listRuns.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const data = new CodingDispatchData(overseer, DISPATCH)
  await flush()
  data.refresh(); data.refresh(); data.refresh()
  release([running])
  await flush()
  expect(listRuns).toHaveBeenCalledTimes(2)
  listRuns.mockRejectedValueOnce(new Error('UNAVAILABLE: InferOps did not answer.'))
  await vi.advanceTimersByTimeAsync(FOLLOW_DELAYS_MS[0]!)
  expect(data.state).toMatchObject({ status: 'ready', runs: [running], error: 'InferOps did not answer.' })
  expect(dispose).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(listRuns).toHaveBeenCalledTimes(3)
  data.dispose()
})

it('drops the session and discards late results once disposed', async () => {
  const data = new CodingDispatchData(overseer, DISPATCH)
  data.dispose()
  await flush()
  expect(data.state).toEqual({ status: 'unavailable' })
  expect(dispose).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(listRuns).not.toHaveBeenCalled()
})
