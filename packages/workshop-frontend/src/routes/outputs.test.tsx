// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutputSummary } from '@gadgets/workshop-shared/api'

type Search = { type?: string; owner?: 'mine' | 'shared' }

const testState = vi.hoisted(() => ({
  search: {} as Search,
  navigate: vi.fn<(options: { to: string; search: (prev: Search) => Search; replace?: boolean }) => void>(),
  outputs: [] as unknown[],
}))

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => testState.navigate,
}))
vi.mock('@cloudflare/kumo', async (original) => ({
  ...(await original<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: () => {} }),
}))
// One stub for every render: the page's load effect depends on its identity.
const api = vi.hoisted(() => ({ authenticatedApi: { listOutputs: async () => ({ outputs: [] as unknown[], catchingUp: false }) } }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => api }))
vi.mock('../components/format/useOutputFormats', () => ({
  useOutputFormats: () => ({
    formats: [{ blueprintId: 'b-doc', output: { id: 'doc', noun: 'Doc', plural: 'Docs', icon: 'fileText' } }],
    creating: null,
    create: async () => {},
  }),
}))
vi.mock('../components/format/NewFormatRow', () => ({ default: () => null }))

import { OutputsPageContent, outputsSearchFrom } from './outputs'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const output = (workpieceId: number, title: string, format?: 'doc'): OutputSummary => ({
  workspaceId: `w${workpieceId}`,
  workpieceId,
  title,
  workspaceTitle: 'Workspace',
  created: new Date('2026-11-01T00:00:00Z'),
  lastActive: new Date('2026-11-01T00:00:00Z'),
  ...(format ? { output: { id: 'doc', noun: 'Doc', plural: 'Docs', icon: 'fileText' } } : {}),
}) as OutputSummary

describe('outputsSearchFrom', () => {
  it('keeps a format id and a known scope, and drops anything else', () => {
    expect(outputsSearchFrom({ type: 'doc', owner: 'shared' })).toEqual({ type: 'doc', owner: 'shared' })
    expect(outputsSearchFrom({ type: '', owner: 'everyone' })).toEqual({ type: undefined, owner: undefined })
    expect(outputsSearchFrom({ type: 'x'.repeat(65), owner: 3 })).toEqual({ type: undefined, owner: undefined })
    expect(outputsSearchFrom({})).toEqual({ type: undefined, owner: undefined })
  })
})

describe('Outputs filters', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  const render = async () => {
    api.authenticatedApi.listOutputs = async () => ({ outputs: testState.outputs, catchingUp: false })
    await act(async () => root!.render(<OutputsPageContent search={testState.search} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  const chip = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Format"] button')]
      .find((button) => button.textContent?.startsWith(label))!
  const titles = () => [...container.querySelectorAll('h3, p')].map((el) => el.textContent)
  const lastSearch = (prev: Search = testState.search) => testState.navigate.mock.lastCall![0].search(prev)

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    testState.search = {}
    testState.outputs = [output(1, 'Launch plan', 'doc'), output(2, 'Expense tracker')]
    localStorage.clear()
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('reads the format filter from the URL, so a reload keeps it', async () => {
    testState.search = { type: 'doc' }
    await render()
    expect(chip('Docs').getAttribute('aria-pressed')).toBe('true')
    expect(chip('All').getAttribute('aria-pressed')).toBe('false')
    expect(titles()).toContain('Launch plan')
    expect(titles()).not.toContain('Expense tracker')
  })

  it('writes a chosen format to the URL, replacing the entry and keeping the scope', async () => {
    testState.search = { owner: 'mine' }
    await render()
    act(() => chip('Docs').click())
    expect(testState.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: '/outputs', replace: true }))
    expect(lastSearch()).toEqual({ owner: 'mine', type: 'doc' })

    act(() => chip('All').click())
    expect(lastSearch({ owner: 'mine', type: 'doc' })).toEqual({ owner: 'mine', type: undefined })
  })

  it('reads a format the page does not offer as All', async () => {
    testState.search = { type: 'retired-format' }
    await render()
    expect(chip('All').getAttribute('aria-pressed')).toBe('true')
    expect(titles()).toEqual(expect.arrayContaining(['Launch plan', 'Expense tracker']))
  })
})
