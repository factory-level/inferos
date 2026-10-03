// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperateEvent, OperateFlowRun } from '@gadgets/workshop-shared/operate-session'

vi.mock('./OperateChatPanel', () => ({ OperateChatPanel: () => <div data-testid="chat" /> }))
vi.mock('./FlowScreen', () => ({
  FlowScreen: ({ screenId }: { screenId: string }) => <div data-testid="step">{screenId}</div>,
}))

import { FlowPage } from './FlowPage'

const FLOW: OperateFlowRun =
  { workspaceId: 'ws1', flowId: 'admission', title: 'Admission', steps: ['intake', 'triage', 'orders'], index: 0 }

let container: HTMLDivElement
let root: Root
const onEvent = vi.fn<(event: OperateEvent) => void>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onEvent.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (index: number, chatOpen = false) => act(() => root.render(
  <FlowPage flow={{ ...FLOW, index }} chatOpen={chatOpen} onEvent={onEvent} />,
))
const button = (name: string) => {
  const found = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name)
  if (!found) throw new Error(`No button named ${name}`)
  return found
}

describe('FlowPage', () => {
  it('shows the first step with nowhere to go back to', () => {
    render(0)
    expect(container.querySelector('h1')?.textContent).toBe('Step 1 of 3')
    expect(container.querySelector('[data-testid="step"]')?.textContent).toBe('intake')
    expect(button('Back').disabled).toBe(true)
    act(() => button('Next').click())
    expect(onEvent).toHaveBeenCalledWith({ type: 'goToStep', index: 1 })
  })

  it('moves back and forward from a middle step', () => {
    render(1)
    expect(container.querySelector('[data-testid="step"]')?.textContent).toBe('triage')
    act(() => button('Back').click())
    act(() => button('Next').click())
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'goToStep', index: 0 }, { type: 'goToStep', index: 2 },
    ])
  })

  it('finishes on the last step instead of offering a next one, and can be exited at any step', () => {
    render(2)
    expect(container.querySelector('h1')?.textContent).toBe('Step 3 of 3')
    expect([...container.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Next')).toBe(false)
    act(() => button('Finish').click())
    act(() => button('Exit Admission').click())
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([{ type: 'exitFlow' }, { type: 'exitFlow' }])
  })

  it('keeps the operate chat available beside the step', () => {
    render(0, true)
    expect(container.querySelector('[data-testid="chat"]')).not.toBeNull()
    act(() => button('Operate chat').click())
    expect(onEvent).toHaveBeenCalledWith({ type: 'setChatOpen', open: false })
  })
})
