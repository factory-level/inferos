// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createPublicationError, PUBLICATION_ERROR_CODES,
  type AuthenticatedApi, type BlueprintPublicInfo, type PublicationRecord, type ServerConfig,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
import { PublicationReview } from './PublicationReview'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

// jsdom has no PointerEvent, which Kumo's radio dispatches on click.
if (!('PointerEvent' in window)) {
  Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
}

const state = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: state.api }),
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

const BLUEPRINT: BlueprintPublicInfo = {
  id: 'bp',
  metadata: {
    title: 'Board',
    description: 'Team board',
    author: { type: 'user', id: 'alice', name: 'Alice' },
    created: new Date('2026-10-01T00:00:00Z'),
    version: 4,
    lastUpdated: new Date('2026-10-01T00:00:00Z'),
    kind: 'widget',
    bindings: {
      DATA: { type: 'aiModel', title: 'A model', description: '' },
    },
  },
}

const requested = (destination: PublicationRecord['destination']): PublicationRecord => ({
  id: `r-${destination}`,
  artifact: { blueprintId: 'bp', version: 4, kind: 'widget', title: 'Board' },
  destination,
  audience: 'Reach.',
  publishedBy: 'alice',
  requestedAt: new Date(),
  status: 'requested',
})

const config = (widget: boolean) => ({
  publication: { flags: { PUBLISH_CLOUDFLAREOS_WIDGET: widget, PUBLISH_CLOUDFLAREOS_APP: false }, selfApproval: false },
}) as unknown as ServerConfig

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
  state.api = null
})

async function render(api: Partial<AuthenticatedApi>, widgetFlag = true) {
  state.api = { getBlueprintInfo: async () => BLUEPRINT, listOwnPublications: async () => [], ...api } as
      unknown as RpcStub<AuthenticatedApi>
  await act(async () => {
    root.render(
      <ServerConfigContext.Provider value={config(widgetFlag)}>
        <PublicationReview blueprintId="bp" onBack={() => {}} />
      </ServerConfigContext.Provider>,
    )
  })
}

const button = (name: string) => Array.from(container.querySelectorAll('button'))
  .find(candidate => candidate.textContent === name)

describe('PublicationReview', () => {
  it('shows exactly what goes out, and requests the destination chosen', async () => {
    const requestPublication = vi.fn<AuthenticatedApi['requestPublication']>(async (_id, destination) =>
      requested(destination))
    await render({ requestPublication })

    expect(document.activeElement?.textContent).toBe('Publish "Board"')
    expect(container.textContent).toContain('v4, as published now')
    expect(container.textContent).toContain('widget')
    expect(container.textContent).toContain('A model')
    expect(container.textContent).toContain('Never your chats, workspace data')

    const exportOption = Array.from(container.querySelectorAll('[role="radio"]'))
      .find(option => option.closest('label')?.textContent?.startsWith('Export link')) as HTMLElement
    await act(async () => exportOption.click())
    await act(async () => button('Request publication')!.click())

    expect(requestPublication).toHaveBeenCalledWith('bp', 'export')
    expect(container.textContent).toContain('Awaiting approval')
    expect(button('Cancel request')).toBeDefined()
  })

  it("offers no request while the kind's flag is off", async () => {
    await render({}, false)
    expect(container.textContent).toContain('Publishing widgets is off on this deployment')
    expect(button('Request publication')).toBeUndefined()
  })

  it('announces a refused request and keeps the choice', async () => {
    await render({
      requestPublication: async () => { throw createPublicationError(PUBLICATION_ERROR_CODES.widgetFlagOff) },
    })
    await act(async () => button('Request publication')!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('PUBLISH_CLOUDFLAREOS_WIDGET')
    expect(button('Request publication')?.disabled).toBe(false)
  })

  it('lets the owner cancel a request, returning focus when the form is dismissed', async () => {
    const withdrawPublication = vi.fn<AuthenticatedApi['withdrawPublication']>(async () => ({ ...requested('deployment'), status: 'withdrawn' as const,
      withdrawnBy: 'alice', withdrawnAt: new Date(), reason: '' }))
    await render({ listOwnPublications: async () => [requested('deployment')], withdrawPublication })
    const cancel = button('Cancel request')!

    await act(async () => cancel.click())
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.activeElement).toBe(cancel)

    await act(async () => cancel.click())
    await act(async () => container.querySelector('form')!.requestSubmit())
    expect(withdrawPublication).toHaveBeenCalledWith('r-deployment', '')
    expect(container.textContent).toContain('Withdrawn')
    expect(document.activeElement?.textContent).toBe('Publish "Board"')
  })

  it('says so when the blueprint is gone', async () => {
    await render({ getBlueprintInfo: async () => null })
    expect(container.textContent).toContain('This blueprint no longer exists.')
  })
})
