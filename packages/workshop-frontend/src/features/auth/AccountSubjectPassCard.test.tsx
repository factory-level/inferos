// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AccountSubjectPass, AdminApi } from '@gadgets/workshop-shared/api'
import { AccountSubjectPassCard } from './AccountSubjectPassCard'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

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
})

const pass = (overrides: Partial<AccountSubjectPass> = {}): AccountSubjectPass => ({
  checked: 3, bound: 2, alreadyBound: 1, conflicts: 0, ...overrides,
})

function render(bindAccountSubjects: AdminApi['bindAccountSubjects']) {
  const admin = { bindAccountSubjects } as unknown as RpcStub<AdminApi>
  act(() => root.render(<AccountSubjectPassCard admin={admin} />))
}

const button = (name: string | RegExp) => {
  const found = [...container.querySelectorAll('button')].find(b =>
    typeof name === 'string' ? b.textContent === name : name.test(b.textContent ?? ''))
  if (!found) throw new Error(`no button ${name}`)
  return found
}

const click = async (name: string | RegExp) => {
  await act(async () => { button(name).click() })
}

const status = () => container.querySelector('[role="status"]')?.textContent ?? ''

describe('the one-off subject pass card', () => {
  it('runs only after the second, explicit step, and cancelling runs nothing', async () => {
    const bind = vi.fn<AdminApi['bindAccountSubjects']>(async () => pass())
    render(bind)
    await click('Bind accounts…')
    expect(container.textContent).toContain("Binding can't be undone here")
    await click('Cancel')
    expect(bind).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("Binding can't be undone here")
  })

  it('shows what the pass did, in counts, once it finishes', async () => {
    const bind = vi.fn<AdminApi['bindAccountSubjects']>(async () => pass())
    render(bind)
    await click('Bind accounts…')
    await click('Bind accounts')
    expect(bind).toHaveBeenCalledOnce()
    expect(status()).toContain('Checked 3 accounts: bound 2, already bound 1.')
    expect(button('Run the pass again…')).toBeTruthy()
  })

  it('says so when there is nothing to bind, or nothing holds a vouching connection', async () => {
    render(vi.fn<AdminApi['bindAccountSubjects']>(async () => pass({ checked: 0, bound: 0, alreadyBound: 0 })))
    await click('Bind accounts…')
    await click('Bind accounts')
    expect(status()).toContain('No account made with an email address was found, so nothing was bound.')

    act(() => root.unmount())
    root = createRoot(container)
    render(vi.fn<AdminApi['bindAccountSubjects']>(async () => pass({ checked: 2, bound: 0, alreadyBound: 0 })))
    await click('Bind accounts…')
    await click('Bind accounts')
    expect(status()).toContain('None holds an InferOps connection that vouches for its own address.')
  })

  it('names how many accounts were left unbound, without naming any', async () => {
    render(vi.fn<AdminApi['bindAccountSubjects']>(async () => pass({ checked: 4, bound: 1, alreadyBound: 0, conflicts: 3 })))
    await click('Bind accounts…')
    await click('Bind accounts')
    expect(status()).toContain('3 accounts were left unbound')
  })

  it('shows a failure, and can be run again', async () => {
    const bind = vi.fn<AdminApi['bindAccountSubjects']>()
      .mockRejectedValueOnce(new Error('The InferOps gatekeeper is not configured.'))
      .mockResolvedValueOnce(pass())
    render(bind)
    await click('Bind accounts…')
    await click('Bind accounts')
    expect(container.textContent).toContain('The InferOps gatekeeper is not configured.')
    await click('Run the pass again…')
    await click('Bind accounts')
    expect(bind).toHaveBeenCalledTimes(2)
    expect(status()).toContain('Checked 3 accounts')
    expect(container.textContent).not.toContain('The pass did not finish')
  })

  it("can't be started twice while it runs", async () => {
    let finish!: (value: AccountSubjectPass) => void
    const bind = vi.fn<AdminApi['bindAccountSubjects']>(() => new Promise<AccountSubjectPass>(resolve => { finish = resolve }))
    render(bind)
    await click('Bind accounts…')
    await click('Bind accounts')
    expect(status()).toContain('Binding accounts…')
    expect(button('Bind accounts…').disabled).toBe(true)
    await act(async () => { finish(pass()) })
    expect(bind).toHaveBeenCalledOnce()
  })
})
