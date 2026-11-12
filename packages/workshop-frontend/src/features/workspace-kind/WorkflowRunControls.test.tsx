// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-102 part 2: the workflow runs a use collaborator may ask for. Only the controls listing them,
// each a label and a button; a press reads "requested", never done; a refusal is the server's words.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import {
  WORKFLOW_BINDINGS_NEEDED, WORKFLOW_RUN_RETRY_REFUSED, WORKFLOW_RUN_RETRY_WINDOW_MS, type RequestedRun, type WorkflowDefinition,
} from '@gadgets/workshop-shared/workflow-definition'
import { RUN_OUTCOME_TEXT, RUN_REQUESTED_TEXT, WorkflowRunControls } from './WorkflowRunControls'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, onClick, disabled, 'aria-label': label }: {
    children: ReactNode; onClick?: () => void; disabled?: boolean; 'aria-label'?: string
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label}>{children}</button>
  ),
}))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(overseer: Partial<Overseer>) {
  await act(async () => {
    root.render(<WorkflowRunControls overseer={overseer as unknown as RpcStub<Overseer>} />)
  })
}
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)

it('renders nothing for someone no control lists', async () => {
  await render({ listTriggerControls: async () => [] })
  expect(container.innerHTML).toBe('')
})

it('shows only the label, runs the trigger on press and says it was requested, not done', async () => {
  const invokeTrigger = vi.fn<Overseer['invokeTrigger']>(async () =>
    ({ id: 'inv', hookId: 7, definitionId: 'def', revision: 1, requestedAt: new Date(0) }))
  // Even if more came back, nothing but the label is shown.
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now', invokers: ['someone-else'] } as never],
    invokeTrigger,
  })
  expect(container.textContent).toBe('Issue refunds now')
  // (Only the label before the press; afterwards, the requested line with its time.)
  await act(async () => { button('Issue refunds now')!.click() })
  expect(invokeTrigger).toHaveBeenCalledWith(7)
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^${RUN_REQUESTED_TEXT} \\(requested at .+\\)$`))
  expect(container.textContent).not.toMatch(/done\b(?!.*yet)|applied|succeeded/i)
})

it("shows a refusal in the server's words, the retry time included", async () => {
  const refusal = "You've run this trigger 3 times in the last 10 minutes. Try again in 7 minutes."
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
    invokeTrigger: async () => { throw new Error(refusal) },
  })
  await act(async () => { button('Issue refunds now')!.click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(refusal)
  expect(container.querySelector('[role="status"]')).toBeNull()
})

// FAC-116: the person sees what became of the runs they asked for, after any reconnect.
const run = (outcome: RequestedRun['outcome'], minute: number, extra: Partial<RequestedRun> = {}): RequestedRun =>
  ({ runId: `run-${minute}`, invocationId: `inv-${minute}`, revision: 1, requestedAt: new Date(2026, 10, 9, 14, minute), outcome, actions: [], ...extra })

it("shows the newest run's outcome when the page opens again, in words that never overstate it", async () => {
  const listRequestedRuns = vi.fn<Overseer['listRequestedRuns']>(async hookId =>
    hookId === 7 ? [run('succeeded', 5), run('failed', 1)] : [run('uncertain', 3, { reason: 'action-unknown' })])
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }, { hookId: 8, label: 'Close stale tickets' }],
    listRequestedRuns,
  })
  expect(listRequestedRuns.mock.calls.map(([hookId]) => hookId).toSorted()).toEqual([7, 8])
  const statuses = [...container.querySelectorAll('[role="status"]')].map(node => node.textContent)
  expect(statuses).toEqual([
    `Last run: ${RUN_OUTCOME_TEXT.succeeded} (requested at ${new Date(2026, 10, 9, 14, 5).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
    `Last run: ${RUN_OUTCOME_TEXT.uncertain} (requested at ${new Date(2026, 10, 9, 14, 3).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
  ])
})

it('words each outcome, and says only "requested" for one not finished', () => {
  expect(RUN_OUTCOME_TEXT.queued).toBe(RUN_REQUESTED_TEXT)
  expect(RUN_OUTCOME_TEXT.running).toBe(RUN_REQUESTED_TEXT)
  expect(RUN_OUTCOME_TEXT.waiting).toMatch(/waiting for approval/i)
  expect(RUN_OUTCOME_TEXT.succeeded).toMatch(/finished/i)
  expect(RUN_OUTCOME_TEXT.failed).toMatch(/didn't finish/i)
  expect(RUN_OUTCOME_TEXT.uncertain).toMatch(/may or may not/i)
})

it('follows a run it asked for until its outcome is final, then stops reading', async () => {
  vi.useFakeTimers()
  try {
    let answers = [[], [run('running', 9)], [run('waiting', 9)], [run('succeeded', 9)]]
    const listRequestedRuns = vi.fn<Overseer['listRequestedRuns']>(async () => answers.length > 1 ? answers.shift()! : answers[0]!)
    await render({
      listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
      invokeTrigger: async () => ({ id: 'inv-9', hookId: 7, definitionId: 'def', revision: 1, requestedAt: new Date(0) }),
      listRequestedRuns,
    })
    expect(container.querySelector('[role="status"]')).toBeNull()
    await act(async () => { button('Issue refunds now')!.click() })
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^Last run: ${RUN_REQUESTED_TEXT}`))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^Last run: ${RUN_OUTCOME_TEXT.waiting}`))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^Last run: ${RUN_OUTCOME_TEXT.succeeded}`))
    const reads = listRequestedRuns.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(listRequestedRuns.mock.calls.length).toBe(reads)
  } finally {
    vi.useRealTimers()
  }
})

it('still offers the control when its runs can\'t be read', async () => {
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
    listRequestedRuns: async () => { throw new Error('nope') },
  })
  expect(button('Issue refunds now')).toBeDefined()
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('keeps following a run whose outcome comes back unchanged, until it is final', async () => {
  vi.useFakeTimers()
  try {
    let answers = [[run('running', 9)], [run('running', 9)], [run('running', 9)], [run('succeeded', 9)]]
    const listRequestedRuns = vi.fn<Overseer['listRequestedRuns']>(async () => answers.length > 1 ? answers.shift()! : answers[0]!)
    await render({ listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }], listRequestedRuns })
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^Last run: ${RUN_REQUESTED_TEXT}`))
    for (let i = 0; i < 2; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^Last run: ${RUN_REQUESTED_TEXT}`))
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^Last run: ${RUN_OUTCOME_TEXT.succeeded}`))
    expect(listRequestedRuns).toHaveBeenCalledTimes(4)
  } finally {
    vi.useRealTimers()
  }
})

// FAC-123: a duplicate that can't run until its connections are set up.
const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const copyOf = (bindingsNeeded?: WorkflowDefinition['bindingsNeeded']): WorkflowDefinition => ({
  id: 'copy', title: 'Refunds (copy)', owner: ADA, published: null, bindingsNeeded,
  revisions: [{ revision: 1, source: { kind: 'gadget', gadgetId: 3, commitId: 'a'.repeat(40) }, savedAt: new Date(0) }],
})
const NEEDS = [{ name: 'BOARD', type: 'gatekeeper' as const, vendorId: 'inferops', typeUrlPattern: 'inferops://*', unmet: 'missing' as const }]
const pinnedControl = { hookId: 7, label: 'Issue refunds now', definition: { definitionId: 'copy', revision: 1 } }

it("disables its owner's control while its workflow's connections aren't set up, and says why", async () => {
  const invokeTrigger = vi.fn<Overseer['invokeTrigger']>()
  await render({
    listTriggerControls: async () => [pinnedControl],
    listRequestedRuns: async () => [],
    listWorkflowDefinitions: async () => [copyOf(NEEDS)],
    invokeTrigger,
  })
  expect(button('Issue refunds now')!.disabled).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toBe(`${WORKFLOW_BINDINGS_NEEDED} Set them up under Definitions.`)
  expect(invokeTrigger).not.toHaveBeenCalled()
})

it('leaves the control as it was once set up, or when the definitions can\'t be read', async () => {
  for (const listWorkflowDefinitions of [async () => [copyOf([])], async () => { throw new Error('no') }]) {
    await render({ listTriggerControls: async () => [pinnedControl], listRequestedRuns: async () => [], listWorkflowDefinitions })
    expect(button('Issue refunds now')!.disabled).toBe(false)
    expect(container.textContent).not.toContain('before it can run')
  }
})

it("says a run didn't finish because its connections weren't set up", async () => {
  const run: RequestedRun = { runId: 'r', invocationId: 'i', revision: 1, requestedAt: new Date(0), outcome: 'failed', reason: 'bindings-needed', actions: [] }
  await render({ listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }], listRequestedRuns: async () => [run] })
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Last run: Didn't finish: its connections aren't set up \(requested at .+\)$/)
})

// FAC-117 K2: Retry, another attempt of the same run, offered only on this person's own failed run.
const recent = (outcome: RequestedRun['outcome'], extra: Partial<RequestedRun> = {}): RequestedRun =>
  ({ runId: 'run-r', invocationId: 'inv-r', revision: 1, requestedAt: new Date(Date.now() - 60_000), outcome, actions: [], ...extra })
const retryButton = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry')

it("offers Retry only on the person's own newest run that failed, and retries that run", async () => {
  for (const outcome of ['queued', 'running', 'waiting', 'succeeded', 'uncertain'] as const) {
    await render({ listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }], listRequestedRuns: async () => [recent(outcome)] })
    expect(retryButton()).toBeUndefined()
  }
  // listRequestedRuns is the caller's own runs: with none of theirs, none to retry, whatever others ran.
  await render({ listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }], listRequestedRuns: async () => [] })
  expect(retryButton()).toBeUndefined()
  let retried = false
  const retryWorkflowRun = vi.fn<Overseer['retryWorkflowRun']>(async () => { retried = true; return recent('queued') })
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
    listRequestedRuns: async () => [retried ? recent('queued') : recent('failed', { reason: 'runtime-error' })],
    retryWorkflowRun,
  })
  expect(retryButton()!.getAttribute('aria-label')).toBe('Retry the last run of Issue refunds now')
  await act(async () => { retryButton()!.click() })
  expect(retryWorkflowRun).toHaveBeenCalledWith('inv-r')
  // The same run, queued again: requested, never done; and no Retry while it is.
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^Last run: ${RUN_REQUESTED_TEXT}`))
  expect(retryButton()).toBeUndefined()
})

it("disables Retry with the kernel's own sentence when the run says it can't be retried", async () => {
  const cases: [Partial<RequestedRun>, string][] = [
    [{ reason: 'cancelled' }, WORKFLOW_RUN_RETRY_REFUSED.cancelled],
    [{ reason: 'attempts-exhausted' }, WORKFLOW_RUN_RETRY_REFUSED.exhausted],
    [{ reason: 'runtime-error', requestedAt: new Date(Date.now() - WORKFLOW_RUN_RETRY_WINDOW_MS - 60_000) }, WORKFLOW_RUN_RETRY_REFUSED.tooOld],
  ]
  for (const [extra, sentence] of cases) {
    const retryWorkflowRun = vi.fn<Overseer['retryWorkflowRun']>()
    await render({
      listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
      listRequestedRuns: async () => [recent('failed', extra)],
      retryWorkflowRun,
    })
    expect(retryButton()!.disabled).toBe(true)
    expect([...container.querySelectorAll('[role="status"]')].map(n => n.textContent)).toContain(sentence)
    expect(retryWorkflowRun).not.toHaveBeenCalled()
  }
})

it("shows the server's refusal of a retry verbatim, never a generic error", async () => {
  for (const refusal of [WORKFLOW_RUN_RETRY_REFUSED.repinned, WORKFLOW_RUN_RETRY_REFUSED.tooOld, 'This trigger is paused, so it starts no new runs.']) {
    await render({
      listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
      listRequestedRuns: async () => [recent('failed', { reason: 'timed-out' })],
      retryWorkflowRun: async () => { throw new Error(refusal) },
    })
    await act(async () => { retryButton()!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(refusal)
  }
  // Only a rejection with no words of its own reads as the fixed sentence.
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
    listRequestedRuns: async () => [recent('failed', { reason: 'timed-out' })],
    retryWorkflowRun: async () => { throw 'lost' },
  })
  await act(async () => { retryButton()!.click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't retry this run.")
})
