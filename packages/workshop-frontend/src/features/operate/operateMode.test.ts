import { afterEach, describe, expect, it } from 'vitest'
import { buildReturnHref, modeForPath, rememberBuildLocation, resetBuildLocationForTests } from './operateMode'

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

describe('Build return location', () => {
  afterEach(resetBuildLocationForTests)

  it('falls back to Home before any Build location is seen', () => {
    expect(buildReturnHref()).toBe('/')
  })

  it('returns to the last Build location, ignoring Operate locations', () => {
    rememberBuildLocation('/workspaces', '/workspaces?sort=recent')
    rememberBuildLocation('/inferops-canvas', '/inferops-canvas')
    rememberBuildLocation('/workspace/w1/inferops-canvas', '/workspace/w1/inferops-canvas?view=s1')
    expect(buildReturnHref()).toBe('/workspaces?sort=recent')
  })
})
