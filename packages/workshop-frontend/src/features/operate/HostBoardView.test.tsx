// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostBoardView } from './HostBoardView'
import type { HostBoardViewState } from './hostBoardState'
import type { HostBoardViewSnapshot as BoardSnapshot } from '@gadgets/workshop-shared/operate-console'

const HOSTILE = '<img src=x onerror=alert(1)>'
const board = (title = 'Fix the login'): BoardSnapshot => ({
  project: { identifier: 'ENG', name: 'Engineering' },
  columns: [
    { label: 'Todo', group: 'unstarted', issues: [
      { identifier: 'ENG-1', title, priority: 'urgent', targetDate: '2026-10-20', blocked: true },
      { identifier: 'ENG-2', title: 'Write docs', priority: 'none', targetDate: null, blocked: false },
    ] },
    { label: 'Shipped', group: 'completed', issues: [] },
  ],
})
const READ_AT = '2026-10-08T12:00:00.000Z'

let container: HTMLDivElement
let root: Root
const onRetry = vi.fn<() => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onRetry.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const render = (view: HostBoardViewState) =>
  act(() => root.render(<HostBoardView label="Team board" view={view} picker={<button type="button">Pick a connection</button>} onRetry={onRetry} />))
const region = () => container.querySelector('section[aria-label="Team board"]') as HTMLElement

describe('HostBoardView', () => {
  it('renders the board as columns and cards with the read time', () => {
    render({ status: 'ok', board: board(), readAt: READ_AT })
    const columns = [...region().querySelectorAll('section')]
    expect(columns.map(c => c.getAttribute('aria-label'))).toEqual(['Todo', 'Shipped'])
    expect(columns[0].querySelector('h3')?.textContent).toBe('TodoNot started · 2')
    const card = columns[0].querySelector('li')!
    expect(card.textContent).toContain('ENG-1')
    expect(card.textContent).toContain('Fix the login')
    expect(card.textContent).toContain('Urgent')
    expect(card.textContent).toContain('Blocked')
    expect(card.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-20')
    expect(columns[0].querySelectorAll('li')[1].textContent).not.toContain('Blocked')
    expect(region().querySelector('header time')?.getAttribute('dateTime')).toBe(READ_AT)
    expect(region().querySelector('a, iframe')).toBeNull()
    const scroller = region().querySelector('[role="group"]')!
    expect(scroller.getAttribute('aria-label')).toBe('Team board columns')
    expect(scroller.getAttribute('tabindex')).toBe('0')
  })

  it('shows the picker slot with fixed copy when not connected', () => {
    render({ status: 'not-connected' })
    expect(region().textContent).toContain('Not connected for you.')
    expect(region().querySelector('button')?.textContent).toBe('Pick a connection')
  })

  it('shows neutral copy with Retry when unavailable, and keeps focus in the board on Retry', () => {
    render({ status: 'unavailable' })
    expect(region().querySelector('[role="status"]')?.textContent).toBe('This board is unavailable right now.')
    const retry = [...region().querySelectorAll('button')].find(b => b.textContent === 'Retry')!
    act(() => retry.focus())
    act(() => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
    render({ status: 'loading' })
    expect(document.activeElement).toBe(region())
  })

  it('announces loading', () => {
    render({ status: 'loading' })
    expect(region().querySelector('[role="status"]')?.textContent).toContain('Reading the board')
  })

  it.each(['unknown', 'cleared'] as const)('renders nothing inside the board when %s', (status) => {
    render({ status })
    expect(region().textContent).toBe('')
    expect(region().children).toHaveLength(0)
  })

  it('keeps hostile strings as text', () => {
    const hostile = board(HOSTILE)
    hostile.project.name = HOSTILE
    hostile.columns[0].label = HOSTILE
    hostile.columns[0].issues[0].identifier = HOSTILE
    render({ status: 'ok', board: hostile, readAt: READ_AT })
    expect(container.querySelector('img')).toBeNull()
    expect(region().textContent).toContain(HOSTILE)
  })

  it('puts no snapshot data in the console, localStorage or the URL', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level))
    const before = window.location.href
    localStorage.clear()
    render({ status: 'ok', board: board('Secret roadmap item'), readAt: READ_AT })
    render({ status: 'cleared' })
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('Secret roadmap item')
    }
    expect(localStorage.length).toBe(0)
    expect(window.location.href).toBe(before)
  })
})
