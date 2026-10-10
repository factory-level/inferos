import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import {
  DEFAULT_UI_FEATURE_FLAGS,
  type UiFeatureFlagName,
  type UiFeatureFlags,
} from '@gadgets/workshop-shared/feature-flags'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'

type FeatureFlagsContextValue = {
  /**
   * The flags. While `loading` is true they may be stale: the last ones loaded for this account,
   * kept while a reconnect's replacement stub reloads them, or else the defaults.
   */
  flags: UiFeatureFlags
  loading: boolean
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null)

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { authenticatedApi, accountKey } = useAuthenticatedApi()
  const [loaded, setLoaded] = useState<{
    api: RpcStub<AuthenticatedApi>
    accountKey: object | null
    flags: UiFeatureFlags
  } | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadFlags() {
      try {
        const flags = await authenticatedApi.getUiFeatureFlags()
        if (!cancelled) {
          setLoaded({
            api: authenticatedApi,
            accountKey,
            flags: { ...DEFAULT_UI_FEATURE_FLAGS, ...flags },
          })
        }
      } catch {
        if (!cancelled) {
          setLoaded({ api: authenticatedApi, accountKey, flags: { ...DEFAULT_UI_FEATURE_FLAGS } })
        }
      }
    }
    void loadFlags()

    return () => { cancelled = true }
  }, [authenticatedApi, accountKey])

  // A replacement stub for the same account (a reconnect re-authenticates on the new socket with
  // the same token) keeps the flags last loaded until its own answer arrives. Falling back to the
  // defaults meanwhile would switch every flag-gated surface off and on again, remounting it and
  // dropping its state, such as an open host-board dialog under the Operate shell. Any other
  // replacement, or one whose account is unknown, gets the defaults at once: they unmount what the
  // previous account's flags enabled, so nothing of that account stays on screen.
  const current = loaded?.api === authenticatedApi
  const sameAccount = !!loaded && accountKey != null && loaded.accountKey === accountKey
  const value = loaded && (current || sameAccount)
    ? { flags: loaded.flags, loading: !current }
    : { flags: DEFAULT_UI_FEATURE_FLAGS, loading: true }

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>
}

export function useUiFeatureFlags() {
  const context = useContext(FeatureFlagsContext)
  if (!context) {
    throw new Error('useUiFeatureFlags must be used within FeatureFlagsProvider')
  }
  return context
}

export function useUiFeatureFlag(name: UiFeatureFlagName) {
  const { flags, loading } = useUiFeatureFlags()
  return { enabled: flags[name], loading }
}
