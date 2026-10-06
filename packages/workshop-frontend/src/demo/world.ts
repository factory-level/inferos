// The shared fixture world every demo area reads: who is signed in, deployment config, flags and
// the user's workspaces. Built fresh on every page load, then adjusted by the selected scenario.
// Data only one area uses lives in that area's module instead.

import type {
  AiChatAuthorInfo,
  GadgetMetadataWithTimestamps,
  ServerConfig,
} from '@gadgets/workshop-shared/api'
import { DEFAULT_SITE_NAME } from '@gadgets/workshop-shared/api'
import { DEV_UI_FEATURE_FLAGS, type UiFeatureFlags } from '@gadgets/workshop-shared/feature-flags'

export interface DemoWorld {
  /** Signed in at boot; scenarios for signed-out screens set this false. */
  signedIn: boolean
  user: AiChatAuthorInfo
  isAdmin: boolean
  onboardingCompleted: boolean
  serverConfig: ServerConfig
  featureFlags: UiFeatureFlags
  /** The signed-in user's workspaces, most recently active first. */
  workspaces: GadgetMetadataWithTimestamps[]
  /** Route params used to open a view's route when a scenario names no path. */
  defaultParams: Record<string, string>
}

const now = Date.now()
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000)

function createWorld(): DemoWorld {
  return {
    signedIn: true,
    user: { type: 'user', id: 'demo', name: 'Dana Demo', commitEmail: 'dana@example.com' },
    isAdmin: true,
    onboardingCompleted: true,
    serverConfig: {
      authVendors: [],
      passwordAuthEnabled: true,
      cloudflareLimitsEnabled: false,
      signupsEnabled: true,
      userSearchEnabled: true,
      siteName: DEFAULT_SITE_NAME,
      announcement: '',
      banner: '',
      bannerColor: 'info',
      accentColor: '',
      canvasFeatures: { composableViews: true, durableViews: true },
    },
    featureFlags: { ...DEV_UI_FEATURE_FLAGS, 'openai-chatgpt-plan-usage': true },
    workspaces: [
      { id: 'ws-ops', title: 'Ops dashboard', defaultGadgetId: 0, pinned: true, role: 'build',
        created: minutesAgo(60 * 24 * 9), lastActive: minutesAgo(12) },
      { id: 'ws-triage', title: 'Issue triage', defaultGadgetId: 0, role: 'build',
        created: minutesAgo(60 * 24 * 4), lastActive: minutesAgo(90) },
      { id: 'ws-notes', title: 'Meeting notes', defaultGadgetId: 0, role: 'build',
        created: minutesAgo(60 * 24 * 30), lastActive: minutesAgo(60 * 26) },
      { id: 'ws-shared', title: 'Launch checklist', defaultGadgetId: 0, role: 'use',
        owner: { type: 'user', id: 'sam', name: 'Sam Rivera' },
        created: minutesAgo(60 * 24 * 2), lastActive: minutesAgo(60 * 5) },
    ],
    defaultParams: { id: 'ws-ops', appId: 'context' },
  }
}

/** The world for this page load. Mutated by the scenario's `setup` before the app renders. */
export const world: DemoWorld = createWorld()
