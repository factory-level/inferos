// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoundViewDescription } from '@gadgets/workshop-shared/api'
import type { HostBoardViewSnapshot } from '@gadgets/workshop-shared/operate-console'
import type { HostBoardViewState } from '../hostBoardState'

// The real evaluator, counted, so a test can tell whether a snapshot set was evaluated again.
const evaluations = vi.hoisted(() => ({ count: 0 }))
vi.mock('./evaluate', async importOriginal => {
  const actual = await importOriginal<typeof import('./evaluate')>()
  return { ...actual, evaluateBoundView: (...args: Parameters<typeof actual.evaluateBoundView>) => { evaluations.count++; return actual.evaluateBoundView(...args) } }
})

import { BoundViewCohort } from './useBoundViewCohort'
import type { BoundRoot } from './BoundViewRenderer'
import type { BoundViewTree } from './evaluate'

const CONSOLE = { consoleId: 'c1', source: 'draft' as const, revision: '3' }
const SPEC = (field = 'title', requirements = ['a', 'b']) => JSON.stringify({ version: 1, title: 'Triage', requirements, root: { type: 'stack', children: requirements.map(requirement => (
  { type: 'list', of: { requirement, collection: 'issues' }, item: [{ type: 'field', value: { field } }], empty: 'None' })) } })
const describeView = (commitId = 'commit-a', specText = SPEC()): BoundViewDescription => ({ consoleRef: CONSOLE, entryId: 'bv1', commitId, specText,
  requirements: [{ name: 'a', hostBoardEntryId: 'hb-a' }, { name: 'b', hostBoardEntryId: 'hb-b' }] })
const IDS = new Set(['hb-a', 'hb-b'])
const board = (...titles: string[]): HostBoardViewSnapshot => ({ project: { identifier: 'ENG', name: 'Engineering' },
  columns: [{ label: 'Todo', group: 'unstarted', issues: titles.map((title, index) => ({ identifier: `ENG-${index}`, title, priority: 'none', targetDate: null, blocked: false })) }] })

/** A child: its host-board hook's read identities, minted like the hook mints them. */
const child = (cohort: BoundViewCohort, name: string, contextToken: number) => {
  const dispatched: string[] = []
  let token = 0
  const unregister = cohort.register(name, event => dispatched.push(event.type))
  return {
    dispatched,
    unregister,
    /** Sends a read now (at the cohort's current epoch); returns its `ok` view, to offer once it answers. */
    request(snapshot: HostBoardViewSnapshot, options: { generation?: number; changeSeq?: number; lifetime?: number } = {}) {
      const read = { contextToken, token: ++token, generation: options.generation ?? 0 }
      cohort.tag(name, read.token, { contextToken, generation: read.generation, changeSeq: options.changeSeq ?? 1 })
      const lifetime = options.lifetime ?? 60_000
      return { status: 'ok', board: snapshot, readAt: new Date().toISOString(),
        read: { ...read, deadlineMono: performance.now() + lifetime, deadlineWall: Date.now() + lifetime } } as HostBoardViewState
    },
  }
}

/** A dedicated root that records what it rendered, and whether it is mounted. */
const mounts: { tree: BoundViewTree | null; mounted: boolean; element: HTMLElement }[] = []
const mount = (container: HTMLElement): BoundRoot => {
  const element = document.createElement('div')
  container.append(element)
  const record = { tree: null as BoundViewTree | null, mounted: true, element }
  mounts.push(record)
  return { render: tree => { record.tree = tree; element.textContent = JSON.stringify(tree) }, unmount: () => { record.mounted = false; element.remove() } }
}

let container: HTMLDivElement
const ready = (cohort = new BoundViewCohort({ console: CONSOLE, entryId: 'bv1' })) => {
  cohort.attach(container, mount)
  cohort.setDescription(cohort.contextToken, describeView(), IDS)
  cohort.gate(true, 'callback')
  return cohort
}
beforeEach(() => {
  evaluations.count = 0
  mounts.length = 0
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => { container.remove(); vi.useRealTimers() })

const shownText = (cohort: BoundViewCohort) => {
  const shown = cohort.shown()
  return shown.status === 'ok' ? JSON.stringify(shown.tree) : shown.status
}

describe('accepting reads', () => {
  it('shows nothing until every requirement has an accepted read, then evaluates the snapshot set once', () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    cohort.offer('a', CONSOLE, a.request(board('Fix the login')), 1)
    expect(cohort.shown().status).toBe('waiting')
    cohort.offer('b', CONSOLE, b.request(board('Ship it')), 1)
    expect(shownText(cohort)).toContain('Fix the login')
    expect(evaluations.count).toBe(1)
    // Re-renders within one snapshot set run zero queries.
    cohort.shown(); cohort.shown(); cohort.sync()
    expect(evaluations.count).toBe(1)
  })

  it('accepts a same-epoch refresh (a new read token) as a new snapshot set, so a removed issue is gone', () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    cohort.offer('a', CONSOLE, a.request(board('Issue X', 'Issue Y')), 1)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    expect(shownText(cohort)).toContain('Issue X')
    const epoch = cohort.epoch
    cohort.offer('a', CONSOLE, a.request(board('Issue Y')), 1)
    expect(cohort.epoch).toBe(epoch)
    expect(shownText(cohort)).not.toContain('Issue X')
    expect(evaluations.count).toBe(2)
  })

  it.each([
    ['tagged at an older epoch', (cohort: BoundViewCohort, a: ReturnType<typeof child>) => { const view = a.request(board('Late')); cohort.invalidate(cohort.epoch, 'callback'); return view }],
    ['never tagged', (_: BoundViewCohort, a: ReturnType<typeof child>) => ({ ...a.request(board('Late')), read: { contextToken: 11, token: 99, generation: 0, deadlineMono: performance.now() + 60_000, deadlineWall: Date.now() + 60_000 } }) as HostBoardViewState],
    ['from another hook context', (_: BoundViewCohort, a: ReturnType<typeof child>) => { const view = a.request(board('Late')); return { ...view, read: { ...(view as { read: object }).read, contextToken: 99 } } as HostBoardViewState }],
    ['sent at another generation', (_: BoundViewCohort, a: ReturnType<typeof child>) => { const view = a.request(board('Late')); return { ...view, read: { ...(view as { read: object }).read, generation: 5 } } as HostBoardViewState }],
    ['already expired', (_: BoundViewCohort, a: ReturnType<typeof child>) => a.request(board('Late'), { lifetime: 0 })],
  ])('ignores a read %s', (_, make) => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    cohort.offer('a', CONSOLE, make(cohort, a), 1)
    const b = child(cohort, 'b', 12)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    expect(cohort.shown().status).toBe('waiting')
  })

  it('ignores a read whose selection changeSeq moved since it was sent, or that was read for another console', () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    cohort.offer('a', CONSOLE, a.request(board('Late'), { changeSeq: 1 }), 2)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    expect(cohort.shown().status).toBe('waiting')
    cohort.offer('a', { ...CONSOLE, revision: '4' }, a.request(board('Late')), 1)
    expect(cohort.shown().status).toBe('waiting')
  })

  it('asks only that child to read again, once per read, when its read was sent under an older changeSeq or epoch', () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    // A changeSeq-only bump while A's read was in flight: the host board does not re-read on its own.
    const late = a.request(board('Late'), { changeSeq: 1 })
    cohort.offer('a', CONSOLE, late, 2)
    expect(a.dispatched).toEqual(['invalidate'])
    cohort.offer('a', CONSOLE, late, 2)
    expect(a.dispatched).toEqual(['invalidate'])
    expect(b.dispatched).toEqual([])
    // Its new read, sent under the current changeSeq, is accepted.
    cohort.offer('a', CONSOLE, a.request(board('Fresh'), { changeSeq: 2 }), 2)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    expect(shownText(cohort)).toContain('Fresh')
    // Nothing is re-read for another console, an untagged read, or before the description is ready.
    const other = ready()
    const c = child(other, 'a', 13)
    other.offer('a', { ...CONSOLE, revision: '4' }, c.request(board(), { changeSeq: 1 }), 2)
    const untagged = { ...c.request(board()), read: { contextToken: 13, token: 99, generation: 0, deadlineMono: performance.now() + 60_000, deadlineWall: Date.now() + 60_000 } } as HostBoardViewState
    other.offer('a', CONSOLE, untagged, 1)
    expect(c.dispatched).toEqual([])
    const loading = new BoundViewCohort({ console: CONSOLE, entryId: 'bv1' })
    loading.gate(true, 'callback')
    const d = child(loading, 'a', 14)
    loading.offer('a', CONSOLE, d.request(board(), { changeSeq: 1 }), 2)
    expect(d.dispatched).toEqual([])
  })

  it('accepts nothing before the frame gate first passes, and nothing while it is blocked', () => {
    const cohort = new BoundViewCohort({ console: CONSOLE, entryId: 'bv1' })
    cohort.attach(container, mount)
    cohort.setDescription(cohort.contextToken, describeView(), IDS)
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    cohort.offer('a', CONSOLE, a.request(board('Early')), 1)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    expect(cohort.shown().status).toBe('waiting')
    cohort.gate(false, 'callback')
    cohort.offer('a', CONSOLE, a.request(board('Early')), 1)
    expect(cohort.shown().status).toBe('blocked')
  })
})

describe('invalidation', () => {
  it('raises the epoch once for N children signalling at one epoch, and tells every child', () => {
    const cohort = ready()
    const children = ['a', 'b'].map((name, index) => child(cohort, name, 11 + index))
    const seen = cohort.epoch
    expect(cohort.invalidate(seen, 'callback')).toBe(true)
    expect(cohort.invalidate(seen, 'callback')).toBe(false)
    expect(cohort.epoch).toBe(seen + 1)
    expect(children.map(item => item.dispatched)).toEqual([['invalidate'], ['invalidate']])
  })

  it('never invalidates on a child\'s cleanup', () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const epoch = cohort.epoch
    a.unregister()
    expect(cohort.epoch).toBe(epoch)
  })

  it('raises nothing for a stale signal while a fresh read is in flight, and still accepts that read', () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    const stale = cohort.epoch
    cohort.invalidate(stale, 'callback')
    const fresh = a.request(board('Fresh'))
    expect(cohort.invalidate(stale, 'callback')).toBe(false)
    cohort.offer('a', CONSOLE, fresh, 1)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    expect(shownText(cohort)).toContain('Fresh')
  })

  it('clears every accepted read together when one member expires', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    cohort.offer('a', CONSOLE, a.request(board('Short'), { lifetime: 10_000 }), 1)
    cohort.offer('b', CONSOLE, b.request(board('Long'), { lifetime: 60_000 }), 1)
    cohort.sync()
    expect(mounts[0].mounted).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(cohort.shown().status).toBe('waiting')
    expect(a.dispatched).toEqual(['invalidate'])
    expect(b.dispatched).toEqual(['invalidate'])
    // The deadline timer is a callback: the root was unmounted synchronously, inside it.
    expect(mounts[0].mounted).toBe(false)
    expect(container.childNodes.length).toBe(0)
  })

  it('invalidates when a child\'s accepted read is replaced by a view it cannot accept (left ok on its own tick)', async () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    cohort.offer('a', CONSOLE, a.request(board('Shown')), 1)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    cohort.sync()
    const epoch = cohort.epoch
    cohort.offer('a', CONSOLE, { status: 'cleared' }, 1)
    expect(cohort.epoch).toBe(epoch + 1)
    // Detected in a commit: hidden now, unmounted in a microtask.
    expect(container.style.display).toBe('none')
    expect(mounts[0].mounted).toBe(true)
    await Promise.resolve()
    expect(mounts[0].mounted).toBe(false)
    expect(container.childNodes.length).toBe(0)
  })
})

describe('the description', () => {
  it('ignores a late description requested under an older context token', () => {
    const cohort = new BoundViewCohort({ console: CONSOLE, entryId: 'bv1' })
    const old = cohort.contextToken
    cohort.refresh()
    cohort.setDescription(old, describeView('commit-old'), IDS)
    expect(cohort.description.status).toBe('loading')
    cohort.setDescription(cohort.contextToken, describeView('commit-new'), IDS)
    expect(cohort.description).toMatchObject({ status: 'ready', commitId: 'commit-new' })
  })

  it.each([
    ['another entry', { ...describeView(), entryId: 'bv2' }],
    ['another revision', { ...describeView(), consoleRef: { ...CONSOLE, revision: '4' } }],
    ['a spec that does not parse', describeView('c', '{"version":1}')],
    ['a requirement served by no host board of the console', { ...describeView(), requirements: [{ name: 'a', hostBoardEntryId: 'hb-a' }, { name: 'b', hostBoardEntryId: 'hb-x' }] }],
    ['requirements other than the spec\'s', { ...describeView(), requirements: [{ name: 'a', hostBoardEntryId: 'hb-a' }] }],
  ])('refuses a description for %s as invalid', (_, description) => {
    const cohort = new BoundViewCohort({ console: CONSOLE, entryId: 'bv1' })
    cohort.setDescription(cohort.contextToken, description as BoundViewDescription, IDS)
    expect(cohort.description.status).toBe('invalid')
    expect(cohort.shown().status).toBe('invalid')
  })

  it('keeps the description across epochs', () => {
    const cohort = ready()
    cohort.invalidate(cohort.epoch, 'callback')
    cohort.expire('callback')
    cohort.gate(false, 'callback')
    cohort.gate(true, 'callback')
    expect(cohort.description).toMatchObject({ status: 'ready', commitId: 'commit-a' })
  })

  it('on "Refresh preview", empties the container at once, and renders nothing of the old spec under the new commit, even for reads with the same identity', () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    const viewA = a.request(board('Old spec'))
    const viewB = b.request(board())
    cohort.offer('a', CONSOLE, viewA, 1)
    cohort.offer('b', CONSOLE, viewB, 1)
    cohort.sync()
    expect(container.textContent).toContain('Old spec')
    const before = cohort.contextToken
    cohort.refresh()
    expect(cohort.contextToken).toBeGreaterThan(before)
    expect(container.childNodes.length).toBe(0)
    cohort.setDescription(cohort.contextToken, describeView('commit-b', SPEC('identifier')), IDS)
    // The very same views, offered again under the new context, carry tags of the old one.
    cohort.offer('a', CONSOLE, viewA, 1)
    cohort.offer('b', CONSOLE, viewB, 1)
    cohort.sync()
    expect(cohort.shown().status).toBe('waiting')
    expect(container.childNodes.length).toBe(0)
    // Fresh reads under the new context render the new spec.
    cohort.offer('a', CONSOLE, a.request(board('Old spec')), 1)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    cohort.sync()
    expect(container.textContent).toContain('ENG-0')
    expect(container.textContent).not.toContain('Old spec')
  })
})

describe('failure and disposal', () => {
  it('turns a failure into the fixed failed state, with nothing shown', async () => {
    const cohort = ready()
    const a = child(cohort, 'a', 11)
    const b = child(cohort, 'b', 12)
    cohort.offer('a', CONSOLE, a.request(board('Shown')), 1)
    cohort.offer('b', CONSOLE, b.request(board()), 1)
    cohort.sync()
    cohort.site({ type: 'BoundViewFailure' })
    expect(cohort.shown().status).toBe('failed')
    await Promise.resolve()
    expect(container.childNodes.length).toBe(0)
  })

  it('a child whose dispatch throws fails the view rather than throwing', () => {
    const cohort = ready()
    cohort.register('a', () => { throw new Error('dispatch') })
    expect(() => cohort.invalidate(cohort.epoch, 'callback')).not.toThrow()
    expect(cohort.shown().status).toBe('failed')
  })
})
