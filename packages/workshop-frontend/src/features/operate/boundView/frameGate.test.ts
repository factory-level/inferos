// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { FRAME_ELEMENTS, findFrames, watchFrames, type FrameWatch } from './frameGate'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const host = (parent: ParentNode = document.body) => {
  const element = document.createElement('div')
  parent.append(element)
  return element.attachShadow({ mode: 'open' })
}

let watch: FrameWatch | null = null
afterEach(() => { watch?.dispose(); watch = null; document.body.replaceChildren() })

describe('findFrames', () => {
  it.each(FRAME_ELEMENTS)('counts a %s in the document', tag => {
    expect(findFrames(document).count).toBe(0)
    document.body.append(document.createElement(tag))
    expect(findFrames(document).count).toBe(1)
  })

  it('searches open shadow roots recursively', () => {
    const outer = host()
    const inner = host(outer)
    inner.append(document.createElement('embed'))
    outer.append(document.createElement('object'))
    const found = findFrames(document)
    expect(found.count).toBe(2)
    expect(found.roots).toEqual([outer, inner])
  })
})

describe('watchFrames', () => {
  it('re-searches on document mutations and resumes once the frame is gone', async () => {
    const results: boolean[] = []
    watch = watchFrames(document, clear => results.push(clear))
    expect(watch.check()).toBe(true)
    const frame = document.createElement('iframe')
    document.body.append(frame)
    await flush()
    expect(results.at(-1)).toBe(false)
    frame.remove()
    await flush()
    expect(results.at(-1)).toBe(true)
  })

  it('sees an iframe inserted into a shadow root that already existed, which the document observer cannot', async () => {
    const shadow = host()
    const results: boolean[] = []
    watch = watchFrames(document, clear => results.push(clear))
    expect(watch.check()).toBe(true)
    shadow.append(document.createElement('iframe'))
    await flush()
    expect(results.at(-1)).toBe(false)
    shadow.replaceChildren()
    await flush()
    expect(results.at(-1)).toBe(true)
  })

  it('watches a shadow root created after the watch started, from the next search', async () => {
    const results: boolean[] = []
    watch = watchFrames(document, clear => results.push(clear))
    const shadow = host()
    await flush()
    shadow.append(document.createElement('fencedframe'))
    await flush()
    expect(results.at(-1)).toBe(false)
  })

  it('reports nothing once disposed, and contains a throwing callback', async () => {
    const results: boolean[] = []
    watch = watchFrames(document, clear => { results.push(clear); throw new Error('callback') })
    document.body.append(document.createElement('iframe'))
    await flush()
    expect(results).toEqual([false])
    watch.dispose()
    document.body.replaceChildren()
    await flush()
    expect(results).toEqual([false])
  })
})
