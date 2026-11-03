// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: ReactNode }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replaceAll(`$${key}`, value), to)
    return <a href={href} {...rest}>{children}</a>
  },
}))
vi.mock('@cloudflare/kumo', () => ({ useKumoToastManager: () => ({ add: () => {} }) }))
// One stub for every render: the page's load effect depends on its identity.
const api = vi.hoisted(() => ({
  authenticatedApi: {
    listFeaturedBlueprints: async () => [{
      id: 'bp-1',
      screenshotUrl: null,
      metadata: {
        title: 'Weekly report',
        description: 'Summarise the week',
        bindings: [{ type: 'aiModel' }],
      },
    }],
    listGatekeeperVendors: async () => [],
  },
}))
vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => api,
  useOptionalAuthenticatedApi: () => null,
}))
vi.mock('./hooks/useBlueprintScreenshotSrc', () => ({ useBlueprintScreenshotSrc: () => null }))
vi.mock('./ServerConfigContext', () => ({ useDisplayDensity: () => 'comfortable' }))

import BlueprintsPage from './BlueprintsPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Explore cards', () => {
  let root: Root | undefined
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    localStorage.setItem('explore-view', 'grid')
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    localStorage.clear()
  })

  it('opens the blueprint from anywhere on the card, its text and badges included', async () => {
    await act(async () => root!.render(<BlueprintsPage />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    const card = container.querySelector('a[aria-label="Open featured blueprint Weekly report"]')
    expect(card?.getAttribute('href')).toBe('/blueprint/bp-1')
    for (const text of ['Weekly report', 'Summarise the week']) {
      const element = [...container.querySelectorAll('p')].find((p) => p.textContent === text)
      expect(element?.closest('a')).toBe(card)
    }
    const badge = [...card!.querySelectorAll('span')].find((span) => span.textContent === 'AI Model')
    expect(badge?.closest('a')).toBe(card)
    // One link per card: nothing inside it is a second interactive element.
    expect(card!.querySelectorAll('a, button, input, select, textarea').length).toBe(0)
  })
})
