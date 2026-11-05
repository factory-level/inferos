// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GadgetClient, GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'

const toast = vi.fn<(toast: { title: string; variant?: string }) => void>()
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: toast }),
}))
vi.mock('./features/publication/PublicationReview', () => ({ PublicationReview: () => null }))

const { default: BlueprintModal } = await import('./BlueprintModal')

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  toast.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals() })

const metadata = { title: 'Fictional status widget' } as GadgetMetadata
const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(text))

// FAC-8: registering an authored widget runs the server's build; its refusal is the publish result.
it('announces a build refusal in the server\'s words and never claims the version was registered', async () => {
  const overseer = { listBlueprints: vi.fn<Overseer['listBlueprints']>(async () => []) } as unknown as RpcStub<Overseer>
  const createBlueprint = vi.fn<GadgetClient['createBlueprint']>(async () => { throw new Error('Invalid source path.') })
  const gadget = {
    listBindings: vi.fn<GadgetClient['listBindings']>(async () => []),
    setBlueprintAnnotation: vi.fn<GadgetClient['setBlueprintAnnotation']>(async () => {}),
    createBlueprint,
  } as unknown as RpcStub<GadgetClient>
  await act(async () => root.render(
    <BlueprintModal open onClose={() => {}} overseer={overseer} gadget={gadget} metadata={metadata} />))
  await act(async () => buttonByText('Create blueprint')!.click())
  await vi.waitFor(() => expect(buttonByText('Create')?.textContent).toBe('Create'))
  await act(async () => buttonByText('Create')!.click())

  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Invalid source path.'))
  expect(createBlueprint).toHaveBeenCalledTimes(1)
  expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }))
  // Still on the form, so the author can fix the source and register again.
  expect(buttonByText('Create')?.textContent).toBe('Create')
})
