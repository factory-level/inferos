// Client-side mirrors of the host-board contract (MVP-26 slice 2, "Snapshot DTO and limits" and
// the UI plan amendments). They stand in until the kernel PR lands its shared types in
// `@gadgets/workshop-shared`; when the view is wired, replace these with those exports rather than
// keeping a parallel copy. The snapshot shape follows the merged gatekeeper-kit contract
// (`packages/gatekeeper-kit/src/host-board.ts`), which spells the group `cancelled`.

/** A column's workflow group. */
export type HostBoardGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

/** An issue's priority. */
export type HostBoardPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

/** One card face. It never carries an id, assignee, lease, run, revision or blocked reason. */
export type HostBoardIssue = {
  identifier: string
  title: string
  priority: HostBoardPriority
  /** `yyyy-mm-dd`, or null. */
  targetDate: string | null
  blocked: boolean
}

/** One column, its issues in board order. */
export type HostBoardColumn = { label: string; group: HostBoardGroup; issues: HostBoardIssue[] }

/** The bounded board the kernel projects for the operator. */
export type BoardSnapshot = {
  project: { identifier: string; name: string }
  columns: HostBoardColumn[]
}

/**
 * One answer of the host handle's `readRequirement(name)`. `readAt` is when the kernel started the
 * read (ISO), and `publicationRevision` the console revision it was read under.
 */
export type HostBoardRead =
  | { status: 'ok'; board: BoardSnapshot; readAt: string; publicationRevision: string }
  | { status: 'not-connected' }
  | { status: 'unavailable' }
  | { status: 'stale' }

/** What an Operate console item opens: a gadget widget on a screen, or a host-rendered board. */
export type ConsoleItemTarget =
  | { kind: 'gadget-widget'; screenId: string; widgetId: string }
  | {
      kind: 'host-board'
      entryId: string
      console: { consoleId: string; source: 'published' | 'draft'; revision: string }
    }

/** The host-board variant of {@link ConsoleItemTarget}. */
export type HostBoardTarget = Extract<ConsoleItemTarget, { kind: 'host-board' }>

/**
 * One delivery of the proposed `subscribeHostBoardSelections`: the full current state of the
 * operator's selection for this requirement, never an account id or board data.
 */
export type HostBoardSelectionEvent = {
  state: 'selected' | 'none'
  /** Rises on every delivery, so duplicates and reordered deliveries can be told apart. */
  changeSeq: number
  /** Rises on every write to the persisted selection. */
  selectionEpoch: number
}
