import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { BoundViewDescription, OperateSession } from '@gadgets/workshop-shared/api'
import { parseBoundViewSpec, type BoundViewSpec } from '@gadgets/workshop-shared/bound-view'
import type { ConsoleRef, HostBoardViewSnapshot } from '@gadgets/workshop-shared/operate-console'
import type { HostBoardClock, HostBoardReadIdentity, HostBoardViewState } from '../hostBoardState'
import { HOST_BOARD_TICK_MS, isGuardRefusal, type HostBoardReadSent } from '../useHostBoard'
import { contain, type BoundViewFailureSite } from './contain'
import { Budget, evaluateBoundView, type BoundViewEvaluation, type BoundViewTree } from './evaluate'
import { watchFrames } from './frameGate'
import { mountBoundRoot, type BoundRoot } from './BoundViewRenderer'

// The cohort of one shown bound view: its description, every requirement's accepted read, the
// frame gate and the dedicated root that renders them, kept together so that one signal clears
// all of it. Reads stay in the host-board hooks (one child per requirement); the cohort only
// decides which of their `ok` views it accepts, and when the whole view is torn down.

const now = (): HostBoardClock => ({ mono: performance.now(), wall: Date.now() })

// Context tokens rise for the page's lifetime, across views and refreshes, so a description
// requested under one context can never be taken for another's.
let lastContextToken = 0

/** Where a teardown was detected: a timer, observer, event or promise callback, or React's render/commit. */
export type BoundViewSignalOrigin = 'callback' | 'render'

/** The console revision and entry a view shows. */
export type BoundViewContext = { console: ConsoleRef; entryId: string }

/** The view's description, as accepted for the current context. */
export type BoundViewDescriptionState =
  | { status: 'loading' }
  | { status: 'ready'; commitId: string; spec: BoundViewSpec; requirements: readonly { name: string; hostBoardEntryId: string }[] }
  /** The description does not parse, or does not match the context or the console's host boards. */
  | { status: 'invalid' }
  | { status: 'unavailable' }

/** What the view shows now. Only `ok` holds anything derived from the reads. */
export type BoundViewShown =
  | { status: 'ok'; key: string; tree: BoundViewTree }
  /** Waiting for the description, a read of every requirement, or the first gate check. */
  | { status: 'waiting' }
  /** A frame-like element exists in the page. */
  | { status: 'blocked' }
  | { status: 'too-large' }
  | { status: 'invalid' }
  /** A contained failure: the view stays in this fixed state until it is reopened. */
  | { status: 'failed' }

type Tag = HostBoardReadSent & { epoch: number }
type Accepted = { read: HostBoardReadIdentity; board: HostBoardViewSnapshot }
type Member = { dispatch: (event: { type: 'invalidate' }) => void; tags: Map<number, Tag>; accepted: Accepted | null }

const sameConsole = (a: ConsoleRef, b: ConsoleRef) => a.consoleId === b.consoleId && a.source === b.source && a.revision === b.revision
const sameRead = (a: HostBoardReadIdentity, b: HostBoardReadIdentity) =>
  a.contextToken === b.contextToken && a.token === b.token && a.generation === b.generation
const expired = (read: HostBoardReadIdentity, at: HostBoardClock) => Math.min(read.deadlineMono - at.mono, read.deadlineWall - at.wall) <= 0
const remaining = (read: HostBoardReadIdentity, at: HostBoardClock) => Math.min(read.deadlineMono - at.mono, read.deadlineWall - at.wall)

/**
 * The state of one shown bound view (see the module comment). Its epoch starts at 1 and rises on
 * every invalidation signal; a read is accepted only if it was requested at the current epoch,
 * under the view's context, with the selection's `changeSeq` and generation unchanged since, and
 * unexpired. Any change to the description or to an accepted read starts a new snapshot set, and
 * evaluation results are cached per snapshot set only. Every method is safe to call from any
 * callback: it never throws, and a failure becomes the fixed `failed` state.
 */
export class BoundViewCohort {
  readonly context: BoundViewContext
  /** Where contained failures go: the view's fixed failure state. */
  readonly site: BoundViewFailureSite = () => this.fail()
  #epoch = 1
  #contextToken = ++lastContextToken
  #description: BoundViewDescriptionState = { status: 'loading' }
  #gate: 'unknown' | 'clear' | 'blocked' = 'unknown'
  #failed = false
  #members = new Map<string, Member>()
  #cache: { key: string; evaluation: BoundViewEvaluation } | null = null
  #container: HTMLElement | null = null
  #mount: ((container: HTMLElement, site: BoundViewFailureSite) => BoundRoot) | null = null
  #root: BoundRoot | null = null
  #rootKey: string | null = null
  #deadline: ReturnType<typeof setTimeout> | undefined
  #listeners = new Set<() => void>()
  #version = 0
  #disposed = false

  constructor(context: BoundViewContext) {
    this.context = context
  }

  /** The current epoch. */
  get epoch(): number { return this.#epoch }
  /** The current context token: new for every view and every "Refresh preview". */
  get contextToken(): number { return this.#contextToken }
  get description(): BoundViewDescriptionState { return this.#description }

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  /** For `useSyncExternalStore`: changes whenever anything shown may have. */
  version = (): number => this.#version

  #notify() {
    this.#version++
    for (const listener of Array.from(this.#listeners)) listener()
  }

  /**
   * Registers requirement `name`'s child, whose `dispatch` reaches its host-board machine. The
   * returned cleanup only unregisters: a child's unmount never invalidates, so a clear cannot loop.
   */
  register(name: string, dispatch: Member['dispatch']): () => void {
    const member: Member = { dispatch, tags: new Map(), accepted: null }
    this.#members.set(name, member)
    return () => { if (this.#members.get(name) === member) this.#members.delete(name) }
  }

  /** Tags read `readToken` of `name` with the current epoch, where the read is sent. */
  tag(name: string, readToken: number, sent: HostBoardReadSent): void {
    this.#members.get(name)?.tags.set(readToken, { ...sent, epoch: this.#epoch })
  }

  /**
   * Offers requirement `name`'s current view, read for `console` with the selection at
   * `changeSeq`; called after every commit of its child. An `ok` view is accepted if it fits (see
   * the class comment). A child whose accepted read is replaced by anything it cannot accept (it
   * left `ok` on its own tick, its selection changed, …) invalidates the whole cohort.
   */
  offer(name: string, console: ConsoleRef, view: HostBoardViewState, changeSeq: number | null): void {
    const member = this.#members.get(name)
    if (this.#disposed || !member) return
    if (view.status === 'ok' && member.accepted && sameRead(member.accepted.read, view.read)) return
    if (view.status === 'ok' && this.#acceptable(member, console, view.read, changeSeq)) {
      member.accepted = { read: view.read, board: view.board }
      this.#armDeadline()
      this.#notify()
      return
    }
    if (member.accepted) this.invalidate(this.#epoch, 'render')
  }

  #acceptable(member: Member, console: ConsoleRef, read: HostBoardReadIdentity, changeSeq: number | null): boolean {
    if (this.#gate !== 'clear' || this.#failed || this.#description.status !== 'ready') return false
    if (!sameConsole(console, this.context.console)) return false
    const tag = member.tags.get(read.token)
    return !!tag && tag.epoch === this.#epoch && tag.contextToken === read.contextToken && tag.generation === read.generation
      && changeSeq !== null && tag.changeSeq === changeSeq && !expired(read, now())
  }

  /**
   * Raises the epoch, but only if `seenEpoch` is still current, so N children signalling one
   * change raise it once, and a signal seen at an older epoch raises nothing. Raising clears every
   * accepted read and the evaluation cache, tears the dedicated root down (synchronously from a
   * callback; hidden now and unmounted in a microtask from render or commit), and tells every child
   * to invalidate, which re-reads under the new epoch. Returns whether it raised.
   */
  invalidate(seenEpoch: number, origin: BoundViewSignalOrigin): boolean {
    if (this.#disposed || seenEpoch !== this.#epoch) return false
    this.#epoch++
    this.#clearReads()
    this.#teardown(origin)
    this.#notify()
    for (const member of Array.from(this.#members.values())) {
      try { member.dispatch({ type: 'invalidate' }) } catch { this.fail() }
    }
    return true
  }

  /** The frame gate's result: a frame-like element appearing invalidates; its going away invalidates again for fresh reads. */
  gate(clear: boolean, origin: BoundViewSignalOrigin): void {
    if (this.#disposed) return
    const was = this.#gate
    this.#gate = clear ? 'clear' : 'blocked'
    if (was === this.#gate) return
    if (was === 'unknown' && clear) { this.#notify(); return }
    this.invalidate(this.#epoch, origin)
  }

  /** Rechecks every accepted read's expiry; one expired read invalidates them all. */
  expire(origin: BoundViewSignalOrigin): void {
    if (this.#disposed) return
    const at = now()
    if ([...this.#members.values()].some(member => member.accepted && expired(member.accepted.read, at))) {
      this.invalidate(this.#epoch, origin)
      return
    }
    this.#armDeadline()
  }

  // The cohort's own deadline timer, at the earliest accepted deadline.
  #armDeadline() {
    clearTimeout(this.#deadline)
    this.#deadline = undefined
    const at = now()
    let earliest = Infinity
    for (const member of this.#members.values()) if (member.accepted) earliest = Math.min(earliest, remaining(member.accepted.read, at))
    if (earliest === Infinity) return
    this.#deadline = setTimeout(contain(this.site, () => this.expire('callback')), Math.max(0, earliest))
  }

  /**
   * Accepts `description` if it was requested under context `token` (else it is late and ignored),
   * is for this view, parses with the v1 parser, and names exactly the spec's requirements, each
   * served by one of `hostBoardIds`. It is kept until the context changes.
   */
  setDescription(token: number, description: BoundViewDescription, hostBoardIds: ReadonlySet<string>): void {
    if (this.#disposed || token !== this.#contextToken || this.#description.status !== 'loading') return
    this.#description = this.#check(description, hostBoardIds)
    this.#notify()
  }

  #check(description: BoundViewDescription, hostBoardIds: ReadonlySet<string>): BoundViewDescriptionState {
    if (description.entryId !== this.context.entryId || !sameConsole(description.consoleRef, this.context.console)
      || typeof description.commitId !== 'string' || typeof description.specText !== 'string') return { status: 'invalid' }
    const parsed = parseBoundViewSpec(description.specText)
    if (!parsed.ok) return { status: 'invalid' }
    const names = parsed.spec.requirements
    const requirements = description.requirements.map(({ name, hostBoardEntryId }) => ({ name, hostBoardEntryId }))
    if (requirements.length !== names.length || new Set(requirements.map(item => item.name)).size !== names.length
      || requirements.some(item => !names.includes(item.name) || !hostBoardIds.has(item.hostBoardEntryId))) return { status: 'invalid' }
    return { status: 'ready', commitId: description.commitId, spec: parsed.spec, requirements }
  }

  /** The description requested under `token` could not be had. */
  descriptionFailed(token: number): void {
    if (this.#disposed || token !== this.#contextToken || this.#description.status !== 'loading') return
    this.#description = { status: 'unavailable' }
    this.#notify()
  }

  /**
   * "Refresh preview": mints a new context token and clears the description, every accepted read,
   * the caches and the dedicated root (synchronously: call it from the click handler), so nothing
   * from the old spec survives into the new one.
   */
  refresh(): void {
    if (this.#disposed) return
    this.#contextToken = ++lastContextToken
    this.#description = { status: 'loading' }
    this.#epoch++
    this.#clearReads()
    this.#teardown('callback')
    this.#notify()
  }

  /** The fixed failure state: everything is cleared and nothing is shown until the view is reopened. */
  fail(): void {
    if (this.#disposed || this.#failed) return
    this.#failed = true
    this.#clearReads()
    this.#teardown('render')
    this.#notify()
  }

  #clearReads() {
    for (const member of this.#members.values()) { member.accepted = null; member.tags.clear() }
    this.#cache = null
    clearTimeout(this.#deadline)
    this.#deadline = undefined
  }

  /**
   * What to show now. Expiry is rechecked here, so a suppressed timer can never leave an expired
   * read rendered. Each snapshot set — the epoch, the description `(contextToken, commitId)` and
   * every requirement's accepted read identity — is evaluated once, with a fresh `Budget`.
   */
  shown(at: HostBoardClock = now()): BoundViewShown {
    if (this.#failed) return { status: 'failed' }
    const description = this.#description
    if (description.status === 'invalid') return { status: 'invalid' }
    if (description.status !== 'ready') return { status: 'waiting' }
    if (this.#gate === 'blocked') return { status: 'blocked' }
    if (this.#gate !== 'clear') return { status: 'waiting' }
    const names = description.spec.requirements
    const reads = names.map(name => this.#members.get(name)?.accepted ?? null)
    if (reads.some(read => !read || expired(read.read, at))) return { status: 'waiting' }
    const key = JSON.stringify([this.#epoch, this.#contextToken, description.commitId,
      reads.map(read => [read!.read.contextToken, read!.read.token, read!.read.generation])])
    if (this.#cache?.key !== key) {
      const snapshots = new Map(names.map((name, index) => [name, reads[index]!.board]))
      let evaluation: BoundViewEvaluation | null = null
      // Contained like every other call: the evaluator is total, but a throw must still never
      // leave here. This runs in render, so the failure is recorded without notifying; the next
      // sync tears the root down.
      contain(() => { this.#failed = true }, () => { evaluation = evaluateBoundView(description.spec, snapshots, new Budget()) })()
      if (!evaluation) return { status: 'failed' }
      this.#cache = { key, evaluation }
    }
    const { evaluation } = this.#cache
    return evaluation.status === 'ok' ? { status: 'ok', key, tree: evaluation.tree } : evaluation
  }

  /**
   * Gives the cohort the element its dedicated root lives in (null when it goes away), and how to
   * mount one there, then syncs (see {@link sync}). Called from a ref callback, in a commit.
   */
  attach(container: HTMLElement | null, mount: (container: HTMLElement, site: BoundViewFailureSite) => BoundRoot): void {
    // Not gated on disposal: in StrictMode React detaches and re-attaches refs around a simulated
    // unmount, and the cohort is active again by the next commit's sync.
    if (container === this.#container) return
    this.#teardown('render')
    this.#container = container
    this.#mount = mount
    if (container) container.style.display = 'none'
    this.sync()
  }

  /**
   * Brings the dedicated root in line with {@link shown}; called in a layout effect after every
   * commit. A renderable snapshot set is rendered (into a new root after a teardown); anything else
   * hides the container now and unmounts the root in a microtask. An expired read found here
   * invalidates the cohort.
   */
  sync(): void {
    if (this.#disposed) return
    const at = now()
    const shown = this.shown(at)
    if (shown.status === 'ok') {
      if (!this.#container || !this.#mount) return
      if (!this.#root) { this.#root = this.#mount(this.#container, this.site); this.#rootKey = null }
      this.#container.style.display = ''
      if (this.#rootKey !== shown.key) { this.#root.render(shown.tree); this.#rootKey = shown.key }
      return
    }
    this.#teardown('render')
    if ([...this.#members.values()].some(member => member.accepted && expired(member.accepted.read, at))) this.invalidate(this.#epoch, 'render')
  }

  // React defers (with a warning) an unmount requested while it renders or commits, so from there
  // the container is hidden with an inline style, which no stylesheet rule overrides (it has no
  // class, and no rule targets it), and the root is unmounted in a microtask.
  #teardown(origin: BoundViewSignalOrigin) {
    if (this.#container) this.#container.style.display = 'none'
    const root = this.#root
    if (!root) return
    this.#root = null
    this.#rootKey = null
    const unmount = () => { try { root.unmount() } catch { /* dropped: the element is removed regardless */ } }
    if (origin === 'callback') unmount()
    else queueMicrotask(unmount)
  }

  /** (Re)activates the cohort when the view mounts; see {@link dispose}. */
  activate(): void {
    this.#disposed = false
  }

  /**
   * The view's own unmount: stops every timer, clears every read and drops the root (from a
   * layout-effect cleanup). StrictMode's simulated remount runs {@link activate} again, and its
   * children re-register and re-read, as after an invalidation.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#clearReads()
    this.#teardown('render')
    this.#disposed = true
    this.#members.clear()
  }
}

/**
 * The cohort of the bound view `context`, for the component that shows it. It fetches the
 * description for each context token (ignoring a late one), watches for frame-like elements,
 * rechecks expiry and the gate on the host boards' 5 s tick and on `visibilitychange`, `pagehide`
 * and `online`, and syncs the dedicated root inside the returned container after every commit.
 * Every callback is contained. The kernel refusing the console context calls `onRefused`.
 */
export const useBoundViewCohort = (session: RpcStub<OperateSession>, context: BoundViewContext, hostBoardIds: ReadonlySet<string>,
  onRefused: () => void) => {
  const [cohort] = useState(() => new BoundViewCohort(context))
  useSyncExternalStore(cohort.subscribe, cohort.version)
  // A ref callback, not an effect: the dialog may mount its content after the view's first commit.
  const [containerRef] = useState(() => contain(cohort.site, (element: HTMLDivElement | null) => cohort.attach(element, mountBoundRoot)))
  const refused = useRef(onRefused)
  refused.current = onRefused
  const ids = useRef(hostBoardIds)
  ids.current = hostBoardIds
  const token = cohort.contextToken

  useLayoutEffect(() => {
    cohort.activate()
    return () => cohort.dispose()
  }, [cohort])

  // The frame gate, in a committed effect: nothing is accepted before its first search.
  useLayoutEffect(() => {
    let watch: ReturnType<typeof watchFrames> | null = null
    contain(cohort.site, () => {
      watch = watchFrames(document, contain(cohort.site, (clear: boolean) => cohort.gate(clear, 'callback')))
      watch.check()
    })()
    const recheck = contain(cohort.site, () => cohort.expire('callback'))
    const tick = setInterval(contain(cohort.site, () => { cohort.expire('callback'); watch?.check() }), HOST_BOARD_TICK_MS)
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('pagehide', recheck)
    window.addEventListener('online', recheck)
    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('pagehide', recheck)
      window.removeEventListener('online', recheck)
      watch?.dispose()
    }
  }, [cohort])

  useEffect(() => contain(cohort.site, () => session.getConsoleBoundView(context.console, context.entryId)
    .then(description => cohort.setDescription(token, description, ids.current), (caught: unknown) => {
      cohort.descriptionFailed(token)
      if (isGuardRefusal(caught)) refused.current()
    }))(),
  // A new context token (a "Refresh preview") fetches anew; the view is remounted for any other context.
  [cohort, session, token])

  useLayoutEffect(() => contain(cohort.site, () => cohort.sync())())

  return { cohort, containerRef }
}
