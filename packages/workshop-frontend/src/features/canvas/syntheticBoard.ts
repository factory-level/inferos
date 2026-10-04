// Synthetic boards for the Kanban performance baseline (#28). Test and benchmark use only.
//
// `syntheticBoardResponse` builds an InferOps board response (`BoardResponseSchema`, the shape of
// `scripts/consumer/project-board.schema.json`): what InferOps sends the gatekeeper. `toBoard`
// keeps what the gatekeeper's board parser keeps (the bound project and the `Issue` card fields;
// the workspace project list, leases and runs are dropped): what the gatekeeper sends the browser.
// Deterministic, so payload sizes are reproducible.
import type { Board, Issue, State } from '@inferos/gatekeeper-inferops/src/types'

type Lease = { state: 'free' | 'held' | 'quarantined'; principalId: string | null; generation: string; expiresAt: string | null }
type Run = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' }

/** One card of an InferOps board response. */
export type BoardResponseIssue = Issue & { lease: Lease | null; run: Run | null }

/** An InferOps board response, as `BoardResponseSchema` describes it. */
export type BoardResponse = {
  projectId: string | null
  projects: { id: string; identifier: string; name: string }[]
  columns: { state: State; issues: BoardResponseIssue[] }[]
}

const uuid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const COLUMNS: Pick<State, 'name' | 'group'>[] = [
  { name: 'Backlog', group: 'backlog' },
  { name: 'Ready', group: 'unstarted' },
  { name: 'Working', group: 'started' },
  { name: 'Review', group: 'started' },
  { name: 'Done', group: 'completed' },
  { name: 'Cancelled', group: 'cancelled' },
]
const PRIORITIES: Issue['priority'][] = ['urgent', 'high', 'medium', 'low', 'none']
const WORDS = ['Verify', 'the', 'shift', 'handover', 'checklist', 'for', 'line', 'three', 'and', 'record', 'sensor', 'drift']

/**
 * A board of `issues` cards spread round-robin over `columns` states (at most six), with a realistic
 * mix of titles, assignees, target dates, blockers, leases and runs, plus `otherProjects` extra
 * workspace projects in the response's project list.
 */
export const syntheticBoardResponse = ({ issues, columns = 6, otherProjects = 4 }:
  { issues: number; columns?: number; otherProjects?: number }): BoardResponse => {
  const projectId = uuid(0x10000000, 1)
  const states: State[] = COLUMNS.slice(0, columns).map((column, i) =>
    ({ id: uuid(0x20000000, i + 1), ...column, position: i, workflow: 'software' }))
  const cards = Array.from({ length: issues }, (_, i): BoardResponseIssue => {
    const n = i + 1
    const state = states[i % states.length]!
    const held = n % 7 === 0
    return {
      id: uuid(0x30000000, n),
      identifier: `DEMO-${n}`,
      title: Array.from({ length: 4 + (n % 8) }, (_word, w) => WORDS[(n + w) % WORDS.length]).join(' '),
      priority: PRIORITIES[n % PRIORITIES.length]!,
      stateId: state.id,
      targetDate: n % 3 === 0 ? `2026-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')}` : null,
      workflow: 'software',
      revision: String(1 + (n % 40)),
      assigneeId: n % 2 === 0 ? uuid(0x40000000, n % 25) : null,
      blockedReason: n % 11 === 0 ? 'Waiting for the vendor to confirm the replacement part.' : null,
      lease: held ? { state: 'held', principalId: uuid(0x40000000, n % 25), generation: String(n), expiresAt: '2026-10-03T12:00:00Z' } : null,
      run: n % 13 === 0 ? { id: uuid(0x50000000, n), status: 'running' } : null,
    }
  })
  return {
    projectId,
    projects: [{ id: projectId, identifier: 'DEMO', name: 'Synthetic operations' },
      ...Array.from({ length: otherProjects }, (_, i) => ({ id: uuid(0x10000000, i + 2), identifier: `P${i + 2}`, name: `Project ${i + 2}` }))],
    columns: states.map(state => ({ state, issues: cards.filter(card => card.stateId === state.id) })),
  }
}

/** The gatekeeper's `Board` for a response: the bound project and the card fields only. */
export const toBoard = (response: BoardResponse): Board => {
  const project = response.projects.find(p => p.id === response.projectId)
  if (!project) throw new Error('the response does not list its own project')
  return {
    project,
    columns: response.columns.map(({ state, issues }) => ({
      state,
      issues: issues.map(({ lease: _lease, run: _run, ...issue }) => issue),
    })),
  }
}
