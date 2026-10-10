import type {
  BoundViewBadgeMap,
  BoundViewCountQuery,
  BoundViewField,
  BoundViewNode,
  BoundViewQuery,
  BoundViewSpec,
  BoundViewTone,
} from '@gadgets/workshop-shared/bound-view'
import { HOST_BOARD_SNAPSHOT_LIMITS, type HostBoardViewGroup, type HostBoardViewPriority, type HostBoardViewSnapshot } from '@gadgets/workshop-shared/operate-console'

// The bound-view evaluator: pure and total. It interprets a parsed v1 spec over one snapshot per
// requirement and returns a render tree of plain strings, or a fixed `too-large` or `invalid`
// state. It runs no authored code and builds no URL, markup or style from any value: the tree
// holds text only, which the trusted renderer puts in text nodes. Nothing here logs or reports.

/**
 * The dynamic budgets of one snapshot set: each is the most a legal spec can need on a maximum
 * snapshot (the bound-view contract, §2.3), so only a defect trips one.
 * - `rowVisits`: 16 queries × 500 rows.
 * - `comparisons`: per query, n × 4 `where` + n⌈log₂ n⌉ × 2 sort keys at n = 500, × 16 queries.
 * - `groups`: at most one per limited row, Σ 500.
 * - `elements`: the DOM elements `BoundViewRenderer` renders, exactly (see {@link ELEMENTS}): its
 *   wrapper (1); 16 queries × 24 (a table's wrapper, table, head, header row, 8 × (th + bdi),
 *   body, and the empty row's tr, td and bdi); 48 other nodes × 4 (a labelled field: p, span and
 *   two bdi); 500 rows × 1 (li or tr); 2,000 cells × 4 (a labelled list field: span, span and two
 *   bdi); and 500 list sections × 4 (section, h3, bdi, ul) = 1 + 384 + 192 + 500 + 8,000 + 2,000.
 * - `cells`: the static Σ limit × (columns or item leaves).
 * - `text`: every emitted code unit: 2,000 cells × 701 (label, separator, value) + 500 group
 *   headers × 112 + 8,192 of authored static text + 64 nodes × 201 (a field's project value and
 *   separator, or a count's separator) + 16 counts × 3 digits.
 */
export const BOUND_VIEW_BUDGETS = {
  rowVisits: 8_000,
  comparisons: 176_000,
  groups: 500,
  elements: 11_077,
  cells: 2_000,
  text: 1_479_104,
} as const satisfies Record<string, number>

/** One line of {@link BOUND_VIEW_BUDGETS}. */
export type BoundViewBudgetLine = keyof typeof BOUND_VIEW_BUDGETS

/** A group key is a column label at most: never longer than this many code units. */
export const BOUND_VIEW_GROUP_KEY_MAX = HOST_BOARD_SNAPSHOT_LIMITS.columnLabel

class BudgetExceeded extends Error {}

const zeroes = (): Record<BoundViewBudgetLine, number> => ({ rowVisits: 0, comparisons: 0, groups: 0, elements: 0, cells: 0, text: 0 })

/**
 * The budget of one snapshot set. Work is paid for in advance: `charge` reserves an amount before
 * the work it covers, and fails once a line would pass its limit; `spend` records the work as it
 * is done, and fails if it would pass what was charged. Either failure makes the evaluation
 * `too-large`, with nothing partial.
 */
export class Budget {
  readonly limits: Readonly<Record<BoundViewBudgetLine, number>>
  readonly charged = zeroes()
  readonly spent = zeroes()

  constructor(limits: Readonly<Record<BoundViewBudgetLine, number>> = BOUND_VIEW_BUDGETS) {
    this.limits = { ...limits }
  }

  /** Reserves `amount` of `line` before the work it pays for. */
  charge(line: BoundViewBudgetLine, amount: number): void {
    if (!(amount >= 0) || this.charged[line] + amount > this.limits[line]) throw new BudgetExceeded()
    this.charged[line] += amount
  }

  /** Records `amount` of `line` as done; never more than was charged. */
  spend(line: BoundViewBudgetLine, amount: number): void {
    if (this.spent[line] + amount > this.charged[line]) throw new BudgetExceeded()
    this.spent[line] += amount
  }
}

/** One leaf of a list row. */
export type BoundViewLeaf =
  | { type: 'field'; label: string | null; value: string }
  | { type: 'badge'; label: string; tone: BoundViewTone }
  | { type: 'text'; text: string; tone: 'default' | 'muted' }

/** One table cell. */
export type BoundViewCell = { type: 'text'; value: string } | { type: 'badge'; label: string; tone: BoundViewTone }

/** A list's rows, under a group header (its key and how many limited rows it holds) or none. */
export type BoundViewSection = { header: { key: string; count: number } | null; rows: BoundViewLeaf[][] }

/** The evaluated view: plain strings and numbers only, for the trusted renderer. */
export type BoundViewTree =
  | { type: 'stack'; gap: 'sm' | 'md'; children: BoundViewTree[] }
  | { type: 'columns'; children: BoundViewTree[] }
  | { type: 'text'; text: string; tone: 'default' | 'muted'; size: 'sm' | 'md' | 'lg' }
  | { type: 'field'; label: string | null; value: string }
  | { type: 'count'; label: string; value: number }
  /** `empty` is the authored text shown when no row matched, and null when rows did. */
  | { type: 'list'; sections: BoundViewSection[]; empty: string | null }
  | { type: 'table'; headers: string[]; rows: BoundViewCell[][]; empty: string | null }
  | { type: 'empty'; text: string }

/** What an evaluation came to. Only `ok` carries anything derived from the snapshots. */
export type BoundViewEvaluation = { status: 'ok'; tree: BoundViewTree } | { status: 'too-large' } | { status: 'invalid' }

const GROUPS: readonly HostBoardViewGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled']
const PRIORITIES: readonly HostBoardViewPriority[] = ['urgent', 'high', 'medium', 'low', 'none']
const GROUP_LABEL: Record<HostBoardViewGroup, string> = { backlog: 'Backlog', unstarted: 'Not started', started: 'In progress', completed: 'Done', cancelled: 'Cancelled' }
const PRIORITY_LABEL: Record<HostBoardViewPriority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' }
const DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/
const LIMIT_DEFAULT = 50

// --- Snapshot revalidation: own data properties only, read through descriptors so no getter runs.

type Issue = { identifier: string; title: string; priority: HostBoardViewPriority; targetDate: string | null; blocked: boolean }
type Column = { label: string; group: HostBoardViewGroup; issues: Issue[] }
type Board = { project: { identifier: string; name: string }; columns: Column[]; issueCount: number }

class Invalid extends Error {}

const field = (source: unknown, key: string): unknown => {
  if (typeof source !== 'object' || source === null) throw new Invalid()
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (!descriptor || !('value' in descriptor)) throw new Invalid()
  return descriptor.value
}
const text = (source: unknown, key: string, max: number): string => {
  const value = field(source, key)
  if (typeof value !== 'string' || value.length > max) throw new Invalid()
  return value
}
const member = <T extends string>(source: unknown, key: string, members: readonly T[]): T => {
  const value = field(source, key)
  if (!members.includes(value as T)) throw new Invalid()
  return value as T
}
const list = (source: unknown, key: string, max: number): unknown[] => {
  const value = field(source, key)
  if (!Array.isArray(value) || value.length > max) throw new Invalid()
  return Array.from({ length: value.length }, (_, index) => field(value, String(index)))
}

const L = HOST_BOARD_SNAPSHOT_LIMITS
const revalidate = (snapshot: unknown): Board => {
  const project = field(snapshot, 'project')
  const columns = list(snapshot, 'columns', L.columns)
  let issueCount = 0
  const board: Board = {
    project: { identifier: text(project, 'identifier', L.projectIdentifier), name: text(project, 'name', L.projectName) },
    columns: columns.map(column => {
      const issues = list(column, 'issues', L.issuesPerColumn)
      issueCount += issues.length
      if (issueCount > L.issues) throw new Invalid()
      return {
        label: text(column, 'label', L.columnLabel),
        group: member(column, 'group', GROUPS),
        issues: issues.map(issue => {
          const targetDate = field(issue, 'targetDate')
          if (targetDate !== null && (typeof targetDate !== 'string' || !DATE.test(targetDate))) throw new Invalid()
          const blocked = field(issue, 'blocked')
          if (typeof blocked !== 'boolean') throw new Invalid()
          return { identifier: text(issue, 'identifier', L.issueIdentifier), title: text(issue, 'title', L.issueTitle),
            priority: member(issue, 'priority', PRIORITIES), targetDate, blocked }
        }),
      }
    }),
    issueCount,
  }
  return board
}

// --- Values: the closed field tables, read through a switch, never by an authored property name.

type Row = { column: Column; issue: Issue | null }
type Value = string | number | boolean | null

const valueOf = (row: Row, name: BoundViewField): Value => {
  const { column, issue } = row
  if (issue) {
    switch (name) {
      case 'identifier': return issue.identifier
      case 'title': return issue.title
      case 'priority': return issue.priority
      case 'targetDate': return issue.targetDate
      case 'blocked': return issue.blocked
      case 'column': return column.label
      case 'group': return column.group
    }
  } else {
    switch (name) {
      case 'label': return column.label
      case 'group': return column.group
      case 'count': return column.issues.length
    }
  }
  throw new Invalid()
}

/** The text a value is shown as: enums through constant tables, never a raw member name. */
const display = (name: BoundViewField, value: Value): string => {
  if (name === 'priority') return PRIORITY_LABEL[value as HostBoardViewPriority]
  if (name === 'group') return GROUP_LABEL[value as HostBoardViewGroup]
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (value === null) return 'No date'
  return String(value)
}
const groupLabel = (name: BoundViewField, value: Value) =>
  name === 'blocked' ? (value ? 'Blocked' : 'Not blocked') : display(name, value)

/** The canonical string a badge map is keyed by (see `BoundViewBadgeMap`). */
const canonical = (value: Value) => value === null ? 'null' : String(value)

const badge = (name: BoundViewField, value: Value, map: BoundViewBadgeMap | undefined): { label: string; tone: BoundViewTone } => {
  const key = canonical(value)
  if (map && Object.hasOwn(map, key)) {
    const entry = map[key]
    return { label: entry.label, tone: entry.tone }
  }
  return { label: display(name, value), tone: 'neutral' }
}

const order = (name: BoundViewField, a: Exclude<Value, null>, b: Exclude<Value, null>): number => {
  if (name === 'priority') return PRIORITIES.indexOf(a as HostBoardViewPriority) - PRIORITIES.indexOf(b as HostBoardViewPriority)
  if (name === 'group') return GROUPS.indexOf(a as HostBoardViewGroup) - GROUPS.indexOf(b as HostBoardViewGroup)
  if (typeof a === 'boolean' || typeof a === 'number') return Number(a) - Number(b)
  // Strings and dates: by UTF-16 code unit, which is what `<` compares.
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * A stable bottom-up merge sort. It never calls `Array.prototype.sort`, so the number of
 * comparisons is bounded and known in advance: merging runs of a and b elements takes at most
 * a + b − 1, so each of the ⌈log₂ n⌉ passes takes fewer than n, and the whole sort at most
 * n⌈log₂ n⌉ (3,993 at n = 500, a little over the top-down n⌈log₂ n⌉ − 2^⌈log₂ n⌉ + 1 = 3,989).
 */
export const mergeSort = <T>(items: readonly T[], compare: (a: T, b: T) => number): T[] => {
  const n = items.length
  let source = items.slice()
  let target = Array.from<T>({ length: n })
  for (let width = 1; width < n; width *= 2) {
    for (let low = 0; low < n; low += 2 * width) {
      const middle = Math.min(low + width, n)
      const high = Math.min(low + 2 * width, n)
      let i = low, j = middle, k = low
      // The right element moves first only when strictly smaller, so equal elements keep their order.
      while (i < middle && j < high) target[k++] = compare(source[j], source[i]) < 0 ? source[j++] : source[i++]
      while (i < middle) target[k++] = source[i++]
      while (j < high) target[k++] = source[j++]
    }
    ;[source, target] = [target, source]
  }
  return source
}

// --- Evaluation.

const digits = (value: number) => String(value).length
/** Host copy around a group header's key and count (" · " and room to spare). */
const HEADER_COPY = 9
const HEADER_COUNT_DIGITS = 3
/** The space `BoundViewRenderer` puts between a label and its value. */
const SEPARATOR = 1

/**
 * The DOM elements `BoundViewRenderer` renders for each part of a tree, which the `elements`
 * budget charges exactly. Kept beside the renderer's markup by a test that compares the charge with
 * the rendered element count.
 */
const ELEMENTS = {
  /** The renderer's wrapper `div`. */
  wrapper: 1,
  /** A stack's or columns' `div`. */
  container: 1,
  /** `p` and `bdi`: a text, an empty, a field without a label, or an empty list's text. */
  paragraph: 2,
  /** A label's `span` and `bdi`. */
  label: 2,
  /** A count's `p`, label `span` and `bdi`, and value `bdi`. */
  count: 4,
  /** A non-empty list's `div`. */
  list: 1,
  /** A list section's `section` and `ul`; a group header adds its `h3` and `bdi`. */
  section: 2,
  header: 2,
  /** A table's wrapper `div`, `table`, `thead`, header `tr` and `tbody`; each header's `th` and `bdi`. */
  table: 5,
  tableHeader: 2,
  /** An empty table's `tr`, `td` and `bdi`. */
  tableEmpty: 3,
  /** A list row's `li`, or a table row's `tr`. */
  row: 1,
  /** A leaf's `span` (a badge's, a text's, or a field's) and its value `bdi`. */
  leaf: 2,
  /** A table cell's `td`; its text `bdi`, or its badge `span` and `bdi`. */
  cell: 1,
  cellText: 1,
  cellBadge: 2,
} as const

class Evaluator {
  constructor(private readonly boards: ReadonlyMap<string, Board>, private readonly budget: Budget) {}

  #pay(line: BoundViewBudgetLine, amount: number) {
    this.budget.charge(line, amount)
    this.budget.spend(line, amount)
  }

  #board(requirement: string): Board {
    const board = this.boards.get(requirement)
    if (!board) throw new Invalid()
    return board
  }

  /** Filter: every row of the collection is visited once, each charged before it is touched. */
  #match(query: BoundViewCountQuery): Row[] {
    const board = this.#board(query.requirement)
    const where = query.where ?? []
    const total = query.collection === 'issues' ? board.issueCount : board.columns.length
    this.budget.charge('rowVisits', total)
    this.budget.charge('comparisons', total * where.length)
    const matched: Row[] = []
    const visit = (row: Row) => {
      this.budget.spend('rowVisits', 1)
      for (const clause of where) {
        this.budget.spend('comparisons', 1)
        if (valueOf(row, clause.field) !== clause.equals) return
      }
      matched.push(row)
    }
    for (const column of board.columns) {
      if (query.collection === 'columns') visit({ column, issue: null })
      else for (const issue of column.issues) visit({ column, issue })
    }
    return matched
  }

  /** Filter, then stable sort, then limit. */
  #rows(query: BoundViewQuery): Row[] {
    const matched = this.#match(query)
    const keys = query.sort ?? []
    const n = matched.length
    let sorted = matched
    if (keys.length > 0 && n > 1) {
      const allowance = n * Math.ceil(Math.log2(n)) * keys.length
      this.budget.charge('comparisons', allowance)
      let used = 0
      sorted = mergeSort(matched, (a, b) => {
        for (const key of keys) {
          if (++used > allowance) throw new BudgetExceeded()
          this.budget.spend('comparisons', 1)
          const left = valueOf(a, key.field)
          const right = valueOf(b, key.field)
          // Nulls last in both directions.
          if (left === null || right === null) {
            if (left === right) continue
            return left === null ? 1 : -1
          }
          const compared = order(key.field, left, right)
          if (compared !== 0) return key.dir === 'desc' ? -compared : compared
        }
        return 0
      })
    }
    return sorted.slice(0, query.limit ?? LIMIT_DEFAULT)
  }

  /** The whole view: the renderer's wrapper, then the root node. */
  root(node: BoundViewNode): BoundViewTree {
    this.#pay('elements', ELEMENTS.wrapper)
    return this.node(node)
  }

  node(node: BoundViewNode): BoundViewTree {
    switch (node.type) {
      case 'stack':
        this.#pay('elements', ELEMENTS.container)
        return { type: 'stack', gap: node.gap ?? 'md', children: node.children.map(child => this.node(child)) }
      case 'columns':
        this.#pay('elements', ELEMENTS.container)
        return { type: 'columns', children: node.children.map(child => this.node(child)) }
      case 'text':
        this.#pay('elements', ELEMENTS.paragraph)
        this.#pay('text', node.text.length)
        return { type: 'text', text: node.text, tone: node.tone ?? 'default', size: node.size ?? 'md' }
      case 'empty':
        this.#pay('elements', ELEMENTS.paragraph)
        this.#pay('text', node.text.length)
        return { type: 'empty', text: node.text }
      case 'field': {
        const project = this.#board(node.value.requirement).project
        const value = node.value.field === 'project.identifier' ? project.identifier : project.name
        this.#pay('elements', ELEMENTS.paragraph + (node.label === undefined ? 0 : ELEMENTS.label))
        this.#pay('text', (node.label === undefined ? 0 : node.label.length + SEPARATOR) + value.length)
        return { type: 'field', label: node.label ?? null, value }
      }
      case 'count': {
        const value = this.#match(node.of).length
        this.#pay('elements', ELEMENTS.count)
        this.#pay('text', node.label.length + SEPARATOR + digits(value))
        return { type: 'count', label: node.label, value }
      }
      case 'list': return this.#list(node)
      case 'table': return this.#table(node)
    }
    throw new Invalid()
  }

  #list(node: Extract<BoundViewNode, { type: 'list' }>): BoundViewTree {
    const rows = this.#rows(node.of)
    if (rows.length === 0) {
      this.#pay('elements', ELEMENTS.paragraph)
      this.#pay('text', node.empty.length)
      return { type: 'list', sections: [], empty: node.empty }
    }
    this.#pay('elements', ELEMENTS.list)
    const sections: { header: { key: string; count: number } | null; rows: BoundViewLeaf[][] }[] = []
    const byKey = new Map<string, number>()
    for (const row of rows) {
      let section = sections[0]
      if (node.groupBy) {
        const key = groupLabel(node.groupBy, valueOf(row, node.groupBy))
        let index = byKey.get(key)
        if (index === undefined) {
          if (key.length > BOUND_VIEW_GROUP_KEY_MAX) throw new BudgetExceeded()
          this.#pay('groups', 1)
          this.#pay('elements', ELEMENTS.section + ELEMENTS.header)
          this.#pay('text', key.length + HEADER_COUNT_DIGITS + HEADER_COPY)
          index = sections.push({ header: { key, count: 0 }, rows: [] }) - 1
          byKey.set(key, index)
        }
        section = sections[index]
        section.header!.count++
      } else if (!section) {
        this.#pay('elements', ELEMENTS.section)
        section = { header: null, rows: [] }
        sections.push(section)
      }
      section.rows.push(this.#item(node.item, row))
    }
    return { type: 'list', sections, empty: null }
  }

  #item(item: Extract<BoundViewNode, { type: 'list' }>['item'], row: Row): BoundViewLeaf[] {
    // The row's text is known from the snapshot's string lengths and the authored leaves: it is
    // charged, with the row's cells and elements, before any of the row's leaves is built.
    const parts = item.map(leaf => {
      if (leaf.type === 'text') return { leaf, shown: leaf.text, length: leaf.text.length, elements: ELEMENTS.leaf }
      const value = valueOf(row, leaf.value.field)
      if (leaf.type === 'badge') {
        const shown = badge(leaf.value.field, value, leaf.map)
        return { leaf, shown, length: shown.label.length, elements: ELEMENTS.leaf }
      }
      const shown = display(leaf.value.field, value)
      return leaf.label === undefined
        ? { leaf, shown, length: shown.length, elements: ELEMENTS.leaf }
        : { leaf, shown, length: leaf.label.length + SEPARATOR + shown.length, elements: ELEMENTS.leaf + ELEMENTS.label }
    })
    this.#payRow(parts)
    return parts.map(({ leaf, shown }): BoundViewLeaf => {
      if (leaf.type === 'text') return { type: 'text', text: leaf.text, tone: leaf.tone ?? 'default' }
      if (leaf.type === 'badge') return { type: 'badge', ...(shown as { label: string; tone: BoundViewTone }) }
      return { type: 'field', label: leaf.label ?? null, value: shown as string }
    })
  }

  #table(node: Extract<BoundViewNode, { type: 'table' }>): BoundViewTree {
    this.#pay('elements', ELEMENTS.table + ELEMENTS.tableHeader * node.columns.length)
    this.#pay('text', node.columns.reduce((sum, column) => sum + column.header.length, 0))
    const headers = node.columns.map(column => column.header)
    const rows = this.#rows(node.of)
    if (rows.length === 0) {
      this.#pay('elements', ELEMENTS.tableEmpty)
      this.#pay('text', node.empty.length)
      return { type: 'table', headers, rows: [], empty: node.empty }
    }
    return {
      type: 'table', headers, empty: null,
      rows: rows.map(row => {
        // As for list rows: the text is measured, and the row paid for, before its cells are built.
        // `as: 'date'` and `'flag'` show as text: the contract gives them no other rendering.
        const parts = node.columns.map(column => {
          const value = valueOf(row, column.field)
          if (column.as === 'badge') {
            const shown = badge(column.field, value, column.map)
            return { badge: shown, length: shown.label.length, elements: ELEMENTS.cell + ELEMENTS.cellBadge }
          }
          const shown = display(column.field, value)
          return { text: shown, length: shown.length, elements: ELEMENTS.cell + ELEMENTS.cellText }
        })
        this.#payRow(parts)
        return parts.map((part): BoundViewCell => part.badge ? { type: 'badge', ...part.badge } : { type: 'text', value: part.text! })
      }),
    }
  }

  /** One row, before its nodes are built: its cells, its element and each cell's, and its text. */
  #payRow(parts: readonly { length: number; elements: number }[]) {
    this.#pay('cells', parts.length)
    this.#pay('elements', ELEMENTS.row + parts.reduce((sum, part) => sum + part.elements, 0))
    this.#pay('text', parts.reduce((sum, part) => sum + part.length, 0))
  }
}

/**
 * Evaluates `spec` over `snapshots` (one per requirement name) within `budget`. Total: it never
 * throws. Each snapshot is revalidated against the field tables before anything is charged; one
 * that fails, a missing requirement or a malformed spec gives `invalid`. A tripped budget gives
 * `too-large`. In either case nothing partial is returned.
 *
 * Semantics (pinned): filter, then stable sort, then limit (1..200, default 50), then group; a
 * `count` counts every matching row before any limit; nulls sort last in both directions; strings
 * compare by UTF-16 code unit; ties keep snapshot order (column order, then issue order).
 */
export const evaluateBoundView = (spec: BoundViewSpec, snapshots: ReadonlyMap<string, HostBoardViewSnapshot>, budget: Budget): BoundViewEvaluation => {
  try {
    const boards = new Map<string, Board>()
    for (const requirement of spec.requirements) {
      if (!snapshots.has(requirement)) return { status: 'invalid' }
      boards.set(requirement, revalidate(snapshots.get(requirement)))
    }
    return { status: 'ok', tree: new Evaluator(boards, budget).root(spec.root) }
  } catch (caught) {
    return caught instanceof BudgetExceeded ? { status: 'too-large' } : { status: 'invalid' }
  }
}
