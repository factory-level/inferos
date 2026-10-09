import type { HostBoardTarget } from './hostBoardTypes'

// The connection picker's intent rules for a host board, as a pure reducer. The caller keeps the
// state in a ref and dispatches synchronously, so the in-flight latch holds before any re-render:
// a second click or Enter cannot submit twice.

/** The exact intent a `requestKey` is bound to. */
export type HostBoardPickIntent = {
  consoleId: string
  source: 'published' | 'draft'
  revision: string
  entryId: string
  accountId: number
}

/** The picker's state. `contextToken` is null once the view unmounted. */
export type HostBoardPickerState = {
  contextToken: number | null
  inFlight: { requestKey: string } | null
  /** The last unfinished intent and its key, reused when the same intent is retried. */
  last: { fingerprint: string; requestKey: string; intent: HostBoardPickIntent } | null
  failed: boolean
}

/** An effect for the caller: select, or tell the view the selection committed. */
export type HostBoardPickerCommand =
  | { type: 'select'; requestKey: string; intent: HostBoardPickIntent; contextToken: number }
  | { type: 'connected' }

/** What can happen to the picker. */
export type HostBoardPickerEvent =
  | { type: 'context'; contextToken: number | null }
  /** `freshKey` is used only when the intent is new; the caller generates it (`crypto.randomUUID()`). */
  | { type: 'submit'; target: HostBoardTarget; accountId: number; freshKey: string }
  /** Sends the last intent again with its key, after a lost answer; nothing otherwise. */
  | { type: 'retry' }
  /**
   * A selection call ended: `selected`; `settled` (the kernel answered `superseded` or `failed`,
   * which it would answer that key again, so the next submit takes a fresh key); or `lost` (the
   * call threw, so whether it was made is unknown and a retry of the same intent reuses its key).
   */
  | { type: 'completed'; contextToken: number; requestKey: string; outcome: 'selected' | 'settled' | 'lost' }

/** The picker's state for a mounted context. */
export const initialHostBoardPickerState = (contextToken: number): HostBoardPickerState =>
  ({ contextToken, inFlight: null, last: null, failed: false })

const intentOf = (target: HostBoardTarget, accountId: number): HostBoardPickIntent => ({
  consoleId: target.console.consoleId,
  source: target.console.source,
  revision: target.console.revision,
  entryId: target.entryId,
  accountId,
})

const fingerprintOf = (intent: HostBoardPickIntent) =>
  JSON.stringify([intent.consoleId, intent.source, intent.revision, intent.entryId, intent.accountId])

/** Applies one picker event. */
export const reduceHostBoardPicker = (state: HostBoardPickerState, event: HostBoardPickerEvent):
  { state: HostBoardPickerState; commands: HostBoardPickerCommand[] } => {
  switch (event.type) {
    case 'context':
      return { state: { contextToken: event.contextToken, inFlight: null, last: null, failed: false }, commands: [] }
    case 'submit': {
      if (state.inFlight || state.contextToken === null) return { state, commands: [] }
      const intent = intentOf(event.target, event.accountId)
      const fingerprint = fingerprintOf(intent)
      const requestKey = state.last?.fingerprint === fingerprint ? state.last.requestKey : event.freshKey
      return {
        state: { ...state, inFlight: { requestKey }, last: { fingerprint, requestKey, intent }, failed: false },
        commands: [{ type: 'select', requestKey, intent, contextToken: state.contextToken }],
      }
    }
    case 'retry': {
      if (state.inFlight || state.contextToken === null || !state.failed || !state.last) return { state, commands: [] }
      const { requestKey, intent } = state.last
      return {
        state: { ...state, inFlight: { requestKey }, failed: false },
        commands: [{ type: 'select', requestKey, intent, contextToken: state.contextToken }],
      }
    }
    case 'completed': {
      if (event.contextToken !== state.contextToken || state.inFlight?.requestKey !== event.requestKey) {
        return { state, commands: [] }
      }
      if (event.outcome === 'selected') return { state: { ...state, inFlight: null, last: null, failed: false }, commands: [{ type: 'connected' }] }
      if (event.outcome === 'settled') return { state: { ...state, inFlight: null, last: null, failed: true }, commands: [] }
      return { state: { ...state, inFlight: null, failed: true }, commands: [] }
    }
  }
}
