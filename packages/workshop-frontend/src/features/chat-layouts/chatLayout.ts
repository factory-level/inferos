import type { UiFeatureFlagName, UiFeatureFlags } from '@gadgets/workshop-shared/feature-flags'
import { useUiFeatureFlags } from '../../FeatureFlagsContext'

/** Which Home layout to show. `default` is the plain chat launcher. */
export type ChatLayout = 'default' | 'dashboard' | 'thread' | 'copilot'

// Order is precedence: when several layout flags are on for a user, the first one wins, so a
// misconfigured rollout still renders exactly one layout.
const FLAGGED_LAYOUTS: readonly (readonly [UiFeatureFlagName, Exclude<ChatLayout, 'default'>])[] = [
  ['chat-layout-dashboard', 'dashboard'],
  ['chat-layout-thread', 'thread'],
  ['chat-layout-copilot', 'copilot'],
]

export const resolveChatLayout = (flags: UiFeatureFlags): ChatLayout =>
  FLAGGED_LAYOUTS.find(([flag]) => flags[flag])?.[1] ?? 'default'

/** The Home layout for the signed-in user; `default` until their flags have loaded. */
export const useChatLayout = (): ChatLayout => resolveChatLayout(useUiFeatureFlags().flags)
