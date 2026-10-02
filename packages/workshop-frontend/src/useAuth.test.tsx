// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { AUTH_ERROR_CODES, createAuthError, type PublicApi, type AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { useAuth } from './useAuth'
import { getDevLoginToken } from './features/auth/devLogin'

vi.mock('./features/auth/devLogin', () => ({ getDevLoginToken: vi.fn<typeof getDevLoginToken>(async () => null) }))

vi.mock('./errorReporting', () => ({
  setReportedUserId: vi.fn<(reportedUserId: string | undefined) => void>(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const person: AiChatAuthorInfo = { type: 'user', id: 'person@example.com', name: 'Person' }

/** A public API whose authenticated stub resolves `whoami` to `author`, or rejects without one. */
function stubPublicApi(author?: AiChatAuthorInfo, failure?: { error: Error; token?: string }): RpcStub<PublicApi> {
  const authenticated = {
    whoami: async () => {
      if (!author) throw new Error('session gone')
      return author
    },
    amIAdmin: async () => false,
    [Symbol.dispose]: () => {},
  }
  return {
    authenticate: (token: string) => failure && (!failure.token || failure.token === token) ? {
      ...authenticated, whoami: async () => { throw failure.error },
    } : authenticated,
    authenticateFromCfAccess: () => authenticated,
  } as unknown as RpcStub<PublicApi>
}

/**
 * A public API whose `whoami` stays pending until released, for the window in which an answer can
 * arrive after a logout or a newer authentication has superseded it.
 *
 * Each authentication gets its own deferred, so `release(nth, ...)` can answer an earlier lookup
 * after a later one — the ordering a shared promise could not express.
 */
function deferredPublicApi(): {
  api: RpcStub<PublicApi>
  release: (nth: number, author: AiChatAuthorInfo) => void
  reject: (nth: number, error: Error) => void
} {
  const releases: ((author: AiChatAuthorInfo) => void)[] = []
  const rejections: ((error: Error) => void)[] = []
  const authenticate = () => {
    let release: (author: AiChatAuthorInfo) => void = () => {}
    const pending = new Promise<AiChatAuthorInfo>((resolve, reject) => { release = resolve; rejections.push(reject) })
    releases.push(release)
    return { whoami: () => pending, [Symbol.dispose]: () => {} }
  }
  return {
    api: { authenticate, authenticateFromCfAccess: authenticate } as unknown as RpcStub<PublicApi>,
    release: (nth, author) => releases[nth](author),
    reject: (nth, error) => rejections[nth](error),
  }
}

type Controls = { login: (token: string) => void; logout: () => void }

describe('useAuth error reporting identity', () => {
  const roots: Root[] = []
  const containers: HTMLDivElement[] = []

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    roots.length = 0
    containers.forEach(container => container.remove())
    containers.length = 0
    localStorage.clear()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.mocked(getDevLoginToken).mockReset().mockResolvedValue(null)
  })

  /** Mounts an independent `useAuth` instance, returning its login/logout handles. */
  async function mount(
    publicApi: RpcStub<PublicApi>,
    hook: typeof useAuth = useAuth,
  ): Promise<{ controls: Controls; root: Root }> {
    const captured: { controls?: Controls } = {}
    function Consumer() {
      const { login, logout, isAuthenticated } = hook(publicApi)
      useEffect(() => { captured.controls = { login, logout } })
      return <p>{isAuthenticated ? 'Signed in' : 'Signed out'}</p>
    }

    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
    return { controls: captured.controls!, root }
  }

  it('names the user when a stored token authenticates on mount', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi(person))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user after an inline login with no provider mounted', async () => {
    // The public blueprint page renders outside AuthProvider and logs in through its own useAuth
    // instance. Attaching identity in the provider left that whole session reporting anonymously.
    const { controls } = await mount(stubPublicApi(person))
    expect(setReportedUserId).not.toHaveBeenCalled()

    await act(async () => controls.login('fresh-token'))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user when CF Access authenticates without a token', async () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    vi.resetModules()
    // Both imports must come from the reset registry, or the assertion would watch a mock instance
    // that the freshly imported hook never calls.
    const { setReportedUserId: setId } = await import('./errorReporting')
    const { useAuth: cfAccessUseAuth } = await import('./useAuth')

    await mount(stubPublicApi(person), cfAccessUseAuth)

    expect(setId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('keeps the identity when one instance unmounts while another stays mounted', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const api = stubPublicApi(person)
    await mount(api)
    const { root: inner } = await mount(api)

    // The blueprint page nests its own instance inside the root's. Clearing on unmount would let
    // navigating away from that page blank an identity the root still holds.
    act(() => inner.unmount())
    roots.splice(roots.indexOf(inner), 1)

    expect(setReportedUserId).not.toHaveBeenCalledWith(undefined)
  })

  it('clears the identity on logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls } = await mount(stubPublicApi(person))

    act(() => controls.logout())

    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup that resolves after logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)

    act(() => controls.logout())
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)

    // Disposing the stub is not a defence: capnweb does not guarantee that disposal rejects a call
    // already in flight, so a slow lookup could otherwise name a user who has just signed out.
    await act(async () => release(0, person))

    expect(setReportedUserId).not.toHaveBeenCalledWith('person@example.com')
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup superseded by a newer authentication', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)
    await act(async () => controls.login('fresh-token'))

    // The newer authentication supersedes the first lookup, so answering that one last must not let
    // it win. Only the generation distinguishes them; arrival order alone would pick the stale id.
    await act(async () => release(0, { ...person, id: 'stale@example.com' }))
    expect(setReportedUserId).not.toHaveBeenCalledWith('stale@example.com')

    await act(async () => release(1, person))
    expect(setReportedUserId).toHaveBeenLastCalledWith('person@example.com')
  })

  it('does not name a person for an author that is not a user account', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi({ type: 'agent', id: 'gpt-5.1-pro', name: 'GPT' }))

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('names nobody when the identity lookup fails', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi())

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('updates the rendered session when background dev login finishes', async () => {
    vi.mocked(getDevLoginToken).mockResolvedValue('dev-token')
    await mount(stubPublicApi(person))
    expect(localStorage.getItem('authToken')).toBe('dev-token')
    expect(document.body.textContent).toBe('Signed in')
    expect(setReportedUserId).toHaveBeenCalledWith(person.id)
  })

  it('returns to sign-in when a saved token is rejected', async () => {
    localStorage.setItem('authToken', 'expired-token')
    const api = stubPublicApi(person, { error: createAuthError(AUTH_ERROR_CODES.invalidSessionToken) })
    await mount(api)
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(document.body.textContent).toBe('Signed out')
  })

  it('replaces an expired saved session with the configured dev login', async () => {
    localStorage.setItem('authToken', 'expired-token')
    vi.mocked(getDevLoginToken).mockResolvedValue('dev-token')
    const api = stubPublicApi(person, { error: createAuthError(AUTH_ERROR_CODES.invalidSessionToken), token: 'expired-token' })
    await mount(api)
    expect(localStorage.getItem('authToken')).toBe('dev-token')
    expect(document.body.textContent).toBe('Signed in')
  })

  it('keeps a saved session during a transport failure', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const api = stubPublicApi(person, { error: new Error('Peer closed WebSocket') })
    await mount(api)
    expect(localStorage.getItem('authToken')).toBe('stored-token')
    expect(getDevLoginToken).not.toHaveBeenCalled()
  })

  it('adopts a newer saved login instead of erasing it when an older session is rejected', async () => {
    localStorage.setItem('authToken', 'expired-token')
    const { api, release, reject } = deferredPublicApi()
    await mount(api)
    localStorage.setItem('authToken', 'newer-token')
    await act(async () => reject(0, createAuthError(AUTH_ERROR_CODES.invalidSessionToken)))
    await act(async () => release(1, person))
    expect(localStorage.getItem('authToken')).toBe('newer-token')
    expect(setReportedUserId).not.toHaveBeenCalledWith(undefined)
    expect(setReportedUserId).toHaveBeenCalledWith(person.id)
  })

  it('does not let late dev login replace a manual login or a logout', async () => {
    let resolve!: (token: string) => void
    vi.mocked(getDevLoginToken).mockReturnValue(new Promise<string>(done => { resolve = done }))
    const { controls } = await mount(stubPublicApi(person))
    localStorage.setItem('authToken', 'manual-token')
    await act(async () => controls.login('manual-token'))
    await act(async () => resolve('dev-token'))
    expect(localStorage.getItem('authToken')).toBe('manual-token')
    expect(document.body.textContent).toBe('Signed in')

    vi.mocked(getDevLoginToken).mockReturnValue(new Promise<string>(done => { resolve = done }))
    localStorage.removeItem('authToken')
    const { controls: second } = await mount(stubPublicApi(person))
    act(() => second.logout())
    await act(async () => resolve('late-token'))
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(containers[1].textContent).toBe('Signed out')
  })
})
