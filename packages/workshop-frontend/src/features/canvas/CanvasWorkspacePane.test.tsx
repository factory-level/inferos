// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { CanvasWorkspacePane } from './CanvasWorkspacePane'
import type { CanvasStorage } from './useCanvasWorkspace'

vi.mock('../../GadgetUI', () => ({ default: () => null }))

let root: Root
let container: HTMLDivElement
const overseer = {} as RpcStub<Overseer>
const render = async (storage: CanvasStorage) => {
  await act(async () => root.render(<CanvasWorkspacePane storage={storage} overseer={overseer} gadgets={new Map()} />))
}
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('labels temporary views as unsaved and opens a newly created view for editing', async () => {
  await render({ kind: 'temporary' })
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Unsaved views')
  expect(button('Edit layout')).toBeDefined()
  await act(async () => { container.querySelector('form')!.requestSubmit() })
  expect(button('Operations')?.getAttribute('aria-pressed')).toBe('true')
  expect(button('Done editing')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.textContent).toContain('Add gadget')
  await act(async () => { button('Done editing')!.click() })
  expect(container.textContent).toContain('No widgets in this section yet.')
})

it('labels durable views as saved', async () => {
  await render({ kind: 'durable', api: { listCanvases: async () => [], createCanvas: vi.fn<Overseer['createCanvas']>(), editCanvas: vi.fn<Overseer['editCanvas']>(), deleteCanvas: vi.fn<Overseer['deleteCanvas']>() } })
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved views')
})
