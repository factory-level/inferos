// Core demo fixtures: connection, sign-in and the account basics every screen needs.

import { provide, demoTarget } from '../registry'
import { world } from '../world'

export const DEMO_TOKEN = 'demo-token'

const signIn = () => {
  if (!world.signedIn) throw new Error('Demo: signed out')
  return demoTarget('AuthenticatedApi')
}

provide('PublicApi', {
  ping() {},
  getServerConfig: () => world.serverConfig,
  authenticate: signIn,
  authenticateFromCfAccess: signIn,
  login: () => DEMO_TOKEN,
  createAccount: () => DEMO_TOKEN,
})

provide('AuthenticatedApi', {
  whoami: () => world.user,
  amIAdmin: () => world.isAdmin,
  getAdminApi: () => (world.isAdmin ? demoTarget('AdminApi') : null),
  isOnboardingCompleted: () => world.onboardingCompleted,
  completeOnboarding() { world.onboardingCompleted = true },
  getUiFeatureFlags: () => world.featureFlags,
  listGadgets: () => world.workspaces,
  getAvatar: () => null,
  hasPasswordLogin: () => true,
})
