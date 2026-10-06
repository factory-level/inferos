// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Location = { pathname: string; href: string; search: Record<string, unknown> }

const testState = vi.hoisted(() => ({
  location: { pathname: '/', href: '/', search: {} } as Location,
  navigate: vi.fn<(options: unknown) => void>(),
  flags: { 'operate-mode': false } as Record<string, boolean>,
  composableViews: true,
  screens: { status: 'loading' } as unknown,
  page: null as unknown,
  dispatch: vi.fn<(event: unknown) => Promise<void>>(async () => {}),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search, children, className, title, ...rest }: {
    to: string; params?: Record<string, string>; search?: Record<string, string>
    children: ReactNode; className?: string; title?: string
  }) => {
    let href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replaceAll(`$${key}`, value), to)
    if (search && Object.keys(search).length > 0) href += `?${new URLSearchParams(search)}`
    return <a href={href} className={className} title={title} {...rest}>{children}</a>
  },
  useRouterState: ({ select }: { select: (state: { location: Location }) => unknown }) =>
    select({ location: testState.location }),
  useNavigate: () => testState.navigate,
}))
vi.mock('@cloudflare/kumo', () => ({
  Tooltip: ({ render }: { render: ReactNode }) => render,
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('../../features/operate/OperateSessionContext', () => ({
  useOperateSession: () => testState.page
    ? { snapshot: { seq: 1, state: testState.page }, dispatch: testState.dispatch, error: null, session: null, recentEvents: [] }
    : null,
}))
vi.mock('../../FeatureFlagsContext', () => ({
  useUiFeatureFlag: (name: string) => ({ enabled: testState.flags[name] ?? false, loading: false }),
}))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => ({ canvasFeatures: { composableViews: testState.composableViews, durableViews: true } }),
  useSiteName: () => 'InferOS',
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useGatekeeperApps', () => ({
  useGatekeeperApps: () => [{ id: 'context', title: 'Context Library' }],
}))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({
  useWorkspaceScreens: () => testState.screens,
}))
vi.mock('../SiteLogo', () => ({ default: ({ children }: { children: ReactNode }) => children }))
vi.mock('./SidebarUtilityStrip', () => ({ default: () => null }))
vi.mock('./SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => children,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => <div data-testid="workspace-lists" />,
}))

import { INITIAL_OPERATE_PAGE, type OperatePageState } from '@gadgets/workshop-shared/operate-session'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import Sidebar from './Sidebar'
import { OperateSidebar } from '../../features/operate/OperateSidebar'
import { resetBuildLocationForTests } from '../../features/operate/operateMode'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const screen = (id: string, title: string) => ({ id, title, sections: [] })
const CONSOLE: OperateConsole = {
  id: 'c1', revision: '0', published: null, title: 'Operations lead', fullChat: 'available',
  views: [
    { id: 'overview', title: 'Overview', type: 'rollup', screens: ['s1', 's2'] },
    { id: 'board', title: 'Board', type: 'screen', screen: 's1' },
    { id: 'activity', title: 'Activity', type: 'screen', screen: 's2' },
  ],
}
const withConsole = (saved: OperateConsole = CONSOLE) => ({
  status: 'ready',
  workspaces: [{ workspace: { id: 'w1' }, screens: [screen('s1', 'Board'), screen('s2', 'Activity')], flows: [], consoles: [saved], publishedScreens: {} }],
})
const inConsole = (viewId: string, extra: Partial<OperatePageState> = {}, saved: OperateConsole = CONSOLE): OperatePageState => ({
  ...INITIAL_OPERATE_PAGE, ...extra,
  console: { workspaceId: 'w1', consoleId: saved.id, title: saved.title, source: 'draft', revision: saved.revision, fullChat: saved.fullChat, viewId, screenId: null },
})

describe('Sidebar modes', () => {
  let root: Root | undefined
  let container: HTMLDivElement

  const goTo = (href: string) => {
    const url = new URL(href, 'http://localhost')
    testState.location = { pathname: url.pathname, href, search: Object.fromEntries(url.searchParams) }
  }
  const render = (collapsed = false) =>
    act(() => root!.render(testState.location.pathname === '/inferops-canvas' && testState.flags['operate-mode'] && testState.composableViews
      ? <OperateSidebar collapsed={collapsed} onToggleCollapsed={() => {}} />
      : <Sidebar collapsed={collapsed} onToggleCollapsed={() => {}} />))
  const modeGroup = () => container.querySelector('[role="group"][aria-label="Mode"]')
  const modeButton = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')]
      .find(button => (button.getAttribute('aria-label') ?? button.textContent) === label)!
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent) === label)
  const link = (label: string) =>
    [...container.querySelectorAll('a')].find(anchor => anchor.textContent === label || anchor.title === label)

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    goTo('/')
    testState.flags = { 'operate-mode': true }
    testState.composableViews = true
    testState.screens = { status: 'loading' }
    testState.page = { ...INITIAL_OPERATE_PAGE }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    resetBuildLocationForTests()
    vi.clearAllMocks()
  })

  it('is the plain Workshop sidebar when the operate-mode flag is off', () => {
    testState.flags = { 'operate-mode': false }
    goTo('/inferops-canvas')
    render()
    expect(modeGroup()).toBeNull()
    expect(link('InferOps Canvas')?.getAttribute('href')).toBe('/inferops-canvas')
    expect(link('Home')).toBeDefined()
    expect(container.querySelector('nav[aria-label="Screens"]')).toBeNull()
  })

  it('hides the toggle when composable views are off', () => {
    testState.composableViews = false
    goTo('/inferops-canvas')
    render()
    expect(modeGroup()).toBeNull()
    expect(link('Home')).toBeDefined()
  })

  it('shows Build pressed on Build pages, without the redundant canvas nav item', () => {
    goTo('/workspaces')
    render()
    expect(modeButton('Build').getAttribute('aria-pressed')).toBe('true')
    expect(modeButton('Operate').getAttribute('aria-pressed')).toBe('false')
    expect(link('InferOps Canvas')).toBeUndefined()
    expect(link('Context Library')).toBeDefined()
    expect(container.querySelector('[data-testid="workspace-lists"]')).not.toBeNull()
  })

  it('offers independent console navigation without configuration controls', () => {
    goTo('/inferops-canvas')
    render()
    expect(modeGroup()).toBeNull()
    expect(button('Back to Build')).toBeUndefined()
    expect(button('All consoles')?.getAttribute('aria-current')).toBe('page')
    expect(link('Home')).toBeUndefined()
    expect(link('Context Library')).toBeUndefined()
    expect(container.querySelector('[data-testid="workspace-lists"]')).toBeNull()
  })

  it("lists the open console's views, marks the shown one, and switches views through the session", async () => {
    testState.screens = withConsole()
    testState.page = inConsole('board')
    goTo('/inferops-canvas')
    render()
    const views = [...container.querySelectorAll('nav[aria-label="Console"] button')].map(item => item.textContent)
    expect(views).toEqual(['All consoles', 'Assistant', 'Overview', 'Board', 'Activity'])
    expect(button('Board')?.getAttribute('aria-current')).toBe('page')
    expect(button('All consoles')?.getAttribute('aria-current')).toBeNull()

    await act(async () => button('Activity')!.click())
    expect(testState.dispatch).toHaveBeenLastCalledWith({ type: 'openView', viewId: 'activity' })
    await act(async () => button('All consoles')!.click())
    expect(testState.dispatch).toHaveBeenLastCalledWith({ type: 'showHome' })
  })

  it('offers full chat only when the console allows it', async () => {
    testState.screens = withConsole({ ...CONSOLE, fullChat: 'off' })
    testState.page = inConsole('overview', {}, { ...CONSOLE, fullChat: 'off' })
    goTo('/inferops-canvas')
    render()
    expect(button('Assistant')).toBeUndefined()

    testState.screens = withConsole()
    testState.page = inConsole('overview')
    render()
    await act(async () => button('Assistant')!.click())
    expect(testState.dispatch).toHaveBeenLastCalledWith({ type: 'setPresentation', presentation: 'chat' })

    // From full chat, picking a view returns to the canvas first, then shows the view.
    testState.page = inConsole('overview', { presentation: 'chat' })
    render()
    expect(button('Assistant')?.getAttribute('aria-current')).toBe('page')
    await act(async () => button('Board')!.click())
    expect(testState.dispatch.mock.calls.slice(-3)).toEqual([
      [{ type: 'setPresentation', presentation: 'canvas' }], [{ type: 'openView', viewId: 'board' }], [{ type: 'setChatOpen', open: true }],
    ])
  })

  it('opens Operate from the configuration workspace', () => {
    goTo('/blueprints?q=crm')
    render()
    act(() => modeButton('Operate').click())
    expect(testState.navigate).toHaveBeenLastCalledWith({ to: '/inferops-canvas' })
  })

  it('opens settings for the current console', () => {
    testState.screens = withConsole()
    testState.page = inConsole('overview')
    goTo('/inferops-canvas')
    render()
    act(() => button('Settings')!.click())
    expect(testState.navigate).toHaveBeenLastCalledWith({ to: '/inferops-canvas', search: { settings: 'c1', workspace: 'w1' } })
  })

  it('keeps labelled icon-only buttons in the collapsed Operate rail', () => {
    testState.screens = withConsole()
    testState.page = inConsole('overview')
    goTo('/inferops-canvas')
    render(true)
    expect(button('Settings')?.textContent).toBe('')
    expect(button('Overview')?.textContent).toBe('')
    expect(button('Overview')?.getAttribute('aria-current')).toBe('page')
  })
})
