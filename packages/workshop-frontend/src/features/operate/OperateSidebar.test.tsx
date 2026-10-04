// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOperateSessionError, OPERATE_SESSION_ERROR_CODES, type OperateSessionUpdate } from '@gadgets/workshop-shared/api'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import { INITIAL_OPERATE_PAGE } from '@gadgets/workshop-shared/operate-session'

const harness = vi.hoisted(() => ({ api: {} as unknown, toasts: [] as string[] }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: harness.api }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: true } }) }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: ({ title }: { title: string }) => { harness.toasts.push(title) } }),
}))

import { OperateSessionProvider } from './OperateSessionContext'
import { OperateSidebar } from './OperateSidebar'

const ENG = { id: 'eng', title: 'ENG board', type: 'screen', screen: 's-eng' } as const
const CODE = { id: 'code', title: 'CODE board', type: 'screen', screen: 's-code' } as const
const consoleWith = (views: OperateConsole['views'], revision: string): OperateConsole =>
  ({ id: 'c1', revision, title: 'Live operations lead', fullChat: 'off', views })

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  harness.toasts = []
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const views = () => [...container.querySelectorAll('nav[aria-label="Console"] button')].map(button => button.textContent)

it('re-reads the console when the session refuses a view the builder removed, and says so', async () => {
  // The console as this tab loaded it, then as the builder saved it from another client.
  let saved = consoleWith([ENG, CODE], '0')
  const dispatch = vi.fn<(event: unknown, seq: number) => Promise<never>>(async () => { throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.consoleChanged) })
  const update: OperateSessionUpdate = { seq: 2, state: { ...INITIAL_OPERATE_PAGE, console: {
    workspaceId: 'ws1', consoleId: 'c1', title: 'Live operations lead', fullChat: 'off', viewId: 'eng', screenId: null,
  } } }
  harness.api = {
    listGadgets: async () => [{ id: 'ws1', title: 'Live ENG ops', lastActive: new Date() }],
    openGadget: () => ({
      listCanvases: async () => [], listFlows: async () => [], listConsoles: async () => [saved], [Symbol.dispose]: () => {},
    }),
    getOperateSession: () => ({
      subscribe: async (subscriber: (update: OperateSessionUpdate) => void) => { subscriber(update); return { [Symbol.dispose]: () => {} } },
      listEvents: async () => [],
      dispatch,
      [Symbol.dispose]: () => {},
    }),
  }
  await act(async () => root.render(<OperateSessionProvider><OperateSidebar collapsed={false} onToggleCollapsed={() => {}} /></OperateSessionProvider>))
  expect(views()).toContain('CODE board')

  saved = consoleWith([ENG], '1')
  const code = [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Console"] button')].find(button => button.textContent === 'CODE board')!
  await act(async () => code.click())
  await act(async () => {})

  expect(dispatch).toHaveBeenCalledWith({ type: 'openView', viewId: 'code' }, 2)
  expect(views()).not.toContain('CODE board')
  expect(views()).toContain('ENG board')
  expect(harness.toasts).toEqual(['This console has changed since it was loaded. It now shows as it is saved.'])
})
