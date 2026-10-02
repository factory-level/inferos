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
vi.mock('@cloudflare/kumo', () => ({ Tooltip: ({ render }: { render: ReactNode }) => render }))
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

import Sidebar from './Sidebar'
import { resetBuildLocationForTests } from '../../features/operate/operateMode'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const screen = (id: string, title: string) => ({ id, title, sections: [] })

describe('Sidebar modes', () => {
  let root: Root | undefined
  let container: HTMLDivElement

  const goTo = (href: string) => {
    const url = new URL(href, 'http://localhost')
    testState.location = { pathname: url.pathname, href, search: Object.fromEntries(url.searchParams) }
  }
  const render = (collapsed = false) =>
    act(() => root!.render(<Sidebar collapsed={collapsed} onToggleCollapsed={() => {}} />))
  const modeGroup = () => container.querySelector('[role="group"][aria-label="Mode"]')
  const modeButton = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')]
      .find(button => (button.getAttribute('aria-label') ?? button.textContent) === label)!
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

  it('lists saved screens instead of the Build nav in Operate, highlighting the open one', () => {
    testState.screens = {
      status: 'ready',
      workspaces: [
        { workspace: { id: 'w1' }, screens: [screen('s1', 'Ops board'), screen('s2', 'Weekly review')] },
        { workspace: { id: 'w2' }, screens: null },
      ],
    }
    goTo('/workspace/w1/inferops-canvas?view=s2')
    render()

    expect(modeButton('Operate').getAttribute('aria-pressed')).toBe('true')
    const screens = container.querySelector('nav[aria-label="Screens"]')!
    expect([...screens.querySelectorAll('a')].map(anchor => [anchor.textContent, anchor.getAttribute('href')])).toEqual([
      ['Ops board', '/workspace/w1/inferops-canvas?view=s1'],
      ['Weekly review', '/workspace/w1/inferops-canvas?view=s2'],
    ])
    expect(link('Weekly review')?.getAttribute('aria-current')).toBe('page')
    expect(link('Ops board')?.getAttribute('aria-current')).toBeNull()
    expect(link('New screen')?.getAttribute('href')).toBe('/inferops-canvas')
    expect(link('Context Library')).toBeDefined()
    expect(link('Home')).toBeUndefined()
    expect(container.querySelector('[data-testid="workspace-lists"]')).toBeNull()
  })

  it('says when there are no saved screens yet', () => {
    testState.screens = { status: 'ready', workspaces: [{ workspace: { id: 'w1' }, screens: [] }] }
    goTo('/inferops-canvas')
    render()
    expect(container.textContent).toContain('No saved screens yet.')
  })

  it('opens Operate at the canvas home and returns Build to the last Build location', () => {
    goTo('/blueprints?q=crm')
    render()
    act(() => modeButton('Operate').click())
    expect(testState.navigate).toHaveBeenLastCalledWith({ to: '/inferops-canvas' })

    goTo('/inferops-canvas')
    render()
    goTo('/workspace/w1/inferops-canvas?view=s1')
    render()
    act(() => modeButton('Build').click())
    expect(testState.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ href: '/blueprints?q=crm' }))
  })

  it('returns Build to Home when no Build page was visited this session', () => {
    goTo('/inferops-canvas')
    render()
    act(() => modeButton('Build').click())
    expect(testState.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ href: '/' }))
  })

  it('keeps labelled icon-only mode buttons in the collapsed sidebar', () => {
    goTo('/inferops-canvas')
    render(true)
    expect(modeButton('Build').textContent).toBe('')
    expect(modeButton('Operate').getAttribute('aria-pressed')).toBe('true')
  })
})
