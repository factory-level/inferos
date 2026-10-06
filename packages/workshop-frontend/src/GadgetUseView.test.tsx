// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }))
vi.mock('./GadgetUI', () => ({ default: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
import GadgetUseView from './GadgetUseView'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (metadata: GadgetMetadata) => act(() => root.render(
  <GadgetUseView overseer={{} as RpcStub<Overseer>} gadget={null} selectedGadgetId={null} gadgets={[]}
    onSelectGadget={() => {}} metadata={metadata} authenticatedApi={{} as RpcStub<AuthenticatedApi>} currentUserId={null} />))

it('shows a use-role viewer that the space is test-only, and nothing for a normal one', () => {
  render({ id: 'space', title: 'Night shift', role: 'use', testOnly: true })
  expect(container.textContent).toContain('Test space')
  render({ id: 'space', title: 'Night shift', role: 'use' })
  expect(container.textContent).not.toContain('Test space')
})
