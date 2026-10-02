import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_FEATURE_FLAGS, type UiFeatureFlags } from '@gadgets/workshop-shared/feature-flags'
import { resolveChatLayout } from './chatLayout'

const flags = (on: Partial<UiFeatureFlags>): UiFeatureFlags => ({ ...DEFAULT_UI_FEATURE_FLAGS, ...on })

describe('resolveChatLayout', () => {
  it('shows the plain chat launcher when no layout flag is on', () => {
    expect(resolveChatLayout(flags({}))).toBe('default')
  })

  it('maps each flag to its layout', () => {
    expect(resolveChatLayout(flags({ 'chat-layout-dashboard': true }))).toBe('dashboard')
    expect(resolveChatLayout(flags({ 'chat-layout-thread': true }))).toBe('thread')
    expect(resolveChatLayout(flags({ 'chat-layout-copilot': true }))).toBe('copilot')
  })

  it('picks exactly one layout when several flags are on', () => {
    expect(resolveChatLayout(flags({ 'chat-layout-thread': true, 'chat-layout-copilot': true }))).toBe('thread')
    expect(resolveChatLayout(flags({
      'chat-layout-dashboard': true,
      'chat-layout-thread': true,
      'chat-layout-copilot': true,
    }))).toBe('dashboard')
  })
})
