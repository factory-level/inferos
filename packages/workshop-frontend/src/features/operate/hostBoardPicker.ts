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
  last: { fingerprint: string; requestKey: string } | null
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
  | { type: 'completed'; contextToken: number; requestKey: string; ok: boolean }

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
        state: { ...state, inFlight: { requestKey }, last: { fingerprint, requestKey }, failed: false },
        commands: [{ type: 'select', requestKey, intent, contextToken: state.contextToken }],
      }
    }
    case 'completed': {
      if (event.contextToken !== state.contextToken || state.inFlight?.requestKey !== event.requestKey) {
        return { state, commands: [] }
      }
      if (event.ok) return { state: { ...state, inFlight: null, last: null, failed: false }, commands: [{ type: 'connected' }] }
      return { state: { ...state, inFlight: null, failed: true }, commands: [] }
    }
  }
}
