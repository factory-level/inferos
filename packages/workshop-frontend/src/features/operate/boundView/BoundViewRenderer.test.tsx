// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseBoundViewSpec } from '@gadgets/workshop-shared/bound-view'
import type { HostBoardViewSnapshot } from '@gadgets/workshop-shared/operate-console'
import { Budget, evaluateBoundView, type BoundViewTree } from './evaluate'
import { mountBoundRoot, type BoundRoot } from './BoundViewRenderer'

// Values shaped like URLs, markup, CSS and script, each made unique so every occurrence can be traced.
const SHAPES = ['javascript:x', 'https://sink/<s>', '<img src=//sink>', 'url(//sink)', 'expression(alert(1))', '" onmouseover="x', '{{x}}']
const BIDI = ['‮', '⁦', '‏', '؜']
let serial = 0
const sentinel = (shape: string) => `S${++serial}~${shape}`
const sentinels: string[] = []
const mark = (shape: string, max = 200) => {
  const value = sentinel(shape).slice(0, max)
  sentinels.push(value)
  return value
}

// A spec with a sentinel in every authored Text and string literal.
const specText = () => {
  const literal = mark(SHAPES[0], 100)
  return { literal, text: JSON.stringify({ version: 1, title: mark(SHAPES[1]), requirements: ['board-1'], root: { type: 'stack', children: [
    { type: 'text', text: mark(SHAPES[2]) },
    { type: 'field', label: mark(SHAPES[3]), value: { requirement: 'board-1', field: 'project.name' } },
    { type: 'count', label: mark(SHAPES[4]), of: { requirement: 'board-1', collection: 'issues' } },
    { type: 'empty', text: mark(SHAPES[5]) },
    { type: 'list', groupBy: 'column', of: { requirement: 'board-1', collection: 'issues' }, empty: mark(SHAPES[6]), item: [
      { type: 'field', label: mark(SHAPES[0]), value: { field: 'title' } },
      { type: 'badge', value: { field: 'priority' }, map: { high: { label: mark(SHAPES[1]), tone: 'danger' } } },
      { type: 'text', text: mark(SHAPES[2]), tone: 'muted' },
    ] },
    { type: 'list', of: { requirement: 'board-1', collection: 'issues', where: [{ field: 'title', equals: literal }] }, empty: mark(SHAPES[3]),
      item: [{ type: 'field', value: { field: 'identifier' } }] },
    { type: 'table', of: { requirement: 'board-1', collection: 'issues' }, empty: mark(SHAPES[4]), columns: [
      { header: mark(SHAPES[5]), field: 'identifier' },
      { header: mark(SHAPES[6]), field: 'title', as: 'badge', map: { [literal]: { label: mark(SHAPES[0]), tone: 'info' } } },
      { header: mark(SHAPES[1]), field: 'column' },
    ] },
  ] } }) }
}
// A snapshot with a sentinel, and bidi controls, in every string.
const snapshot = (literal: string): HostBoardViewSnapshot => ({
  project: { identifier: mark('id', 32), name: mark(SHAPES[2] + BIDI[0]) },
  columns: [
    { label: mark(SHAPES[3] + BIDI[1], 100), group: 'started', issues: [
      { identifier: mark('i', 32), title: mark(SHAPES[4] + BIDI[2]), priority: 'high', targetDate: null, blocked: false },
      { identifier: mark('j', 32), title: literal, priority: 'low', targetDate: '2026-01-01', blocked: true },
    ] },
    { label: mark(SHAPES[5] + BIDI[3], 100), group: 'backlog', issues: [
      { identifier: mark('k', 32), title: mark(SHAPES[6]), priority: 'none', targetDate: null, blocked: false },
    ] },
  ],
})

const evaluated = (): BoundViewTree => {
  const { literal, text } = specText()
  const parsed = parseBoundViewSpec(text)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
  const result = evaluateBoundView(parsed.spec, new Map([['board-1', snapshot(literal)]]), new Budget())
  if (result.status !== 'ok') throw new Error(result.status)
  return result.tree
}

let container: HTMLDivElement
let root: BoundRoot
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  sentinels.length = 0
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = () => {
  const tree = evaluated()
  root = mountBoundRoot(container, () => { throw new Error('the renderer failed') })
  act(() => root.render(tree))
  return tree
}

// React keys of every fiber under the container's root (the dedicated root's own internals).
const reactKeys = (element: Element): string[] => {
  const containerKey = Object.keys(element).find(key => key.startsWith('__reactContainer$'))
  if (!containerKey) throw new Error('not a React root container')
  const keys: string[] = []
  const walk = (fiber: { key: string | null; child: unknown; sibling: unknown } | null) => {
    for (let node = fiber; node; node = node.sibling as typeof fiber) {
      if (node.key !== null) keys.push(node.key)
      walk(node.child as typeof fiber)
    }
  }
  // The container holds the root's first HostRoot fiber; the committed tree hangs off its FiberRoot.
  walk((element as unknown as Record<string, { stateNode: { current: { child: never } } }>)[containerKey].stateNode.current.child)
  return keys
}

describe('BoundViewRenderer', () => {
  it('puts every authored and snapshot value only in <bdi> text, never in an attribute', () => {
    render()
    const rendered = container.textContent ?? ''
    const present = sentinels.filter(value => rendered.includes(value))
    // Every shown spec text and row value is on screen (only the empty texts of non-empty lists are not).
    expect(present.length).toBeGreaterThanOrEqual(20)
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        for (const value of sentinels) expect(attribute.value).not.toContain(value.slice(0, 6))
      }
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const outsideBdi: string[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (sentinels.some(value => node!.textContent!.includes(value)) && node.parentElement?.tagName !== 'BDI') outsideBdi.push(node.textContent!)
    }
    expect(outsideBdi).toEqual([])
  })

  it('creates no link, image, frame, script or style, and no inline style or id from data', () => {
    render()
    expect(container.querySelectorAll('a, img, iframe, frame, object, embed, script, style, link, form, input, svg, video, audio, source')).toHaveLength(0)
    expect(container.querySelectorAll('[style], [id], [href], [src], [srcset], [ping], [action], [poster], [background]')).toHaveLength(0)
    for (const element of container.querySelectorAll('*')) {
      expect([...element.attributes].filter(attribute => attribute.name.startsWith('on'))).toEqual([])
      expect([...element.attributes].filter(attribute => attribute.name.startsWith('aria-'))).toEqual([])
    }
  })

  it('isolates bidirectional text: every value with a bidi control is inside its own <bdi>', () => {
    render()
    const bdis = [...container.querySelectorAll('bdi')]
    for (const control of BIDI) {
      const holders = bdis.filter(bdi => bdi.textContent!.includes(control))
      expect(holders.length).toBeGreaterThan(0)
      // The control stays inside the isolate: the <bdi> holds the whole value and nothing else.
      for (const holder of holders) expect(holder.childNodes).toHaveLength(1)
    }
  })

  it('uses positional React keys, never a value', () => {
    render()
    const keys = reactKeys(container.firstElementChild!)
    expect(keys.length).toBeGreaterThan(5)
    for (const key of keys) expect(key).toMatch(/^[0-9]+$/)
  })

  it('refuses bidi controls in authored text, so only snapshot values can carry them', () => {
    for (const control of BIDI) {
      const parsed = parseBoundViewSpec(JSON.stringify({ version: 1, title: `x${control}`, requirements: ['board-1'], root: { type: 'empty', text: 'none' } }))
      expect(parsed).toMatchObject({ ok: false, problems: [{ code: 'bidi' }] })
    }
  })
})
