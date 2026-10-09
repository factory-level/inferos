import type { ConsoleRef, HostBoardSelectionUpdate } from '@gadgets/workshop-shared/operate-console'

// The board, read and selection shapes are the kernel's (`@gadgets/workshop-shared/operate-console`);
// only what the UI composes from them lives here.

/** One host board of the console revision the session has open: what a handle is acquired for. */
export type HostBoardTarget = { entryId: string; console: ConsoleRef }

/**
 * A selection delivery that still reflects the caller's context. `unknown` is not one: it ends the
 * subscription, so the view handles it as a failed subscription.
 */
export type HostBoardSelectionEvent = Exclude<HostBoardSelectionUpdate, { state: 'unknown' }>
