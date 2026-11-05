// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOperateSessionError, OPERATE_SESSION_ERROR_CODES } from '@gadgets/workshop-shared/api'
import { MAX_OPERATE_FLOW_HISTORY, type OperateEvent, type OperateFlowRun } from '@gadgets/workshop-shared/operate-session'

vi.mock('./OperateChatPanel', () => ({ OperateChatPanel: () => <div data-testid="chat" /> }))
vi.mock('./FlowScreen', () => ({
  FlowScreen: ({ run }: { run: OperateFlowRun }) => <div data-testid="step">{run.steps[run.index]}</div>,
}))

import { FlowPage } from './FlowPage'

const FLOW: OperateFlowRun =
  { workspaceId: 'ws1', flowId: 'admission', title: 'Admission', steps: ['intake', 'triage', 'orders'], index: 0 }

let container: HTMLDivElement
let root: Root
const onEvent = vi.fn<(event: OperateEvent) => Promise<unknown>>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onEvent.mockReset()
  onEvent.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const render = (index: number, chatOpen = false) => act(() => root.render(
  <FlowPage flow={{ ...FLOW, index }} console={{ open: null, entry: undefined, loading: false, sessionWorkspace: null }}
    chatOpen={chatOpen} onEvent={onEvent} />,
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
    act(() => button('Operate chat').click())
    expect(onEvent).toHaveBeenCalledWith({ type: 'setChatOpen', open: false })
  })
})

// A flow that names its pages: intake leads to review; review can be checked again (a retry) or
// sent back to intake; done ends the flow.
const PAGED: OperateFlowRun = {
  workspaceId: 'ws1', flowId: 'admission', title: 'Admission', steps: ['s-intake', 's-review', 's-done'], index: 0,
  pages: [
    { name: 'intake', routes: [{ label: 'Send for review', to: 'review' }] },
    { name: 'review', states: ['open', 'checked'], routes: [{ label: 'Check again', to: 'review' }, { label: 'Back to intake', to: 'intake' }, { label: 'Approve', to: 'done' }] },
    { name: 'done' },
  ],
  history: [], pageState: null,
}
const renderRun = (flow: OperateFlowRun) => act(() => root.render(
  <FlowPage flow={flow} console={{ open: null, entry: undefined, loading: false, sessionWorkspace: null }}
    chatOpen={false} onEvent={onEvent} />,
))
const navigation = () => [...container.querySelectorAll('[role="group"][aria-label="Flow navigation"] button')]
  .map(item => item.textContent?.trim())
const path = () => [...container.querySelectorAll('nav[aria-label="Path taken"] li')]
  .map(item => item.textContent?.replace('›', '').trim())
const settle = () => act(async () => { await Promise.resolve() })

describe('FlowPage, for a flow that names its pages', () => {
  it("offers the page's routes and Back, never Next or step numbers, and shows where you are", () => {
    renderRun(PAGED)
    expect(navigation()).toEqual(['Back', 'Send for review'])
    expect(button('Back').disabled).toBe(true)
    expect(container.querySelector('h1')?.textContent).toBe('Intake')
    expect(path()).toEqual(['Intake'])
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('Intake')
    expect(container.textContent).not.toMatch(/Step \d of/)
    act(() => button('Send for review').click())
    expect(onEvent).toHaveBeenCalledWith({ type: 'navigateFlow', to: 'review' })
  })

  it('branches, retries and returns by route name, and goes back along the path taken', () => {
    renderRun({ ...PAGED, index: 1, history: [0, 1], pageState: 'open' })
    expect(navigation()).toEqual(['Back', 'Check again', 'Back to intake', 'Approve'])
    expect(path()).toEqual(['Intake', 'Review', 'Review'])
    act(() => button('Check again').click())
    act(() => button('Back to intake').click())
    act(() => button('Approve').click())
    act(() => button('Back').click())
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'navigateFlow', to: 'review' }, { type: 'navigateFlow', to: 'intake' },
      { type: 'navigateFlow', to: 'done' }, { type: 'backFlow' },
    ])
  })

  it('finishes on a page with no routes, and says earlier pages were dropped once the path is full', () => {
    renderRun({ ...PAGED, index: 2, history: Array.from({ length: MAX_OPERATE_FLOW_HISTORY }, () => 1) })
    expect(navigation()).toEqual(['Back', 'Finish'])
    expect(container.querySelector('nav[aria-label="Path taken"] li')?.getAttribute('aria-label')).toBe('Earlier pages')
    act(() => button('Finish').click())
    expect(onEvent).toHaveBeenCalledWith({ type: 'exitFlow' })
  })

  it("shows the page's declared states and picks another, offering none on a page that declares none", () => {
    renderRun({ ...PAGED, index: 1, history: [0], pageState: 'open' })
    const states = [...container.querySelectorAll('[role="group"][aria-label="Page state"] button')]
    expect(states.map(item => [item.textContent, item.getAttribute('aria-pressed')])).toEqual([['open', 'true'], ['checked', 'false']])
    act(() => button('checked').click())
    expect(onEvent).toHaveBeenCalledWith({ type: 'setFlowPageState', state: 'checked' })
    renderRun(PAGED)
    expect(container.querySelector('[aria-label="Page state"]')).toBeNull()
  })

  it("keeps routes out of the step's own content: page navigation is never drawn among a screen's widget actions", () => {
    renderRun({ ...PAGED, index: 1, history: [0], pageState: 'open' })
    const main = container.querySelector('main')!
    expect([...main.querySelectorAll('button')]).toEqual([])
    expect(main.textContent).toBe('s-review')
  })

  it("shows a page that may no longer be opened as a plain refusal in the session's words, and stays where it is", async () => {
    onEvent.mockRejectedValueOnce(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.flowPageUnavailable))
    renderRun({ ...PAGED, index: 1, history: [0], pageState: 'open' })
    act(() => button('Approve').click())
    await settle()
    const refusal = container.querySelector('[role="alert"]')?.textContent
    expect(refusal).toBe("That page of the flow isn't available to you any more. Go back, or leave the flow.")
    expect(refusal).not.toMatch(/done|review|s-done|ws1/i)
    expect(container.querySelector('h1')?.textContent).toBe('Review')
    expect(navigation()).toEqual(['Back', 'Check again', 'Back to intake', 'Approve'])
    // Going back is still offered, and a move that succeeds clears the refusal.
    act(() => button('Back').click())
    await settle()
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'backFlow' })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('offers to try a move again when the session could not check its page just now, and only then', async () => {
    onEvent.mockRejectedValueOnce(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.flowNavigationFailed))
    renderRun({ ...PAGED, index: 1, history: [0], pageState: 'open' })
    act(() => button('Approve').click())
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't move to that page of the flow just now. Try again.")
    expect(container.querySelector('h1')?.textContent).toBe('Review')
    act(() => button('Try again').click())
    await settle()
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'navigateFlow', to: 'done' }, { type: 'navigateFlow', to: 'done' },
    ])
    expect(container.querySelector('[role="alert"]')).toBeNull()
    // A page that may no longer be opened is not retried: Back or Exit are the ways on.
    onEvent.mockRejectedValueOnce(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.flowPageUnavailable))
    act(() => button('Approve').click())
    await settle()
    expect([...container.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Try again')).toBe(false)
  })

  it("drops a refusal and its Try again once the run moves from another tab or device", async () => {
    onEvent.mockRejectedValueOnce(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.flowNavigationFailed))
    const at = { ...PAGED, index: 1, history: [0], pageState: 'open' }
    renderRun(at)
    act(() => button('Approve').click())
    await settle()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    // The session moved on elsewhere: forward to done, then a retry back to the same page (index unchanged).
    renderRun({ ...PAGED, index: 2, history: [0, 1], pageState: null })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect([...container.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Try again')).toBe(false)
    onEvent.mockRejectedValueOnce(new Error('refused'))
    renderRun(at)
    act(() => button('Check again').click())
    await settle()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    renderRun({ ...at, history: [0, 1] })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keys routes by position, so two routes with the same label and destination are both drawn', () => {
    const twice: OperateFlowRun = { ...PAGED, pages: [{ name: 'intake', routes: [{ label: 'Go', to: 'review' }, { label: 'Go', to: 'review' }] }, PAGED.pages![1]!, PAGED.pages![2]!] }
    const errors = vi.mocked(console.error)
    renderRun(twice)
    expect(navigation()).toEqual(['Back', 'Go', 'Go'])
    expect(errors.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false)
  })

  it('says any other refusal plainly, without the internal detail', async () => {
    onEvent.mockRejectedValueOnce(new Error('internal: page index 7 of ws1'))
    renderRun(PAGED)
    act(() => button('Send for review').click())
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('That change could not be applied to your session.')
  })
})

describe('FlowPage, for a flow in order', () => {
  it('offers no routes, path or page states, and a refused step is said in place too', async () => {
    onEvent.mockRejectedValueOnce(new Error('refused'))
    render(1)
    expect(container.querySelector('[aria-label="Flow navigation"]')).toBeNull()
    expect(container.querySelector('nav[aria-label="Path taken"]')).toBeNull()
    act(() => button('Next').click())
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('That change could not be applied to your session.')
  })
})
