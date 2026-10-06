// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createPublicationError, PUBLICATION_ERROR_CODES,
  type AdminApi, type PublicationRecord, type ServerConfig,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
import { AdminPublicationsPanel } from './AdminPublicationsPanel'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toast = vi.hoisted(() => vi.fn<(toast: unknown) => void>())
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: toast }),
}))

const record = (overrides: Partial<PublicationRecord> = {}): PublicationRecord => ({
  id: 'r1',
  artifact: { blueprintId: 'bp', version: 3, digest: 'sha256:abc', kind: 'app', title: 'Board' },
  destination: 'export',
  audience: 'Anyone holding the blueprint link.',
  publishedBy: 'alice',
  requestedAt: new Date('2026-10-05T00:00:00Z'),
  status: 'requested',
  ...overrides,
})

const config = (app: boolean) => ({
  publication: { flags: { PUBLISH_CLOUDFLAREOS_WIDGET: false, PUBLISH_CLOUDFLAREOS_APP: app }, selfApproval: false },
}) as unknown as ServerConfig

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toast.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(admin: Partial<AdminApi>, appFlag = true) {
  await act(async () => {
    root.render(
      <ServerConfigContext.Provider value={config(appFlag)}>
        <AdminPublicationsPanel admin={admin as unknown as RpcStub<AdminApi>} />
      </ServerConfigContext.Provider>,
    )
  })
}

const button = (name: string) => Array.from(container.querySelectorAll('button'))
  .find(candidate => candidate.textContent === name)

describe('AdminPublicationsPanel', () => {
  it('shows each record with what goes out and approves a request', async () => {
    let records = [record()]
    const approvePublication = vi.fn<AdminApi['approvePublication']>(async () => {
      records = [record({ status: 'active', approvedBy: 'admin', at: new Date() })]
      return records[0]!
    })
    await render({ listPublications: async () => records, approvePublication })

    expect(container.textContent).toContain('Board')
    expect(container.textContent).toContain('v3 · app · Export link')
    expect(container.textContent).toContain('Awaiting approval')
    expect(container.textContent).toContain('sha256:abc')

    await act(async () => button('Approve')!.click())
    expect(approvePublication).toHaveBeenCalledWith('r1')
    expect(container.textContent).toContain('Published')
    expect(button('Approve')).toBeUndefined()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }))
  })

  it("keeps the row and says why when the server refuses, such as an admin's own request", async () => {
    await render({
      listPublications: async () => [record({ publishedBy: 'admin' })],
      approvePublication: async () => { throw createPublicationError(PUBLICATION_ERROR_CODES.selfApprovalOff) },
    })

    await act(async () => button('Approve')!.click())
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('another administrator must approve it')
    expect(button('Approve')?.disabled).toBe(false)
  })

  it('opens the reason form with focus in it, and Escape returns focus to Refuse', async () => {
    await render({ listPublications: async () => [record()] })
    const refuse = button('Refuse')!

    await act(async () => refuse.click())
    expect(refuse.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.tagName).toBe('TEXTAREA')

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(refuse)
  })

  it('withdraws with a reason and moves focus to the row it changed', async () => {
    const withdrawPublication = vi.fn<AdminApi['withdrawPublication']>(async (_id, reason) =>
      record({ status: 'withdrawn', approvedBy: 'admin', at: new Date(), withdrawnBy: 'admin', withdrawnAt: new Date(), reason }))
    await render({
      listPublications: async () => [record({ status: 'active', approvedBy: 'admin', at: new Date() })],
      withdrawPublication,
    })

    await act(async () => button('Withdraw')!.click())
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setValue.call(textarea, 'Shared by mistake')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector('form')!.requestSubmit())

    expect(withdrawPublication).toHaveBeenCalledWith('r1', 'Shared by mistake')
    expect(container.textContent).toContain('Withdrawn')
    expect(container.textContent).toContain('Shared by mistake')
    expect(document.activeElement?.tagName).toBe('LI')
  })

  it('says publishing is off when both flags are off, and reports a failed load', async () => {
    await render({ listPublications: async () => [] }, false)
    expect(container.textContent).toContain('Publishing is off on this deployment')
    expect(container.textContent).toContain('No publication requests yet.')

    await render({ listPublications: async () => { throw new Error('Network down') } })
    expect(container.textContent).toContain('Network down')
  })
})
