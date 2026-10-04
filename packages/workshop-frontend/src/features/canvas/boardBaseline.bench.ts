// Kanban adapter baseline (#28): browser-side cost of one board read, small and large boards, in
// Node. Synthetic and local: no network, no RPC, no rendering. Run with
//   pnpm --filter @gadgets/workshop-frontend exec vitest bench --run src/features/canvas/boardBaseline.bench.ts
// and record the numbers with the machine in docs/architecture/inferops-canvas.md (Performance).
import { bench, describe } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import demoResponse from '../../../../../scripts/consumer/project-board.json'
import { BoardData, visibleColumns, type BoardRequest } from './boardData'
import { BoardMetrics } from './boardMetrics'
import { sortIssues } from './kanbanBoard'
import { syntheticBoardResponse, toBoard, type BoardResponse } from './syntheticBoard'

const REF = 'inferops://demo.local/project/board/DEMO'
const request: BoardRequest = { kind: 'inferops.project-board', version: 1, targetRef: REF, params: { workflow: 'software', showCompleted: true } }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

const cases = {
  'DEMO fixture (1 issue, 3 columns)': demoResponse as BoardResponse,
  'synthetic 500 issues, 6 columns': syntheticBoardResponse({ issues: 500 }),
  'synthetic 2000 issues, 6 columns': syntheticBoardResponse({ issues: 2000 }),
}

// A workspace whose one connection answers every read at once with a fresh copy of the board.
const instantOverseer = (json: string) => ({
  getGatekeeperByResourceUrl: async () => ({
    openSession: async () => ({ readBoard: async () => JSON.parse(json), [Symbol.dispose]: () => {} }),
    [Symbol.dispose]: () => {},
  }),
}) as unknown as RpcStub<Overseer>

// Subscribe a card to a new scope and wait for its board: lookup, session, read and landing.
const firstRead = (overseer: RpcStub<Overseer>, metrics?: BoardMetrics) => new Promise<void>(resolve => {
  const data = new BoardData(overseer, { metrics })
  const unsubscribe = data.subscribe(request, () => {
    if (data.get(request).status !== 'ready') return
    unsubscribe()
    data.dispose()
    resolve()
  })
})

for (const [name, response] of Object.entries(cases)) {
  const board = toBoard(response)
  const json = JSON.stringify(board)
  const issues = board.columns.reduce((n, column) => n + column.issues.length, 0)
  console.log(`${name}: ${issues} issues, InferOps response ${bytes(response)} B, gatekeeper board ${bytes(board)} B`)
  const overseer = instantOverseer(json)

  describe(name, () => {
    bench('decode the board (JSON.parse, the wire decode proxy)', () => { JSON.parse(json) })
    bench('first read through the adapter (lookup, session, read, land)', () => firstRead(overseer))
    bench('first read with dev metrics on', () => firstRead(overseer, new BoardMetrics()))
    bench('render prep (visibleColumns + sortIssues per column)', () => {
      for (const column of visibleColumns(board, request.params)) sortIssues(column.issues)
    })
  })
}
