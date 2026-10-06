// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintPublicInfo,
  PublicApi,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  search: {} as { space?: string },
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn<() => void>(),
  useParams: () => ({ id: 'blueprint-one' }),
  useSearch: () => testState.search,
  useRouter: () => ({ history: { back: vi.fn<() => void>(), canGoBack: () => false } }),
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: testState.authenticatedApi,
    isLoading: false,
    login: vi.fn<(token: string) => void>(),
  }),
}))

// The verification modal itself is tested on its own; here it only confirms or cancels.
vi.mock('./ObserverConfigModal', () => ({
  default: ({ needs, onConfirm, onCancel }: { needs: unknown[]; onConfirm: (choices: unknown[]) => void; onCancel: () => void }) =>
    <section aria-label="Verify connections">
      <span>{needs.length} to verify</span>
      <button onClick={() => onConfirm([{ gatekeeperId: 3, accountId: 9 }])}>Verify</button>
      <button onClick={onCancel}>Cancel verification</button>
    </section>,
}))

import BlueprintLandingPage from './BlueprintLandingPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const originalInnerWidth = window.innerWidth

const MODEL: AiChatAuthorInfo = {
  type: 'agent',
  id: 'model-one',
  name: 'Model one',
}

const BLUEPRINT: BlueprintPublicInfo = {
  id: 'blueprint-one',
  metadata: {
    title: 'Model blueprint',
    description: 'Requires an AI model.',
    author: { type: 'user', id: 'author', name: 'Author' },
    created: new Date('2026-08-24T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-08-24T00:00:00Z'),
    bindings: {
      AI: {
        type: 'aiModel',
        title: 'Claude Sonnet 5',
        description: '',
      },
    },
  },
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  return {
    listModels: async () => [MODEL],
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: subscription,
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
    getBlueprintInfo: async () => BLUEPRINT,
  } as unknown as RpcStub<AuthenticatedApi>
}

// Signed in, the page reads through AuthenticatedApi.getBlueprintInfo; the public read serves only
// published blueprints, so it must not be what a signed-in page depends on.
const publicGetBlueprint = vi.fn<() => Promise<BlueprintPublicInfo | null>>(async () => null)
function publicApi(): RpcStub<PublicApi> {
  return {
    getBlueprint: publicGetBlueprint,
  } as unknown as RpcStub<PublicApi>
}

describe('BlueprintLandingPage model configuration', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    testState.search = {}
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  })

  it('portals model options within the configure dialog and accepts a selection', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    testState.authenticatedApi = authenticatedApi()
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi()} />))
    await act(async () => { await Promise.resolve() })

    const configure = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent === 'Configure')!
    await act(async () => configure.click())

    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!
    await act(async () => trigger.click())

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    // Inside the dialog's own portal, where the modal dialog leaves it visible to assistive tech;
    // styles.css raises its positioner above the dialog layers.
    const dialogPortal = document.body.querySelector('[role="dialog"]')!.closest('[data-base-ui-portal]')!
    expect(dialogPortal.contains(option)).toBe(true)
    expect(option.closest('[aria-hidden="true"], [inert]')).toBeNull()

    await act(async () => option.click())
    expect(trigger.textContent).toContain('Model one')

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Save connection')!
    expect(save.disabled).toBe(false)
  })

  it('reads an unpublished blueprint as a signed-in person of the deployment', async () => {
    testState.authenticatedApi = authenticatedApi()
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi()} />))
    await act(async () => { await Promise.resolve() })

    expect(document.body.textContent).toContain('Model blueprint')
  })

  it('installs the reviewed version into the space the review named, with the chosen model', async () => {
    const installBlueprint = vi.fn<(...args: unknown[]) => Promise<number>>()
      .mockRejectedValueOnce(new Error('Peer closed WebSocket')).mockResolvedValue(4)
    const openGadget = vi.fn<(id: string, shareKey?: string, callback?: unknown) => Promise<unknown>>()
      .mockResolvedValue({ installBlueprint, [Symbol.dispose]() {} })
    const newGadgetFromBlueprint = vi.fn<() => never>()
    testState.authenticatedApi = Object.assign(authenticatedApi(), { openGadget, newGadgetFromBlueprint }) as unknown as RpcStub<AuthenticatedApi>
    testState.search = { space: 'f'.repeat(64) }
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi()} />))
    await act(async () => { await Promise.resolve() })

    const buttonNamed = (name: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === name)
    await act(async () => buttonNamed('Configure')!.click())
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!.click())
    await act(async () => document.body.querySelector<HTMLElement>('[role="option"]')!.click())
    await act(async () => buttonNamed('Save connection')!.click())

    expect(publicGetBlueprint).not.toHaveBeenCalled()
    const install = buttonNamed('Install version 1 into the space')!
    // The first request's answer is lost; the retry names the same intent, so the kernel returns
    // the install it may already have made instead of making a second.
    await act(async () => install.click())
    expect(document.body.textContent).toContain('Peer closed WebSocket')
    await act(async () => buttonNamed('Install version 1 into the space')!.click())
    expect(openGadget).toHaveBeenCalledWith('f'.repeat(64), undefined, expect.anything())
    expect(installBlueprint).toHaveBeenCalledTimes(2)
    const [first, retry] = installBlueprint.mock.calls
    expect(first).toEqual(['blueprint-one', { AI: { type: 'aiModel', modelId: 'model-one' } },
      { version: 1, kind: 'app', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }])
    expect(retry![2]).toEqual(first![2])
    expect(newGadgetFromBlueprint).not.toHaveBeenCalled()
  })

  async function installIntoSpace(verify: 'Verify' | 'Cancel verification') {
    const installBlueprint = vi.fn<(...args: unknown[]) => Promise<number>>().mockResolvedValue(4)
    // Opening a space with connections asks the build collaborator to verify them, as Build does.
    type Configure = { configure(needs: unknown[]): Promise<unknown[]> }
    const openGadget = vi.fn<(id: string, shareKey: string | undefined, callback: Configure) => Promise<unknown>>(
        async (_id, _shareKey, callback) => {
      const choices = await callback.configure([{ gatekeeperId: 3 }])
      return { installBlueprint, choices, [Symbol.dispose]() {} }
    })
    testState.authenticatedApi = Object.assign(authenticatedApi(), { openGadget }) as unknown as RpcStub<AuthenticatedApi>
    testState.search = { space: 'e'.repeat(64) }
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi()} />))
    await act(async () => { await Promise.resolve() })
    const buttonNamed = (name: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === name)
    await act(async () => buttonNamed('Configure')!.click())
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!.click())
    await act(async () => document.body.querySelector<HTMLElement>('[role="option"]')!.click())
    await act(async () => buttonNamed('Save connection')!.click())
    await act(async () => buttonNamed('Install version 1 into the space')!.click())
    const prompt = document.body.querySelector('[aria-label="Verify connections"]')
    expect(prompt?.textContent).toContain('1 to verify')
    await act(async () => buttonNamed(verify)!.click())
    await act(async () => { await Promise.resolve() })
    return { installBlueprint }
  }

  it('asks the person to verify the space\'s connections, then installs', async () => {
    const { installBlueprint } = await installIntoSpace('Verify')
    expect(installBlueprint).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[aria-label="Verify connections"]')).toBeNull()
  })

  it('installs nothing when the person cancels verifying, and says why', async () => {
    const { installBlueprint } = await installIntoSpace('Cancel verification')
    expect(installBlueprint).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('You must choose connected accounts for the services this workspace uses.')
  })
})
