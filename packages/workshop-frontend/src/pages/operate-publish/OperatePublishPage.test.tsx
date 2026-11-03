// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  config: null as null | { canvasFeatures?: { composableViews?: boolean } },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replaceAll(`$${key}`, value), to)
    return <a href={href} className={className}>{children}</a>
  },
  useNavigate: () => () => {},
}))
// One stub for every render: the page's effects depend on its identity.
const api = vi.hoisted(() => ({ authenticatedApi: { listGadgets: async () => [] } }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => api }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => testState.config }))
// The workspace is still opening, which is all these cases need.
vi.mock('../../useWorkspaceOpen', () => ({
  useWorkspaceOpen: () => ({ overseer: null, metadata: null, error: null, observerConfig: null, connectionLost: false }),
}))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ workpieces: new Map() }) }))

import { OperatePublishPage } from './OperatePublishPage'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = () => act(() => root.render(<OperatePublishPage workspaceId="w1" spaceId={null} />))

describe('OperatePublishPage', () => {
  it('says Publish to Operate is unavailable when the deployment has composable views off', () => {
    testState.config = { canvasFeatures: { composableViews: false } }
    render()
    expect(container.textContent).toContain("Publish to Operate isn't available on this deployment")
    expect(container.textContent).not.toContain('Loading the review')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/workspace/w1')
  })

  it('treats a deployment that names no canvas features as off', () => {
    testState.config = {}
    render()
    expect(container.textContent).toContain("isn't available on this deployment")
  })

  it('opens the review when composable views are on', () => {
    testState.config = { canvasFeatures: { composableViews: true } }
    render()
    expect(container.textContent).toContain('Loading the review')
    expect(container.textContent).not.toContain("isn't available")
  })

  it('does not claim it is unavailable while the deployment config is still loading', () => {
    testState.config = null
    render()
    expect(container.textContent).toContain('Loading the review')
    expect(container.textContent).not.toContain("isn't available")
  })
})
