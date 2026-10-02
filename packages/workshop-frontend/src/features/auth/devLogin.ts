import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { hashPassword } from '../../passwordHash'

type LoginApi = Pick<RpcStub<PublicApi>, 'login' | 'createAccount'>
const pending = new WeakMap<LoginApi, Promise<string | null>>()

/** Share local account setup across mounted auth consumers without caching session tokens. */
export const getDevLoginToken = (api: LoginApi): Promise<string | null> => {
  if (!import.meta.env.DEV || import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return Promise.resolve(null)
  const existing = pending.get(api)
  if (existing) return existing
  const login = async () => {
    const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
    const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'
    const hash = await hashPassword(username, password)
    // Existing accounts can log in even when new signups are disabled.
    return await api.login(username, hash) ?? await api.createAccount(username, username, hash)
  }
  const result = login().finally(() => pending.delete(api))
  pending.set(api, result)
  return result
}
