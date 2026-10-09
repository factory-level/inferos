// Test harness for the zero-click image egress rule: agent- or tool-originated Markdown must not
// make the operator's browser request anything until the operator clicks. jsdom loads no
// subresources itself, so the probe records every way rendered Markdown could start one instead:
// `fetch`, `new Image()`, `src`/`srcset` property writes on <img>/<source>, and `src`, `srcset`,
// `poster` or `url(...)`-bearing `style` attribute writes on any element. Not a test file itself,
// so vitest does not collect it.

import { vi } from 'vitest'

/** Elements and attributes that make a browser fetch a URL on render, with no click. */
export const EMBED_SELECTOR =
  'img, picture, source, video, audio, iframe, object, embed, link, [srcset], [poster], [style*="url("]'

export type EgressProbe = {
  /** Every URL a render tried to load, in order. */
  requests: string[]
  restore: () => void
}

function trapProperty(proto: object, property: string, requests: string[]): () => void {
  const original = Object.getOwnPropertyDescriptor(proto, property)
  Object.defineProperty(proto, property, {
    configurable: true,
    get() { return original?.get?.call(this) ?? '' },
    set(value: string) {
      requests.push(String(value))
      original?.set?.call(this, value)
    },
  })
  return () => {
    if (original) Object.defineProperty(proto, property, original)
    else delete (proto as Record<string, unknown>)[property]
  }
}

/** Starts recording render-time network requests. Call `restore()` in `afterEach`. */
export function installEgressProbe(): EgressProbe {
  const requests: string[] = []
  const restores: Array<() => void> = []

  // Stubbed by hand rather than with vi.stubGlobal, so restoring them leaves the suites' own
  // global stubs (ResizeObserver, requestAnimationFrame) in place.
  const originalFetch = globalThis.fetch
  const OriginalImage = globalThis.Image
  globalThis.fetch = vi.fn<typeof fetch>((input) => {
    requests.push(String(input))
    return Promise.reject(new Error('egress probe: fetch blocked'))
  })
  globalThis.Image = function ProbeImage(width?: number, height?: number) {
    requests.push('new Image()')
    return new OriginalImage(width, height)
  } as unknown as typeof Image
  restores.push(() => {
    globalThis.fetch = originalFetch
    globalThis.Image = OriginalImage
  })

  for (const proto of [HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
    restores.push(trapProperty(proto, 'src', requests))
    restores.push(trapProperty(proto, 'srcset', requests))
  }

  const originalSetAttribute = Element.prototype.setAttribute
  const setAttribute = vi.spyOn(Element.prototype, 'setAttribute')
  setAttribute.mockImplementation(function (this: Element, name: string, value: string) {
    const lower = name.toLowerCase()
    if (lower === 'src' || lower === 'srcset' || lower === 'poster'
        || (lower === 'style' && /url\(/i.test(value))) {
      requests.push(`${this.tagName.toLowerCase()}[${lower}]=${value}`)
    }
    originalSetAttribute.call(this, name, value)
  })

  return {
    requests,
    restore() {
      for (const restore of restores.toReversed()) restore()
      setAttribute.mockRestore()
    },
  }
}
