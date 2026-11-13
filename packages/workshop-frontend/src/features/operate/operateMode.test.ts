import { afterEach, describe, expect, it } from 'vitest'
import { buildReturnHref, modeForPath, operateReturnHref, rememberLocation, resetReturnLocationsForTests } from './operateMode'

describe('modeForPath', () => {
  it('puts the InferOps Canvas routes in Operate', () => {
    expect(modeForPath('/inferops-canvas')).toBe('operate')
    expect(modeForPath('/inferops-canvas/')).toBe('operate')
    expect(modeForPath('/workspace/abc123/inferops-canvas')).toBe('operate')
  })

  it('puts every other route in Build', () => {
    for (const path of ['/', '/workspaces', '/blueprints', '/outputs', '/explore', '/workspace/abc123',
      '/workspace/abc123/chat/1', '/gatekeepers/context', '/inferops-canvas-old', '/workspace/a/b/inferops-canvas']) {
      expect(modeForPath(path)).toBe('build')
    }
  })
})

describe('return locations', () => {
  afterEach(resetReturnLocationsForTests)

  it('falls back to each mode\'s home before any location is seen', () => {
    expect(buildReturnHref()).toBe('/')
    expect(buildReturnHref('/inferops-canvas')).toBe('/')
    expect(operateReturnHref()).toBe('/inferops-canvas')
  })

  it('returns a workspace canvas to its workspace when no Build location was seen', () => {
    expect(buildReturnHref('/workspace/w1/inferops-canvas')).toBe('/workspace/w1')
    rememberLocation('/workspaces', '/workspaces?sort=recent')
    expect(buildReturnHref('/workspace/w1/inferops-canvas')).toBe('/workspaces?sort=recent')
  })

  it('remembers the last location of each mode separately', () => {
    rememberLocation('/workspaces', '/workspaces?sort=recent')
    rememberLocation('/inferops-canvas', '/inferops-canvas')
    rememberLocation('/workspace/w1/inferops-canvas', '/workspace/w1/inferops-canvas?view=s1')
    expect(buildReturnHref()).toBe('/workspaces?sort=recent')
    expect(operateReturnHref()).toBe('/workspace/w1/inferops-canvas?view=s1')
    rememberLocation('/blueprints', '/blueprints')
    expect(operateReturnHref()).toBe('/workspace/w1/inferops-canvas?view=s1')
  })
})
