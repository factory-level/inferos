// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-86 part 2: a console widget's local state in Operate. Only the permitted events are offered,
// a refusal shows the server's words, a conflict reloads instead of overwriting, a widget with no
// states shows nothing, and the operate page is never touched.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import type { WidgetStateSnapshot } from '@gadgets/workshop-shared/widget-state'
import { WidgetStateBar } from './WidgetStateBar'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}))

const REF = { workspaceId: 'console-ws', consoleId: 'intake', revision: '3', gadgetId: 41 }
const VIEWING: WidgetStateSnapshot = { state: 'viewing', seq: 0, events: ['edit'] }
const EDITING: WidgetStateSnapshot = { state: 'editing', seq: 1, events: ['cancel', 'submit'] }

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function fakeSession(overrides: Partial<Record<'getWidgetState' | 'transitionWidget', (...args: never[]) => Promise<WidgetStateSnapshot>>> = {}) {
  const session = {
    getWidgetState: vi.fn<OperateSession['getWidgetState']>(async () => VIEWING),
    transitionWidget: vi.fn<OperateSession['transitionWidget']>(async () => EDITING),
    dispatch: vi.fn<OperateSession['dispatch']>(),
    ...overrides,
  }
  return session
}
async function render(session: ReturnType<typeof fakeSession>, onStateChange?: (state: string | null) => void,
    onPrompt?: (text: string) => void) {
  await act(async () => {
    root.render(<WidgetStateBar session={session as unknown as RpcStub<OperateSession>} widgetRef={REF} onStateChange={onStateChange}
      onPrompt={onPrompt} />)
  })
}
const buttons = () => [...container.querySelectorAll('button')].map(b => b.textContent)
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!

it('shows nothing for a widget that declares no states', async () => {
  await render(fakeSession({
    getWidgetState: async () => { throw new Error('WidgetStateError: WIDGET_HAS_NO_STATES: This widget declares no local states.') },
  }))
  expect(container.innerHTML).toBe('')
})

it('shows the state and offers only its permitted events, and moving it never touches the page', async () => {
  const session = fakeSession()
  await render(session)
  expect(container.textContent).toContain('State: viewing')
  expect(buttons()).toEqual(['edit'])
  await act(async () => { button('edit').click() })
  expect(session.transitionWidget).toHaveBeenCalledWith(REF, 'edit', 0)
  expect(container.textContent).toContain('State: editing')
  expect(buttons()).toEqual(['cancel', 'submit'])
  expect(session.dispatch).not.toHaveBeenCalled()
})

it("shows a refused event in the server's words", async () => {
  const session = fakeSession({
    transitionWidget: async () => {
      throw new Error('WidgetStateError: WIDGET_TRANSITION_NOT_PERMITTED: Event "edit" isn\'t permitted in state "viewing"; it accepts "submit".')
    },
  })
  await render(session)
  await act(async () => { button('edit').click() })
  expect(container.querySelector('[role="alert"]')?.textContent)
    .toBe('Event "edit" isn\'t permitted in state "viewing"; it accepts "submit".')
  expect(container.textContent).toContain('State: viewing')
})

it('reloads the latest state on a conflict instead of overwriting it', async () => {
  const getWidgetState = vi.fn<OperateSession['getWidgetState']>()
    .mockResolvedValueOnce(VIEWING)
    .mockResolvedValueOnce({ state: 'submitting', seq: 2, events: ['fail'] })
  const transitionWidget = vi.fn<OperateSession['transitionWidget']>(async () => {
    throw new Error("WidgetStateError: WIDGET_STATE_CONFLICT: The widget's state changed. Read it again.")
  })
  await render(fakeSession({ getWidgetState, transitionWidget }))
  await act(async () => { button('edit').click() })
  expect(transitionWidget).toHaveBeenCalledTimes(1)
  expect(getWidgetState).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('State: submitting')
  expect(buttons()).toEqual(['fail'])
  expect(container.querySelector('[role="status"]')?.textContent).toContain('It now shows the latest state.')
})

it('reports the state it shows, so the widget can be told, and none while it has none', async () => {
  const heard: (string | null)[] = []
  const getWidgetState = vi.fn<OperateSession['getWidgetState']>()
    .mockResolvedValueOnce(VIEWING)
    .mockResolvedValueOnce({ state: 'submitting', seq: 2, events: ['fail'] })
  let conflict = false
  const transitionWidget = vi.fn<OperateSession['transitionWidget']>(async () => {
    if (conflict) throw new Error("WidgetStateError: WIDGET_STATE_CONFLICT: The widget's state changed. Read it again.")
    return EDITING
  })
  await render(fakeSession({ getWidgetState, transitionWidget }), state => heard.push(state))
  await act(async () => { button('edit').click() })
  conflict = true
  await act(async () => { button('cancel').click() })
  // Loading, then each state shown: the move, and the latest state a conflict reloaded.
  expect(heard).toEqual([null, 'viewing', 'editing', 'submitting'])

  heard.length = 0
  await render(fakeSession({
    getWidgetState: async () => { throw new Error('WidgetStateError: WIDGET_HAS_NO_STATES: This widget declares no local states.') },
  }), state => heard.push(state))
  expect(heard.at(-1)).toBeNull()
})

// FAC-98: an event wired to insert a prompt hands its draft to the page, once per transition; the
// bar sends nothing itself (the session has no send, and only the transition is called).
it('hands a wired draft prompt to the page, and nothing for a transition without one', async () => {
  const onPrompt = vi.fn<(text: string) => void>()
  const session = fakeSession({ transitionWidget: async () => ({ ...EDITING, prompt: { text: 'Summarise this intake' } }) })
  await render(session, undefined, onPrompt)
  await act(async () => button('edit').click())
  expect(onPrompt.mock.calls).toEqual([['Summarise this intake']])
  expect(session.dispatch).not.toHaveBeenCalled()

  const plain = vi.fn<(text: string) => void>()
  await render(fakeSession(), undefined, plain)
  await act(async () => button('edit').click())
  expect(plain).not.toHaveBeenCalled()
})
