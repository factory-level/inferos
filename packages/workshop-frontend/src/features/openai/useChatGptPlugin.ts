import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { OpenAiAssistantPluginApi, OpenAiPluginState } from '@gadgets/workshop-shared/openai-plugin'

type Connection = {
  owner: RpcStub<AuthenticatedApi>
  api: RpcStub<OpenAiAssistantPluginApi> | null
  state: OpenAiPluginState | null
  status: 'loading' | 'disabled' | 'ready' | 'error'
  error: string | null
  refresh: () => Promise<void>
}

/** Own the capability, refresh after actions, and poll changes completed in a disowned popup. */
export const useChatGptPlugin = (authenticatedApi: RpcStub<AuthenticatedApi>) => {
  const [connection, setConnection] = useState<Connection | null>(null)
  useEffect(() => {
    let disposed = false
    let api: RpcStub<OpenAiAssistantPluginApi> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let revision = 0
    const refresh = async () => {
      const request = ++revision
      clearTimeout(timer)
      try {
        if (!api) {
          const acquired = await authenticatedApi.getOpenAiAssistantPlugin()
          if (disposed || request !== revision) { acquired?.[Symbol.dispose](); return }
          api = acquired
          if (!api) {
            setConnection({ owner: authenticatedApi, api: null, state: null, status: 'disabled', error: null, refresh })
            return
          }
        }
        const state = await api.getState()
        if (!disposed && request === revision) {
          setConnection({ owner: authenticatedApi, api, state, status: 'ready', error: null, refresh })
        }
      } catch {
        if (!disposed && request === revision) {
          setConnection(previous => ({
            owner: authenticatedApi, api,
            state: previous?.owner === authenticatedApi ? previous.state : null,
            status: 'error', error: api ? 'The local ChatGPT companion is unavailable.' : 'Could not load the ChatGPT connection.',
            refresh,
          }))
        }
      }
      if (!disposed && request === revision) timer = setTimeout(() => void refresh(), 3000)
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer); api?.[Symbol.dispose]() }
  }, [authenticatedApi])
  return connection?.owner === authenticatedApi ? connection : {
    api: null, state: null, status: 'loading' as const, error: null, refresh: async () => {},
  }
}
