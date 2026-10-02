import { describe, expect, it } from 'vitest'
import { hasAppViewToggle, kindOf, workspaceOutputView } from './workspaceKinds'

describe('workspaceKinds', () => {
  it('reads a workspace with no stored kind as an app', () => {
    expect(kindOf({})).toBe('app')
    expect(kindOf({ kind: 'workflow' })).toBe('workflow')
  })

  it('gives only an app the Chat ↔ App toggle', () => {
    expect(hasAppViewToggle('app')).toBe(true)
    expect(hasAppViewToggle('widget')).toBe(false)
    expect(hasAppViewToggle('workflow')).toBe(false)
  })

  it('shows triggers instead of an app preview for a workflow', () => {
    expect(workspaceOutputView('workflow')).toBe('triggers')
    expect(workspaceOutputView('app')).toBe('app')
    expect(workspaceOutputView('widget')).toBe('app')
  })
})
