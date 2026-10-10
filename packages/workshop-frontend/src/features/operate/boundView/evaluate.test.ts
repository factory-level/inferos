import { describe, expect, it } from 'vitest'
import { parseBoundViewSpec, type BoundViewSpec } from '@gadgets/workshop-shared/bound-view'
import type { HostBoardViewColumn, HostBoardViewIssue, HostBoardViewSnapshot } from '@gadgets/workshop-shared/operate-console'
import { BOUND_VIEW_BUDGETS, Budget, evaluateBoundView, mergeSort, type BoundViewBudgetLine, type BoundViewLeaf, type BoundViewTree } from './evaluate'

const spec = (root: unknown, requirements = ['board-1']): BoundViewSpec => {
  const parsed = parseBoundViewSpec(JSON.stringify({ version: 1, title: 'View', requirements, root }))
  if (!parsed.ok) throw new Error(`spec does not parse: ${JSON.stringify(parsed.problems)}`)
  return parsed.spec
}
const issue = (identifier: string, overrides: Partial<HostBoardViewIssue> = {}): HostBoardViewIssue =>
  ({ identifier, title: identifier, priority: 'none', targetDate: null, blocked: false, ...overrides })
const column = (label: string, issues: HostBoardViewIssue[], group: HostBoardViewColumn['group'] = 'unstarted'): HostBoardViewColumn =>
  ({ label, group, issues })
const board = (...columns: HostBoardViewColumn[]): HostBoardViewSnapshot => ({ project: { identifier: 'ENG', name: 'Engineering' }, columns })
const one = (snapshot: HostBoardViewSnapshot) => new Map([['board-1', snapshot]])

const evaluate = (s: BoundViewSpec, snapshots: ReadonlyMap<string, HostBoardViewSnapshot>, budget = new Budget()) =>
  evaluateBoundView(s, snapshots, budget)
const tree = (s: BoundViewSpec, snapshots: ReadonlyMap<string, HostBoardViewSnapshot>): BoundViewTree => {
  const result = evaluate(s, snapshots)
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`)
  return result.tree
}
const listOf = (node: BoundViewTree) => {
  if (node.type !== 'list') throw new Error(`expected a list, got ${node.type}`)
  return node
}
const leafText = (leaf: BoundViewLeaf) => leaf.type === 'badge' ? leaf.label : leaf.type === 'field' ? leaf.value : leaf.text
/** The first leaf of every row of an ungrouped or grouped list, in order. */
const firstLeaves = (node: BoundViewTree) => listOf(node).sections.flatMap(section => section.rows.map(row => leafText(row[0])))
const listOfField = (field: string, extra: object = {}) =>
  ({ type: 'list', of: { requirement: 'board-1', collection: 'issues', ...extra }, item: [{ type: 'field', value: { field } }], empty: 'None' })

describe('pinned semantics', () => {
  it('filters, then stable-sorts, then limits, then groups, with group sizes of the limited rows', () => {
    const snapshot = board(
      column('Todo', [issue('A', { blocked: true, priority: 'urgent' }), issue('B', { priority: 'low' }), issue('C', { priority: 'urgent' })]),
      column('Doing', [issue('D', { priority: 'high' }), issue('E', { priority: 'urgent' })], 'started'),
    )
    const result = listOf(tree(spec({ type: 'list', groupBy: 'column', empty: 'None', item: [{ type: 'field', value: { field: 'identifier' } }],
      of: { requirement: 'board-1', collection: 'issues', where: [{ field: 'blocked', equals: false }], sort: [{ field: 'priority', dir: 'asc' }], limit: 3 } }), one(snapshot)))
    // Unblocked: B C D E. By priority (urgent first), ties in board order: C E D B. Limited to 3: C E D.
    // Groups in first-appearance order among those rows: Todo (C), Doing (E, D).
    expect(result.sections.map(section => [section.header, section.rows.map(row => leafText(row[0]))])).toEqual([
      [{ key: 'Todo', count: 1 }, ['C']],
      [{ key: 'Doing', count: 2 }, ['E', 'D']],
    ])
  })

  it('counts every matching row before any limit', () => {
    const snapshot = board(column('Todo', [issue('A'), issue('B'), issue('C', { blocked: true }), issue('D')]))
    const view = tree(spec({ type: 'stack', children: [
      { type: 'count', label: 'Open', of: { requirement: 'board-1', collection: 'issues', where: [{ field: 'blocked', equals: false }] } },
      listOfField('identifier', { where: [{ field: 'blocked', equals: false }], limit: 1 }),
    ] }), one(snapshot))
    if (view.type !== 'stack') throw new Error('expected a stack')
    expect(view.children[0]).toMatchObject({ type: 'count', value: 3 })
    expect(firstLeaves(view.children[1])).toEqual(['A'])
  })

  it.each(['asc', 'desc'] as const)('sorts nulls last when %s', dir => {
    const snapshot = board(column('Todo', [issue('N1'), issue('Jan', { targetDate: '2026-01-01' }), issue('N2'), issue('Feb', { targetDate: '2026-02-01' })]))
    const order = firstLeaves(tree(spec(listOfField('identifier', { sort: [{ field: 'targetDate', dir }] })), one(snapshot)))
    expect(order).toEqual(dir === 'asc' ? ['Jan', 'Feb', 'N1', 'N2'] : ['Feb', 'Jan', 'N1', 'N2'])
  })

  it('keeps board order (column, then issue) for ties, in both directions and on the second key', () => {
    const snapshot = board(
      column('Todo', [issue('T1', { priority: 'high' }), issue('T2', { priority: 'low' }), issue('T3', { priority: 'high' })]),
      column('Done', [issue('D1', { priority: 'high' }), issue('D2', { priority: 'low' })], 'completed'),
    )
    const sorted = (dir: 'asc' | 'desc') => firstLeaves(tree(spec(listOfField('identifier', { sort: [{ field: 'priority', dir }] })), one(snapshot)))
    expect(sorted('asc')).toEqual(['T1', 'T3', 'D1', 'T2', 'D2'])
    expect(sorted('desc')).toEqual(['T2', 'D2', 'T1', 'T3', 'D1'])
    const twoKeys = firstLeaves(tree(spec(listOfField('identifier', { sort: [{ field: 'priority', dir: 'asc' }, { field: 'blocked', dir: 'asc' }] })), one(snapshot)))
    expect(twoKeys).toEqual(['T1', 'T3', 'D1', 'T2', 'D2'])
  })

  it('orders strings by UTF-16 code unit, with no case folding or normalization', () => {
    const titles = ['a', 'B', 'é', '😀', 'Ａ', 'é']
    const snapshot = board(column('Todo', titles.map((title, index) => issue(`I${index}`, { title }))))
    const order = firstLeaves(tree(spec(listOfField('title', { sort: [{ field: 'title', dir: 'asc' }] })), one(snapshot)))
    // By code unit: 'B' (0x42) < 'a' (0x61) < 'é' (0x65) < 'é' (0xe9) < '\ud83d…' (0xd83d) < 'Ａ' (0xff21);
    // code point order would put the emoji (U+1F600) last.
    expect(order).toEqual(['B', 'a', 'é', 'é', '😀', 'Ａ'])
  })

  it('matches equality exactly, by code unit, and null only to null', () => {
    const snapshot = board(column('Todo', [issue('A', { title: 'Fix' }), issue('B', { title: 'fix' }), issue('C', { title: 'Fix ' }), issue('D', { targetDate: '2026-01-01' })]))
    expect(firstLeaves(tree(spec(listOfField('identifier', { where: [{ field: 'title', equals: 'Fix' }] })), one(snapshot)))).toEqual(['A'])
    expect(firstLeaves(tree(spec(listOfField('identifier', { where: [{ field: 'targetDate', equals: null }] })), one(snapshot)))).toEqual(['A', 'B', 'C'])
  })

  it('derives issues.column and issues.group from the containing column, and columns.count from its issues', () => {
    const snapshot = board(column('Todo', [issue('A'), issue('B')]), column('Shipped', [issue('C')], 'completed'), column('Empty', []))
    const issues = firstLeaves(tree(spec({ type: 'list', of: { requirement: 'board-1', collection: 'issues', where: [{ field: 'group', equals: 'completed' }] },
      item: [{ type: 'field', value: { field: 'column' } }], empty: 'None' }), one(snapshot)))
    expect(issues).toEqual(['Shipped'])
    const columns = tree(spec({ type: 'table', of: { requirement: 'board-1', collection: 'columns', sort: [{ field: 'count', dir: 'desc' }] },
      columns: [{ header: 'Column', field: 'label' }, { header: 'Issues', field: 'count' }, { header: 'Group', field: 'group' }], empty: 'None' }), one(snapshot))
    if (columns.type !== 'table') throw new Error('expected a table')
    expect(columns.rows.map(row => row.map(cell => cell.type === 'badge' ? cell.label : cell.value))).toEqual([
      ['Todo', '2', 'Not started'], ['Shipped', '1', 'Done'], ['Empty', '0', 'Not started'],
    ])
  })

  it('shows project fields per requirement', () => {
    const view = tree(spec({ type: 'field', label: 'Project', value: { requirement: 'board-1', field: 'project.name' } }), one(board()))
    expect(view).toEqual({ type: 'field', label: 'Project', value: 'Engineering' })
  })

  it('looks badge keys up as own properties only, by the value\'s canonical string', () => {
    const snapshot = board(column('Todo', [issue('A', { title: 'toString', priority: 'high', blocked: true }), issue('B', { title: 'constructor' })]))
    const view = tree(spec({ type: 'table', of: { requirement: 'board-1', collection: 'issues' }, empty: 'None', columns: [
      { header: 'Title', field: 'title', as: 'badge', map: { Fix: { label: 'Mapped', tone: 'info' } } },
      { header: 'Priority', field: 'priority', as: 'badge', map: { high: { label: 'Hot', tone: 'danger' } } },
      { header: 'Blocked', field: 'blocked', as: 'badge', map: { true: { label: 'Stuck', tone: 'warning' } } },
      { header: 'Due', field: 'targetDate', as: 'badge', map: { null: { label: 'Someday', tone: 'neutral' } } },
    ] }), one(snapshot))
    if (view.type !== 'table') throw new Error('expected a table')
    expect(view.rows).toEqual([
      [{ type: 'badge', label: 'toString', tone: 'neutral' }, { type: 'badge', label: 'Hot', tone: 'danger' },
        { type: 'badge', label: 'Stuck', tone: 'warning' }, { type: 'badge', label: 'Someday', tone: 'neutral' }],
      [{ type: 'badge', label: 'constructor', tone: 'neutral' }, { type: 'badge', label: 'No priority', tone: 'neutral' },
        { type: 'badge', label: 'No', tone: 'neutral' }, { type: 'badge', label: 'Someday', tone: 'neutral' }],
    ])
  })
})

describe('totality and revalidation', () => {
  const view = spec(listOfField('title'))
  it.each([
    ['an unknown priority', board(column('Todo', [issue('A', { priority: 'bogus' as never })]))],
    ['a title over 500 code units', board(column('Todo', [issue('A', { title: 'x'.repeat(501) })]))],
    ['a malformed date', board(column('Todo', [issue('A', { targetDate: '2026-1-1' })]))],
    ['more than 200 issues in a column', board(column('Todo', Array.from({ length: 201 }, (_, index) => issue(`A-${index}`))))],
    ['more than 500 issues on the board', board(...Array.from({ length: 3 }, (_, c) => column(`C${c}`, Array.from({ length: 200 }, (_, index) => issue(`A-${c}-${index}`)))))],
    ['an inherited field', board(column('Todo', [Object.create(issue('A')) as HostBoardViewIssue]))],
    ['a missing project', { columns: [] } as unknown as HostBoardViewSnapshot],
  ])('refuses a snapshot with %s as invalid, before anything is charged', (_, snapshot) => {
    const budget = new Budget()
    expect(evaluate(view, one(snapshot), budget)).toEqual({ status: 'invalid' })
    expect(Object.values(budget.charged).every(value => value === 0)).toBe(true)
  })

  it('refuses a missing requirement snapshot as invalid', () => {
    expect(evaluate(view, new Map())).toEqual({ status: 'invalid' })
  })

  it('never throws, whatever it is given', () => {
    expect(evaluate(null as unknown as BoundViewSpec, one(board()))).toEqual({ status: 'invalid' })
    expect(evaluate(view, null as unknown as Map<string, HostBoardViewSnapshot>)).toEqual({ status: 'invalid' })
    expect(evaluate({ ...view, root: { type: 'list', of: null } } as unknown as BoundViewSpec, one(board()))).toEqual({ status: 'invalid' })
  })
})

describe('mergeSort', () => {
  // A bottom-up merge of runs a and b makes at most a + b − 1 comparisons, so a whole sort makes at
  // most this many: for n = 500, 3,993 (the top-down bound n⌈log₂ n⌉ − 2^⌈log₂ n⌉ + 1 is 3,989).
  // Both stay under the n⌈log₂ n⌉ = 4,500 per sort key that the evaluator pre-charges.
  const bottomUpBound = (n: number) => {
    let total = 0
    for (let width = 1; width < n; width *= 2) {
      for (let low = 0; low + width < n; low += 2 * width) total += Math.min(low + 2 * width, n) - low - 1
    }
    return total
  }

  it('is stable and stays within its bottom-up bound, under n⌈log₂ n⌉', () => {
    expect(bottomUpBound(500)).toBe(3993)
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (const n of [0, 1, 2, 3, 17, 128, 500]) {
      for (const distinct of [2, 10, 1000]) {
        const items = Array.from({ length: n }, (_, index) => ({ key: Math.floor(random() * distinct), index }))
        let comparisons = 0
        const sorted = mergeSort(items, (a, b) => { comparisons++; return a.key - b.key })
        expect(sorted).toEqual(items.toSorted((a, b) => a.key - b.key || a.index - b.index))
        expect(comparisons).toBeLessThanOrEqual(bottomUpBound(n))
        expect(comparisons).toBeLessThanOrEqual(n <= 1 ? 0 : n * Math.ceil(Math.log2(n)))
      }
    }
  })
})

// The largest legal spec (16 queries, 4 where clauses each, 2 sort keys, Σ limit 500, 2,000 cells,
// 200-unit labels) over four maximum boards (500 issues each, 500-unit titles).
const label = (prefix: string, length = 200) => (prefix + 'x'.repeat(length)).slice(0, length)
const WHERE = [{ field: 'blocked', equals: false }, { field: 'targetDate', equals: null }, { field: 'priority', equals: 'high' }, { field: 'group', equals: 'started' }]
const SORT = [{ field: 'title', dir: 'asc' }, { field: 'identifier', dir: 'desc' }]
const MAX_TEXT = JSON.stringify({ version: 1, title: label('T'), requirements: ['a', 'b', 'c', 'd'], root: { type: 'stack', children: [
  { type: 'table', of: { requirement: 'a', collection: 'issues', where: WHERE, sort: SORT, limit: 200 }, empty: 'e', columns: [
    { header: label('H1', 120), field: 'title' }, { header: 'H2', field: 'identifier' }, { header: 'H3', field: 'column' },
    { header: 'H4', field: 'priority', as: 'badge', map: { high: { label: label('P'), tone: 'danger' } } }, { header: 'H5', field: 'group', as: 'badge' },
    { header: 'H6', field: 'targetDate', as: 'date' }, { header: 'H7', field: 'blocked', as: 'flag' }, { header: 'H8', field: 'title' },
  ] },
  { type: 'list', of: { requirement: 'b', collection: 'issues', where: WHERE, sort: SORT, limit: 200 }, empty: 'e',
    item: [{ type: 'field', label: label('L1'), value: { field: 'title' } }] },
  { type: 'list', groupBy: 'column', of: { requirement: 'c', collection: 'issues', where: WHERE, sort: SORT, limit: 100 }, empty: 'e',
    item: [{ type: 'field', label: label('L2'), value: { field: 'title' } }, { type: 'badge', value: { field: 'priority' } }] },
  { type: 'stack', children: Array.from({ length: 7 }, (_, index) => ({ type: 'count', label: `C${index}`, of: { requirement: 'd', collection: 'issues', where: WHERE } })) },
  { type: 'stack', children: Array.from({ length: 6 }, (_, index) => ({ type: 'count', label: `K${index}`, of: { requirement: 'a', collection: 'issues', where: WHERE } })) },
] } })
const maxBoard = (requirement: string): HostBoardViewSnapshot => ({ project: { identifier: 'P'.repeat(32), name: 'N'.repeat(200) },
  columns: [200, 200, 100].map((size, c) => column(label(`${requirement}${c}`, 100), Array.from({ length: size }, (_, index) =>
    issue(`${requirement.toUpperCase()}-${c}-${index}`.padEnd(32, '0'), { title: 'T'.repeat(500), priority: 'high' })), 'started')) })
const maxSnapshots = () => new Map(['a', 'b', 'c', 'd'].map(name => [name, maxBoard(name)]))
const maxSpec = () => {
  expect(new TextEncoder().encode(MAX_TEXT).length).toBeLessThanOrEqual(8192)
  const parsed = parseBoundViewSpec(MAX_TEXT)
  if (!parsed.ok) throw new Error(`max spec does not parse: ${JSON.stringify(parsed.problems)}`)
  return parsed.spec
}

/** A budget that logs every charge and every unit of work, in order. */
class RecordingBudget extends Budget {
  events: { kind: 'charge' | 'spend'; line: BoundViewBudgetLine; amount: number }[] = []
  override charge(line: BoundViewBudgetLine, amount: number) {
    this.events.push({ kind: 'charge', line, amount })
    super.charge(line, amount)
  }
  override spend(line: BoundViewBudgetLine, amount: number) {
    this.events.push({ kind: 'spend', line, amount })
    super.spend(line, amount)
  }
}

describe('amplification', () => {
  it('runs a maximum legal spec over maximum boards without tripping any budget', () => {
    const budget = new RecordingBudget()
    const result = evaluate(maxSpec(), maxSnapshots(), budget)
    expect(result.status).toBe('ok')
    for (const line of Object.keys(BOUND_VIEW_BUDGETS) as BoundViewBudgetLine[]) {
      expect(budget.spent[line]).toBeLessThanOrEqual(budget.charged[line])
      expect(budget.charged[line]).toBeLessThanOrEqual(BOUND_VIEW_BUDGETS[line])
    }
    // Every query visited every issue of its board: the row budget is exactly enough.
    expect(budget.spent.rowVisits).toBe(8000)
    expect(budget.spent.cells).toBe(2000)
    expect(budget.spent.comparisons).toBeGreaterThan(16 * 2000)
  })

  it('charges each line before the work it pays for', () => {
    const budget = new RecordingBudget()
    evaluate(maxSpec(), maxSnapshots(), budget)
    const charged = new Map<BoundViewBudgetLine, number>()
    const spent = new Map<BoundViewBudgetLine, number>()
    const overspent: unknown[] = []
    for (const event of budget.events) {
      const ledger = event.kind === 'charge' ? charged : spent
      ledger.set(event.line, (ledger.get(event.line) ?? 0) + event.amount)
      if ((spent.get(event.line) ?? 0) > (charged.get(event.line) ?? 0)) overspent.push(event)
    }
    expect(overspent).toEqual([])
    expect([...spent.keys()].toSorted()).toEqual(['cells', 'comparisons', 'elements', 'groups', 'rowVisits', 'text'])
  })

  it('keeps the merge sort\'s key comparisons within each query\'s pre-charge', () => {
    // Equal titles force the second key on every comparison: the worst case for two keys.
    const budget = new RecordingBudget()
    const snapshot = maxBoard('a')
    evaluate(spec(listOfField('title', { sort: SORT, limit: 200 })), one(snapshot), budget)
    const comparisons = budget.events.filter(event => event.line === 'comparisons')
    const charge = comparisons.filter(event => event.kind === 'charge').reduce((sum, event) => sum + event.amount, 0)
    const spent = comparisons.filter(event => event.kind === 'spend').reduce((sum, event) => sum + event.amount, 0)
    expect(charge).toBe(500 * Math.ceil(Math.log2(500)) * 2)
    expect(spent).toBeGreaterThan(0)
    expect(spent).toBeLessThanOrEqual(charge)
  })

  it.each([
    ['rowVisits', 499],
    ['comparisons', 1000],
    ['groups', 0],
    ['elements', 100],
    ['cells', 10],
    ['text', 1000],
  ] as const)('gives the fixed too-large state, with nothing partial, when %s is lowered to %i', (line, limit) => {
    const budget = new Budget({ ...BOUND_VIEW_BUDGETS, [line]: limit })
    const result = evaluate(maxSpec(), maxSnapshots(), budget)
    expect(result).toEqual({ status: 'too-large' })
    expect(budget.spent[line]).toBeLessThanOrEqual(limit)
  })

  it('allocates no row past the row budget', () => {
    const budget = new RecordingBudget({ ...BOUND_VIEW_BUDGETS, rowVisits: 10 })
    expect(evaluate(spec(listOfField('title')), one(maxBoard('a')), budget)).toEqual({ status: 'too-large' })
    expect(budget.spent.rowVisits).toBe(0)
    expect(budget.events.filter(event => event.kind === 'spend' && event.line !== 'elements')).toEqual([])
  })
})
