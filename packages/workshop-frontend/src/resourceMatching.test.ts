import { describe, expect, it } from 'vitest'
import { normalizeResourceUrl } from './resourceMatching'

describe('normalizeResourceUrl', () => {
  it('defaults a scheme-less URL to https and drops a trailing wildcard', () => {
    expect(normalizeResourceUrl(' github.com/acme/* ')).toBe('https://github.com/acme')
    expect(normalizeResourceUrl('http://localhost:8080/x')).toBe('http://localhost:8080/x')
  })

  it("keeps a gatekeeper's own scheme", () => {
    expect(normalizeResourceUrl('inferops://grokbot.operations/project/board/GROK'))
      .toBe('inferops://grokbot.operations/project/board/GROK')
    expect(normalizeResourceUrl('inferops://demo.local/knowledge/wiki/*'))
      .toBe('inferops://demo.local/knowledge/wiki')
  })

  it('leaves an empty value empty', () => {
    expect(normalizeResourceUrl('   ')).toBe('')
  })
})
