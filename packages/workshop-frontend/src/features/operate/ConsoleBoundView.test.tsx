// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BoundViewDescription, OperateSession } from '@gadgets/workshop-shared/api'
import type { BoundViewEntry, ConsoleRef, HostBoardEntry, HostBoardSelectionUpdate, HostBoardView } from '@gadgets/workshop-shared/operate-console'

type Subscriber = { add: (...args: unknown[]) => void; remove: (id: number) => void; ready: () => void }
const accounts = vi.hoisted(() => ({ subscribers: [] as Subscriber[] }))
const api = vi.hoisted(() => ({ authenticatedApi: {
  subscribeConnectedAccounts: (subscriber: Subscriber) => {
    accounts.subscribers.push(subscriber)
    subscriber.add(7, { displayName: 'ada@acme.test' }, { displayName: 'InferOps' }, [], true, 'inferops')
    subscriber.ready()
    return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
  },
} }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => api }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a href="/gatekeepers">{children as never}</a> }))

// The real evaluator, observed: how often it runs, and how many frame-like elements exist then.
const evaluations = vi.hoisted(() => ({ count: 0, framesAtCall: [] as number[] }))
vi.mock('./boundView/evaluate', async importOriginal => {
  const actual = await importOriginal<typeof import('./boundView/evaluate')>()
  return { ...actual, evaluateBoundView: (...args: Parameters<typeof actual.evaluateBoundView>) => {
    evaluations.count++
    evaluations.framesAtCall.push(document.querySelectorAll('iframe, frame, object, embed, fencedframe').length)
    return actual.evaluateBoundView(...args)
  } }
})

import { ConsoleBoundView } from './ConsoleBoundView'
import { HOST_BOARD_REFRESH_MS } from './hostBoardState'
import { HOST_BOARD_TICK_MS } from './useHostBoard'

const REF: ConsoleRef = { consoleId: 'c1', source: 'published', revision: '4' }
const DRAFT: ConsoleRef = { consoleId: 'c1', source: 'draft', revision: '9' }
const ENTRY: BoundViewEntry & { id: string } = { kind: 'bound-view', id: 'bv1', gadgetId: 3, blueprintId: 'bp', version: 1, label: 'Triage view', requirements: ['a', 'b'] }
const BOARDS: HostBoardEntry[] = ['a', 'b'].map(name => ({ kind: 'host-board', id: `hb-${name}`, label: `Board ${name.toUpperCase()}`,
  requirement: { name, resource: 'inferops-board', target: `inferops://acme.ops/project/board/${name.toUpperCase()}` } }))
const spec = (field = 'title') => JSON.stringify({ version: 1, title: 'Triage', requirements: ['a', 'b'], root: { type: 'stack', children: [
  { type: 'list', of: { requirement: 'a', collection: 'issues' }, item: [{ type: 'field', value: { field } }], empty: 'Nothing in A' },
  { type: 'count', label: 'Issues in B', of: { requirement: 'b', collection: 'issues' } },
] } })
const description = (ref: ConsoleRef, commitId = 'commit-a', specText = spec()): BoundViewDescription => ({ consoleRef: ref, entryId: 'bv1', commitId, specText,
  requirements: [{ name: 'a', hostBoardEntryId: 'hb-a' }, { name: 'b', hostBoardEntryId: 'hb-b' }] })
const ok = (ref: ConsoleRef, ...titles: string[]): HostBoardView => ({ status: 'ok', readAt: new Date().toISOString(), publicationRevision: ref.revision, board: {
  project: { identifier: 'ENG', name: 'Engineering' },
  columns: [{ label: 'Todo', group: 'unstarted', issues: titles.map((title, index) => ({ identifier: `ENG-${index + 1}`, title, priority: 'high', targetDate: null, blocked: false })) }],
} })

// A fake kernel: one handle per `getConsoleHostBoard`, by host board, whose reads and subscriber
// the test drives; descriptions answered from a queue.
type Handle = { reads: Array<(view: HostBoardView) => void>; pending: Set<(view: HostBoardView) => void>; deliver: (update: HostBoardSelectionUpdate) => void }
let handles: Map<string, Handle[]>
let descriptions: BoundViewDescription[]
const getConsoleBoundView = vi.fn<(ref: ConsoleRef, entryId: string, options?: { commitId?: string }) => Promise<BoundViewDescription>>()
const session = {
  getConsoleBoundView,
  getConsoleHostBoard: (_: ConsoleRef, entryId: string) => {
    const handle: Handle = { reads: [], pending: new Set(), deliver: () => {} }
    handles.set(entryId, [...handles.get(entryId) ?? [], handle])
    return {
      readRequirement: () => new Promise<HostBoardView>(resolve => {
        const settle = (view: HostBoardView) => { handle.pending.delete(settle); resolve(view) }
        handle.reads.push(settle)
        handle.pending.add(settle)
      }),
      subscribeSelection: async (subscriber: (update: HostBoardSelectionUpdate) => void) => {
        handle.deliver = subscriber
        return { [Symbol.dispose]: () => {} }
      },
      [Symbol.dispose]: () => {},
    }
  },
  selectHostBoardConnection: async () => ({ status: 'selected' }),
} as unknown as RpcStub<OperateSession>

let root: Root
let host: HTMLDivElement
let consoleErrors: unknown[][]
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  handles = new Map(); descriptions = []; accounts.subscribers = []
  evaluations.count = 0; evaluations.framesAtCall = []
  getConsoleBoundView.mockReset()
  getConsoleBoundView.mockImplementation(async () => {
    const next = descriptions.shift()
    if (!next) throw new Error('no description queued')
    return next
  })
  consoleErrors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { consoleErrors.push(args) })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove()
  document.body.replaceChildren()
  // No path may make React defer an unmount it was asked for while rendering.
  const warnings = consoleErrors.map(args => args.map(String).join(' ')).filter(line => /unmount/i.test(line))
  if (warnings.length > 0) throw new Error(`React warned: ${warnings.join('; ')}`)
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const onRefused = vi.fn<() => void>()
const render = (ref = REF) => act(async () => root.render(<ConsoleBoundView session={session} console={ref} entry={ENTRY} hostBoards={BOARDS}
  onClose={() => {}} onRefused={onRefused} onStaleOrUnavailable={() => {}} />))
const handle = (name: string) => handles.get(`hb-${name}`)!.at(-1)!
const select = (name: string, changeSeq = 1, selectionEpoch = 1) => act(async () => handle(name).deliver({ state: 'selected', changeSeq, selectionEpoch }))
const answer = (name: string, view: HostBoardView) => act(async () => { const reads = handle(name).reads; reads[reads.length - 1](view) })
/** Answers every read of `name` still pending, and any it sends meanwhile (a superseded read's queued successor). */
const answerAll = async (name: string, view: HostBoardView) => {
  for (let round = 0; round < 5 && handle(name).pending.size > 0; round++) {
    // Each settle removes itself, which a Set's iteration allows.
    await act(async () => { for (const settle of handle(name).pending) settle(view) })
  }
}
/** The dedicated root's container. */
const shownView = () => document.querySelector<HTMLElement>('[data-bound-view]')!
const shownText = () => shownView().textContent ?? ''
/** Everything the parent root shows, outside the dedicated root. */
const parentText = () => {
  const dialog = shownView().closest('[role="dialog"]') ?? document.body
  const copy = dialog.cloneNode(true) as HTMLElement
  copy.querySelector('[data-bound-view]')?.replaceChildren()
  return copy.textContent ?? ''
}
// Microtasks only, so it works under fake timers too: every fake here settles through promises,
// and MutationObserver callbacks are microtasks.
const flush = () => act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() })

/** Opens the view and lets both requirements read: A with `titles`, B with one issue. */
const open = async (ref = REF, titles = ['Fix the login']) => {
  descriptions.push(description(ref))
  await render(ref)
  await select('a'); await select('b')
  await answer('a', ok(ref, ...titles)); await answer('b', ok(ref, 'B one'))
}

describe('showing a bound view', () => {
  it('renders once every requirement has a fresh read; the parent root shows statuses only', async () => {
    descriptions.push(description(REF))
    await render()
    expect(getConsoleBoundView).toHaveBeenCalledWith(REF, 'bv1')
    await select('a'); await select('b')
    await answer('a', ok(REF, 'Fix the login'))
    expect(shownText()).toBe('')
    await answer('b', ok(REF, 'B one'))
    expect(shownText()).toContain('Fix the login')
    expect(shownText()).toContain('Issues in B 1')
    expect(parentText()).not.toContain('Fix the login')
    expect(parentText()).toContain('Triage')
  })

  it('renders under StrictMode, whose simulated remount disposes and reactivates the cohort', async () => {
    descriptions.push(description(REF), description(REF))
    await act(async () => root.render(<StrictMode><ConsoleBoundView session={session} console={REF} entry={ENTRY} hostBoards={BOARDS}
      onClose={() => {}} onRefused={onRefused} onStaleOrUnavailable={() => {}} /></StrictMode>))
    await select('a'); await select('b')
    await answerAll('a', ok(REF, 'Strict')); await answerAll('b', ok(REF, 'B one'))
    expect(shownText()).toContain('Strict')
  })

  it('evaluates each snapshot set once, however often it re-renders', async () => {
    await open()
    expect(evaluations.count).toBe(1)
    await act(async () => root.render(<ConsoleBoundView session={session} console={REF} entry={ENTRY} hostBoards={BOARDS}
      onClose={() => {}} onRefused={onRefused} onStaleOrUnavailable={() => {}} />))
    await flush()
    expect(evaluations.count).toBe(1)
  })

  it('reruns every query on a same-epoch refresh with a new read token, so a removed issue is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    await open(REF, ['Issue X', 'Issue Y'])
    expect(shownText()).toContain('Issue X')
    await act(async () => { vi.advanceTimersByTime(HOST_BOARD_REFRESH_MS) })
    await answer('a', ok(REF, 'Issue Y'))
    expect(shownText()).toContain('Issue Y')
    expect(shownText()).not.toContain('Issue X')
    expect(evaluations.count).toBeGreaterThanOrEqual(2)
  })

  it('clears the whole view when one requirement\'s selection changes, and re-reads both', async () => {
    await open()
    const before = [handle('a').reads.length, handle('b').reads.length]
    await select('b', 2, 2)
    expect(shownText()).toBe('')
    expect([handle('a').reads.length, handle('b').reads.length]).toEqual([before[0] + 1, before[1] + 1])
  })

  it('ignores the description request of a superseded session, so a swapped stub\'s answer is kept', async () => {
    onRefused.mockClear()
    let rejectOld: (reason: unknown) => void = () => {}
    getConsoleBoundView.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
    await render()
    // The same account's session, through a new stub: the view fetches again under the same context.
    descriptions.push(description(REF))
    const swapped = { ...session } as unknown as RpcStub<OperateSession>
    await act(async () => root.render(<ConsoleBoundView session={swapped} console={REF} entry={ENTRY} hostBoards={BOARDS}
      onClose={() => {}} onRefused={onRefused} onStaleOrUnavailable={() => {}} />))
    await act(async () => rejectOld(new Error('Console c1 at revision 4 is not open in your operate session with bound view bv1.')))
    expect(getConsoleBoundView).toHaveBeenCalledTimes(2)
    expect(onRefused).not.toHaveBeenCalled()
    expect(parentText()).not.toContain('This view is unavailable right now')
    expect(parentText()).toContain('Triage')
  })

  it('says it is waiting, and reads again at once when a read was sent under an older changeSeq', async () => {
    descriptions.push(description(REF))
    await render()
    await select('a'); await select('b')
    expect(parentText()).toContain('Waiting for a fresh read of every board this view uses')
    // A changeSeq-only bump (same state and epoch) while A's read is in flight.
    await select('a', 2, 1)
    const sent = handle('a').reads.length
    await answer('a', ok(REF, 'Sent under 1')); await answer('b', ok(REF, 'B one'))
    expect(shownText()).toBe('')
    expect(handle('a').reads.length).toBe(sent + 1)
    await answer('a', ok(REF, 'Sent under 2'))
    expect(shownText()).toContain('Sent under 2')
    expect(parentText()).not.toContain('Waiting for a fresh read')
  })

  it('closes on a guard refusal of its description', async () => {
    getConsoleBoundView.mockRejectedValueOnce(new Error('Console c1 at revision 4 is not open in your operate session with bound view bv1.'))
    await render()
    expect(onRefused).toHaveBeenCalledOnce()
    expect(parentText()).toContain('This view is unavailable right now')
  })
})

describe('expiry', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })

  it('empties the container synchronously inside the cohort\'s deadline timer', async () => {
    fake()
    await open()
    expect(shownView().childNodes.length).toBe(1)
    // Not in act(): nothing React schedules can run before the check, so only the timer's own
    // synchronous unmount can have emptied it.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    vi.advanceTimersByTime(60_000)
    expect(shownView().childNodes.length).toBe(0)
    expect(shownView().style.display).toBe('none')
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    await flush()
  })

  it('empties it synchronously inside the cohort\'s tick when the deadline timer was suppressed', async () => {
    fake()
    await open()
    // The wall clock jumps past the deadline while no timer runs (a device sleep): only the 5 s
    // tick, which rechecks both clocks, can notice.
    vi.setSystemTime(Date.now() + 61_000)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    vi.advanceTimersByTime(HOST_BOARD_TICK_MS)
    expect(shownView().childNodes.length).toBe(0)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    await flush()
    expect(shownText()).toBe('')
  })

  it('hides it in the commit and empties it a microtask later when the host board\'s own tick clears a read', async () => {
    fake()
    await open()
    // The wall clock moving back makes the host-board hook treat its read as expired on its tick;
    // the cohort's deadlines have not passed, so the change is seen only in render.
    vi.setSystemTime(Date.now() - 2 * HOST_BOARD_TICK_MS)
    act(() => { vi.advanceTimersByTime(HOST_BOARD_TICK_MS) })
    expect(shownView().style.display).toBe('none')
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    await Promise.resolve()
    expect(shownView().childNodes.length).toBe(0)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  it('hides it at once and empties it a microtask later when the view itself unmounts', async () => {
    await open()
    const view = shownView()
    act(() => root.render(<></>))
    expect(view.style.display).toBe('none')
    // Outside act(), so the microtask runs exactly as it would in the page.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    await Promise.resolve()
    expect(view.childNodes.length).toBe(0)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  it('never renders an expired read, even when every timer is suppressed', async () => {
    fake()
    await open()
    vi.setSystemTime(Date.now() + 61_000)
    // A re-render with no timer run: expiry is rechecked at render.
    await act(async () => root.render(<ConsoleBoundView session={session} console={REF} entry={ENTRY} hostBoards={BOARDS}
      onClose={() => {}} onRefused={onRefused} onStaleOrUnavailable={() => {}} />))
    expect(shownView().style.display).toBe('none')
    await Promise.resolve()
    expect(shownText()).toBe('')
  })
})

describe('draft preview', () => {
  it('stays on the commit it first read across an account change, and moves only on "Refresh preview"', async () => {
    await open(DRAFT)
    expect(parentText()).toContain('commit-a')
    // An account change (as after a newer Build commit) clears and re-reads, but keeps the description.
    await act(async () => accounts.subscribers[0].add(8, { displayName: 'bo@acme.test' }, { displayName: 'InferOps' }, [], true, 'inferops'))
    expect(shownText()).toBe('')
    await answer('a', ok(DRAFT, 'Again')); await answer('b', ok(DRAFT, 'B one'))
    expect(shownText()).toContain('Again')
    expect(getConsoleBoundView).toHaveBeenCalledOnce()
    expect(parentText()).toContain('commit-a')

    descriptions.push(description(DRAFT, 'commit-b', spec('identifier')))
    const refresh = [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh preview')!
    act(() => refresh.click())
    // Emptied inside the click handler, before anything is fetched or rendered.
    expect(shownView().childNodes.length).toBe(0)
    await flush()
    expect(getConsoleBoundView).toHaveBeenCalledTimes(2)
    expect(getConsoleBoundView.mock.calls[1]).toEqual([DRAFT, 'bv1'])
    expect(parentText()).toContain('commit-b')
    expect(shownText()).toBe('')
    await select('a'); await select('b')
    await answer('a', ok(DRAFT, 'Again')); await answer('b', ok(DRAFT, 'B one'))
    expect(shownText()).toContain('ENG-1')
    expect(shownText()).not.toContain('Again')
  })
})

describe('the frame gate', () => {
  it('evaluates only while no frame-like element exists', async () => {
    await open()
    expect(evaluations.framesAtCall).toEqual([0])
  })

  it.each(['iframe', 'frame', 'object', 'embed', 'fencedframe'])('clears the view at once when a %s appears, and resumes with fresh reads once it is gone', async tag => {
    await open()
    const frame = document.createElement(tag)
    document.body.append(frame)
    await act(async () => { await Promise.resolve() })
    expect(shownView().childNodes.length).toBe(0)
    expect(parentText()).toContain('Close the other window or widget to see this view.')
    frame.remove()
    await flush()
    await answerAll('a', ok(REF, 'Fresh')); await answerAll('b', ok(REF, 'B one'))
    expect(shownText()).toContain('Fresh')
    expect(evaluations.framesAtCall.every(count => count === 0)).toBe(true)
  })

  it('sees an iframe inserted into an open shadow root that already existed', async () => {
    const shadowHost = document.createElement('div')
    document.body.append(shadowHost)
    const shadow = shadowHost.attachShadow({ mode: 'open' })
    await open()
    expect(shownText()).toContain('Fix the login')
    shadow.append(document.createElement('iframe'))
    await act(async () => { await Promise.resolve() })
    expect(shownView().childNodes.length).toBe(0)
  })

  it('blocks while the chat\'s connection-accept dialog holds its configurator frame, and resumes when it closes', async () => {
    await open()
    // SandboxedResourceConfigurator portals its iframe into the body while GatekeeperModal is open.
    const portal = document.createElement('div')
    portal.append(document.createElement('iframe'))
    document.body.append(portal)
    await act(async () => { await Promise.resolve() })
    expect(parentText()).toContain('Close the other window or widget')
    portal.remove()
    await flush()
    await answerAll('a', ok(REF, 'Back')); await answerAll('b', ok(REF, 'B one'))
    expect(shownText()).toContain('Back')
  })

  it('accepts nothing while a frame exists from the start', async () => {
    document.body.append(document.createElement('iframe'))
    await open()
    expect(evaluations.count).toBe(0)
    expect(shownText()).toBe('')
    expect(parentText()).toContain('Close the other window or widget')
  })
})
