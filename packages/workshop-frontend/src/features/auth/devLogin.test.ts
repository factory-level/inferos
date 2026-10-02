import { afterEach, expect, it, vi } from 'vitest'
import { RpcTarget, RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { getDevLoginToken } from './devLogin'

vi.mock('../../passwordHash', () => ({ hashPassword: async () => new Uint8Array(32) }))

class LoginApi extends RpcTarget implements Pick<PublicApi, 'login' | 'createAccount'> {
  loginResult = vi.fn<PublicApi['login']>(async () => 'existing-token')
  createResult = vi.fn<PublicApi['createAccount']>(async () => 'new-token')
  login(...args: Parameters<PublicApi['login']>) { return this.loginResult(...args) }
  createAccount(...args: Parameters<PublicApi['createAccount']>) { return this.createResult(...args) }
}

afterEach(() => vi.unstubAllEnvs())

const enable = () => {
  vi.stubEnv('DEV', true)
  vi.stubEnv('VITE_DEV_AUTO_LOGIN', 'true')
  vi.stubEnv('VITE_DEV_USERNAME', 'admin')
  vi.stubEnv('VITE_DEV_PASSWORD', 'devpassword')
}

it('logs into existing accounts without requiring signup and shares concurrent setup', async () => {
  enable()
  const server = new LoginApi()
  using api = new RpcStub(server)
  expect(await Promise.all([getDevLoginToken(api), getDevLoginToken(api)])).toEqual(['existing-token', 'existing-token'])
  expect(server.loginResult).toHaveBeenCalledExactlyOnceWith('admin', expect.any(Uint8Array))
  expect(server.createResult).not.toHaveBeenCalled()
})

it('creates a missing local account through normal signup', async () => {
  enable()
  const server = new LoginApi()
  server.loginResult.mockResolvedValue(null)
  using api = new RpcStub(server)
  expect(await getDevLoginToken(api)).toBe('new-token')
  expect(server.createResult).toHaveBeenCalledWith('admin', 'admin', expect.any(Uint8Array))
})

it('does not use dev credentials in a production build', async () => {
  enable()
  vi.stubEnv('DEV', false)
  const server = new LoginApi()
  using api = new RpcStub(server)
  expect(await getDevLoginToken(api)).toBeNull()
  expect(server.loginResult).not.toHaveBeenCalled()
  expect(server.createResult).not.toHaveBeenCalled()
})
