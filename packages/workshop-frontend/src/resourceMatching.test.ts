import { describe, expect, it } from 'vitest'
import { normalizeResourceUrl } from './resourceMatching'

describe('normalizeResourceUrl', () => {
  it('prepends https:// to a URL without a scheme', () => {
    expect(normalizeResourceUrl(' docs.google.com/document/d/x ')).toBe('https://docs.google.com/document/d/x')
  })

  it('keeps an http(s) scheme and strips a trailing wildcard', () => {
    expect(normalizeResourceUrl('http://localhost:8787/x/*')).toBe('http://localhost:8787/x')
    expect(normalizeResourceUrl('HTTPS://example.com')).toBe('HTTPS://example.com')
  })

  it('keeps a custom scheme such as inferops://', () => {
    expect(normalizeResourceUrl('inferops://grokbot.operations/project/board/GROK'))
      .toBe('inferops://grokbot.operations/project/board/GROK')
  })
})
