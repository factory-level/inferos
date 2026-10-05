// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
// The coding control surface on a board: offered only with the project's coding-dispatch
// connection and only where the surface asks for it, proposed through the approval path, and
// following the run InferOps reports.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import type { Board, DispatchTarget, Issue, Repo, Run, RunResult } from '@inferos/gatekeeper-inferops/src/types'
import { CanvasBoardWidget } from './CanvasBoardWidget'
import { dialogField, setFieldValue } from './kumoPopupDoubles'

vi.mock('@cloudflare/kumo', async importOriginal =>
  (await import('./kumoPopupDoubles')).withKumoPopupDoubles(await importOriginal<typeof import('@cloudflare/kumo')>()))

let root: Root
let container: HTMLDivElement
const BOARD = 'inferops://demo.local/project/board/DEMO'
const DISPATCH = 'inferops://demo.local/project/dispatch/DEMO'
const REPO = '50000000-0000-4000-8000-000000000001'
const issue = (id: string, extra: Partial<Issue> = {}): Issue => ({
  id, identifier: `DEMO-${id}`, title: `Issue ${id}`, priority: 'none', stateId: 'todo', targetDate: null, workflow: 'software',
  revision: '7', assigneeId: null, blockedReason: null, ...extra,
})
const demo: Board = {
  project: { id: 'p', identifier: 'DEMO', name: 'Demo' },
  columns: [{ state: { id: 'todo', name: 'Todo', group: 'unstarted', position: 0, workflow: 'software' }, issues: [issue('1'), issue('2')] }],
}
const repos: Repo[] = [
  { id: REPO, slug: 'demo-app', defaultBaseRef: 'main', enabled: true, allowed: true },
  { id: '50000000-0000-4000-8000-000000000002', slug: 'legacy-app', defaultBaseRef: 'main', enabled: false, allowed: true },
  { id: '50000000-0000-4000-8000-000000000003', slug: 'other-app', defaultBaseRef: 'main', enabled: true, allowed: false },
]
const run = (id: string, issueId: string, extra: Partial<Run> = {}): Run => ({
  id, issueId, issueIdentifier: `DEMO-${issueId}`, repoId: REPO, status: 'queued', baseRef: null, externalRunId: null, result: null,
  error: null, queuedAt: '2026-10-03T00:00:00.000Z', startedAt: null, finishedAt: null, ...extra,
})
const widget: CanvasProjectBoardWidget = { id: 'w', kind: 'inferops.project-board', version: 1, targetRef: BOARD, size: 'wide', params: { workflow: 'software', showCompleted: false } }

let runs: Run[]
// Like the gatekeeper: a dispatch shows as a provisional run until decided; a cancel marks the run.
const dispatch = vi.fn<(key: string, target: DispatchTarget, revision: string) => Promise<void>>(async key => {
  runs = [run('pending-1', key.replace('DEMO-', ''), { pending: 'dispatch' }), ...runs]
})
const cancel = vi.fn<(runId: string) => Promise<void>>(async runId => {
  runs = runs.map(r => r.id === runId ? { ...r, pending: 'cancel' as const } : r)
})
const listRuns = vi.fn<() => Promise<Run[]>>(async () => runs)
const listRepos = vi.fn<() => Promise<Repo[]>>(async () => repos)
const dispatchSession = { listRepos, listRuns, dispatch, cancel, [Symbol.dispose]: () => {} }
const boardSession = { readBoard: async () => demo, openIssue: () => ({}), createIssue: async () => {}, [Symbol.dispose]: () => {} }
const connections: Record<string, object | null> = {}
const lookup = vi.fn<(url: string) => Promise<object | null>>(async url => connections[url] ?? null)
let overseer: RpcStub<Overseer>
let actions: ActionsSubscriber | undefined

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const render = async (element: ReactElement) => { await act(async () => root.render(element)); await settle() }
const board = (codingDispatch = true) => render(<CanvasBoardWidget widget={widget} overseer={overseer} presentation="full" codingDispatch={codingDispatch} />)
const card = (id: string) => container.querySelector<HTMLElement>(`[data-issue-id="${id}"]`)!
const codingButton = (id: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="Coding task for DEMO-${id}"]`)
const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')
const dialogButton = (text: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)
const open = async (id: string) => { await act(async () => { codingButton(id)!.click() }); await settle() }
const dialogStatus = () => dialog()!.querySelector('[role="status"]')?.textContent
const dialogAlert = () => dialog()!.querySelector('[role="alert"]')?.textContent
const dispatchAction = (id: number, state: ActionLogEntry['state'], issueKey = 'DEMO-1'): ActionLogEntry => ({
  id, type: 'action', state, resourceUrl: DISPATCH, resourceTitle: 'InferOps coding dispatch DEMO', createdAt: new Date(), requestedBy: 'person',
  description: { title: `Dispatch ${issueKey} to demo-app`, description: '', fields: [{ label: 'Issue', kind: 'inline', value: issueKey }],
    actionKind: { tag: 'inferops.code-dispatch', label: 'Dispatch a coding task' } },
} as ActionLogEntry)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  overseer = {
    getGatekeeperByResourceUrl: lookup,
    subscribeToActions: async (subscriber: ActionsSubscriber) => { actions = subscriber; return { [Symbol.dispose]: () => {} } },
    listActions: async () => ({ entries: [] }),
  } as unknown as RpcStub<Overseer>
  runs = []
  connections[BOARD] = { openSession: async () => boardSession, [Symbol.dispose]: () => {} }
  connections[DISPATCH] = { openSession: async () => dispatchSession, [Symbol.dispose]: () => {} }
  for (const mock of [dispatch, cancel, listRuns, listRepos, lookup]) mock.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('offers no coding control at all without a coding-dispatch connection for the project, and never looks one up when the surface does not ask', async () => {
  connections[DISPATCH] = null
  await board()
  expect(lookup).toHaveBeenCalledWith(DISPATCH)
  expect(card('1')).not.toBeNull()
  expect(codingButton('1')).toBeNull()

  await act(async () => root.unmount()); root = createRoot(container)
  connections[DISPATCH] = { openSession: async () => dispatchSession, [Symbol.dispose]: () => {} }
  lookup.mockClear()
  await board(false)
  expect(card('1')).not.toBeNull()
  expect(codingButton('1')).toBeNull()
  expect(lookup.mock.calls.map(([url]) => url)).not.toContain(DISPATCH)
})

it('dispatches to an allowed repository through approval: proposing, awaiting approval, then applied with the run queued', async () => {
  await board()
  await open('1')
  expect(dialog()!.querySelector('h2')?.textContent).toBe('Coding task for DEMO-1')
  expect(dialog()!.textContent).toContain('DEMO-1 has no coding run yet.')
  // Only an enabled, allowed repository is offered; the others say why not.
  expect([...dialogField<HTMLSelectElement>(container, 'Repository').options].map(o => o.textContent)).toEqual(['demo-app'])
  const notOffered = dialog()!.querySelector('[aria-label="Repositories not offered"]')!.textContent
  expect(notOffered).toContain('legacy-app: disabled in InferOps')
  expect(notOffered).toContain("other-app: not on this deployment's coding allowlist")

  let finish!: () => void
  dispatch.mockImplementationOnce(async key => {
    await new Promise<void>(resolve => { finish = resolve })
    runs = [run('pending-1', key.replace('DEMO-', ''), { pending: 'dispatch' }), ...runs]
  })
  await act(async () => { dialogButton('Propose dispatch')!.click() })
  expect(dialogStatus()).toBe('Proposing to dispatch DEMO-1…')
  await act(async () => { finish(); await settle() })
  expect(dispatch).toHaveBeenCalledWith('DEMO-1', { repoId: REPO }, '7')
  expect(dialogStatus()).toContain('Dispatch of DEMO-1 is awaiting approval. Nothing runs until it is approved')
  expect(dialogButton('Propose dispatch')).toBeUndefined()
  expect(card('1').textContent).toContain('Dispatch awaiting approval')

  await act(async () => { actions?.entry(dispatchAction(5, 'pending')) })
  expect(container.querySelector('section[aria-label="Board activity"]')?.textContent).toContain('Person is waiting for approval: Dispatch DEMO-1 to demo-app')

  // Approved: InferOps queued the run, and the decided action re-reads the runs.
  runs = [run('r1', '1')]
  await act(async () => { actions?.entry(dispatchAction(5, 'approved')); await settle() })
  expect(dialogStatus()).toBe('Dispatch of DEMO-1 approved: InferOps queued the run.')
  expect(dialog()!.querySelector('[aria-label="Latest coding run"]')?.textContent).toContain('Waiting for the local runner to claim it.')
  expect(card('1').textContent).toContain('Coding queued')
  expect(dialogButton('Propose cancel')).toBeDefined()
})

const refuse = async (message: string) => {
  dispatch.mockRejectedValueOnce(new Error(message))
  await act(async () => { dialogButton('Propose dispatch')!.click(); await settle() })
  return dialogAlert()
}

it('says why a dispatch was refused: allowlist, an active run, a stale revision, coding turned off', async () => {
  await board()
  await open('1')
  expect(await refuse(`FORBIDDEN: Repository ${REPO} is not on this deployment's coding allowlist.`))
    .toBe(`Not dispatched: Repository ${REPO} is not on this deployment's coding allowlist.`)
  expect(await refuse('RUN_ACTIVE: DEMO-1 already has a running run. Follow it or cancel it first.'))
    .toBe('DEMO-1 already has a queued or running run, or a dispatch awaiting approval. Follow it or cancel it first.')
  expect(await refuse('STALE_REVISION: DEMO-1 is at revision 8, not 7. Read it again.'))
    .toBe('DEMO-1 changed in InferOps since the board loaded. The board was re-read; try again.')
  expect(await refuse('DISABLED: Coding dispatch is turned off for this deployment.'))
    .toBe('Coding dispatch is turned off for this deployment.')
  // A refusal is never shown as queued.
  expect(dialogStatus()).toBe('')
  expect(card('1').textContent).not.toContain('Dispatch awaiting approval')
})

it('says when the deployment has coding dispatch turned off, with no dispatch form', async () => {
  listRepos.mockRejectedValue(new Error('DISABLED: Coding dispatch is turned off for this deployment.'))
  await board()
  await open('1')
  expect(dialog()!.textContent).toContain('Coding dispatch is turned off for this deployment. Runs already queued stay in InferOps')
  expect(dialogButton('Propose dispatch')).toBeUndefined()
  listRepos.mockReset().mockImplementation(async () => repos)
})

const finished = (status: Run['status'], result: RunResult | null, extra: Partial<Run> = {}) =>
  run('r1', '1', { status, result, startedAt: '2026-10-03T00:01:00.000Z', finishedAt: '2026-10-03T00:09:00.000Z', ...extra })
const patch = { path: '/runs/r1/result.patch', sha256: 'ab'.repeat(32), files: 3, insertions: 12, deletions: 4 }
const command = (index: number, exitCode: number | null) => ({
  index, argv: ['pnpm', 'test'], exitCode, timedOut: exitCode === null, durationMs: 8123, truncated: false,
  artifacts: { stdout: `/runs/r1/.inferops-artifacts/test-${index}.stdout`, stderr: `/runs/r1/.inferops-artifacts/test-${index}.stderr`, record: `/runs/r1/.inferops-artifacts/test-${index}.json` },
})

it.each([
  ['queued', run('r1', '1'), 'Coding queued', 'Waiting for the local runner to claim it.'],
  ['running', run('r1', '1', { status: 'running' }), 'Coding running', 'Coding running'],
  ['blocked (sign-in)', finished('failed', { summary: 'stopped', reasonCode: 'AUTH_BLOCKED' }, { error: 'AUTH_BLOCKED: not logged in' }), 'Coding blocked', "sign-in is missing or expired"],
  ['blocked (quota)', finished('failed', { summary: 'stopped', reasonCode: 'QUOTA_BLOCKED' }), 'Coding blocked', 'run out of usage'],
  ['failed', finished('failed', null, { error: 'Codex exited 1' }), 'Coding failed', 'Codex exited 1'],
  ['cancelled', finished('cancelled', null), 'Coding cancelled', 'Coding cancelled'],
  ['unknown', finished('unknown', null), 'Coding outcome unknown', 'its work may be partly done'],
])('shows a %s run on the card and in the dialog', async (_name, shown, badge, detail) => {
  runs = [shown]
  await board()
  expect(card('1').textContent).toContain(badge)
  await open('1')
  expect(dialog()!.querySelector('[aria-label="Latest coding run"]')?.textContent).toContain(detail)
  // Only an active run can be cancelled, and only a finished one can be dispatched again.
  const active = shown.status === 'queued' || shown.status === 'running'
  expect(dialogButton('Propose cancel') !== undefined).toBe(active)
  expect(dialogButton('Propose a new dispatch') !== undefined).toBe(!active)
})

it('shows a succeeded run with its patch, the tests the runner ran and their artifacts, and the summary as not evidence', async () => {
  runs = [finished('succeeded', { summary: 'Added the endpoint.', patch, testSummary: '1 of 1 passed.',
    tests: { directory: '/runs/r1/.inferops-artifacts', passed: 1, failed: 0, commands: [command(1, 0)] } })]
  await board()
  expect(card('1').textContent).toContain('Coding succeeded')
  await open('1')
  const details = dialog()!.querySelector('[aria-label="Latest coding run"]')!.textContent
  expect(details).toContain('Patch /runs/r1/result.patch: 3 files, +12 −4')
  expect(details).toContain('Tests the runner ran: 1 passed, 0 failed. Artifacts in /runs/r1/.inferops-artifacts')
  expect(dialog()!.querySelector('[aria-label="Test commands"]')?.textContent).toContain('Passed pnpm test exit 0, 8.1 s')
  expect(details).toContain('Output /runs/r1/.inferops-artifacts/test-1.stdout, errors /runs/r1/.inferops-artifacts/test-1.stderr, record /runs/r1/.inferops-artifacts/test-1.json')
  expect(details).toContain("Runner's summary (its own account, not evidence): Added the endpoint.")
})

it('shows a run that failed its tests as such, keeping its patch and the failing command', async () => {
  runs = [finished('failed', { summary: 'Done', patch, reasonCode: 'TESTS_FAILED', testSummary: '1 of 2 passed.',
    tests: { directory: '/runs/r1/.inferops-artifacts', passed: 1, failed: 1, commands: [command(1, 0), command(2, null)] } },
  { error: 'TESTS_FAILED: 1 of 2 passed.' })]
  await board()
  expect(card('1').querySelector('[data-run-phase]')?.getAttribute('data-run-phase')).toBe('tests-failed')
  expect(card('1').textContent).toContain('Tests failed')
  await open('1')
  const details = dialog()!.querySelector('[aria-label="Latest coding run"]')!.textContent
  expect(details).toContain('Tests the runner ran: 1 passed, 1 failed.')
  expect(details).toContain('Patch /runs/r1/result.patch')
  expect(dialog()!.querySelector('[aria-label="Test commands"]')?.textContent).toContain('Failed pnpm test timed out')
})

it('proposes a cancel of an active run through approval, and announces the run once it stops', async () => {
  runs = [run('r1', '1', { status: 'running' })]
  await board()
  await open('1')
  await act(async () => { dialogButton('Propose cancel')!.click(); await settle() })
  expect(cancel).toHaveBeenCalledWith('r1')
  expect(dialogStatus()).toBe('Cancel of the running run of DEMO-1 is awaiting approval. The run stops once it is approved.')
  expect(card('1').textContent).toContain('Cancel awaiting approval')
  expect(dialogButton('Propose cancel')).toBeUndefined()

  // Approved: a running run ends unknown.
  runs = [finished('unknown', null)]
  await act(async () => { actions?.entry({ ...dispatchAction(6, 'approved'), description: { title: 'Cancel the running run of DEMO-1', description: '',
    fields: [{ label: 'Issue', kind: 'inline', value: 'DEMO-1' }], actionKind: { tag: 'inferops.run-cancel', label: 'Cancel a coding run' } } } as ActionLogEntry); await settle() })
  expect(card('1').textContent).toContain('Coding outcome unknown')
  expect([...container.querySelectorAll('[role="status"]')].map(s => s.textContent))
    .toContain('Coding run of DEMO-1 stopped with an unknown outcome; its work may be partly done.')
})

it('follows active runs on a backoff and stops once they finish', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  runs = [run('r1', '1', { status: 'running' })]
  await act(async () => root.render(<CanvasBoardWidget widget={widget} overseer={overseer} presentation="full" codingDispatch />))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(listRuns).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(9_999) })
  expect(listRuns).toHaveBeenCalledTimes(1)
  runs = [finished('succeeded', { summary: 'ok' })]
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(listRuns).toHaveBeenCalledTimes(2)
  expect(card('1').textContent).toContain('Coding succeeded')
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
  expect(listRuns).toHaveBeenCalledTimes(2)
  // Repositories are read once, not on every follow-up.
  expect(listRepos).toHaveBeenCalledTimes(1)
})

it('does not offer coding for a content issue', async () => {
  const content = { ...demo, columns: [{ ...demo.columns[0]!, state: { ...demo.columns[0]!.state, workflow: 'content' as const }, issues: [issue('1', { workflow: 'content' })] }] }
  connections[BOARD] = { openSession: async () => ({ ...boardSession, readBoard: async () => content }), [Symbol.dispose]: () => {} }
  await render(<CanvasBoardWidget widget={{ ...widget, params: { ...widget.params, workflow: 'content' } }} overseer={overseer} presentation="full" codingDispatch />)
  expect(card('1')).not.toBeNull()
  expect(codingButton('1')).toBeNull()
})

// Keeps the dialog field helper honest: the double renders a native select.
it('lets the repository be picked when several are offered', async () => {
  const second = { ...repos[0]!, id: '50000000-0000-4000-8000-000000000009', slug: 'web-app', defaultBaseRef: 'develop' }
  listRepos.mockResolvedValueOnce([...repos, second])
  await board()
  await open('1')
  await act(async () => setFieldValue(dialogField(container, 'Repository'), second.id))
  expect(dialog()!.textContent).toContain("default branch (develop)")
  await act(async () => { dialogButton('Propose dispatch')!.click(); await settle() })
  expect(dispatch).toHaveBeenCalledWith('DEMO-1', { repoId: second.id }, '7')
})

it('keeps an open coding dialog mounted when its card leaves a long column’s window', async () => {
  const large: Board = { ...demo, columns: [{ ...demo.columns[0]!, issues: Array.from({ length: 100 }, (_, index) => issue(String(index + 1))) }] }
  const read = vi.spyOn(boardSession, 'readBoard').mockResolvedValue(large)
  try {
    await board()
    await open('2')
    await act(async () => {
      const list = container.querySelector<HTMLUListElement>('[data-state-id="todo"] ul')!
      list.scrollTop = 60 * 148
      list.dispatchEvent(new Event('scroll'))
    })
    expect(card('2')).not.toBeNull()
    expect(card('3')).toBeNull()
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Coding task for DEMO-2')
    expect(dialogButton('Propose dispatch')).toBeDefined()
  } finally { read.mockRestore() }
})
