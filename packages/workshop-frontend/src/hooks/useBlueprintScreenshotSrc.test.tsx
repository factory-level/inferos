// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useBlueprintScreenshotSrc } from './useBlueprintScreenshotSrc'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const URL_PUBLIC = '/blueprint-screenshot/bp?v=1'
const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:screenshot')
const revokeObjectURL = vi.fn<(url: string) => void>()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const Probe = ({ api, url }: { api: RpcStub<AuthenticatedApi> | null; url?: string }) =>
  <span>{useBlueprintScreenshotSrc(api, 'bp', url) ?? 'placeholder'}</span>

const apiWith = (getBlueprintScreenshot: AuthenticatedApi['getBlueprintScreenshot']) =>
  ({ getBlueprintScreenshot }) as unknown as RpcStub<AuthenticatedApi>

describe('useBlueprintScreenshotSrc', () => {
  it('uses the public route when signed out, and nothing when there is no screenshot', async () => {
    await act(async () => root.render(<Probe api={null} url={URL_PUBLIC} />))
    expect(container.textContent).toBe(URL_PUBLIC)
    await act(async () => root.render(<Probe api={null} />))
    expect(container.textContent).toBe('placeholder')
  })

  it('reads the bytes over RPC when signed in, and revokes the blob URL on unmount', async () => {
    const read = vi.fn<AuthenticatedApi['getBlueprintScreenshot']>(async () =>
      ({ mimeType: 'image/png', content: new Uint8Array([1, 2]) }))
    await act(async () => root.render(<Probe api={apiWith(read)} url={URL_PUBLIC} />))

    expect(read).toHaveBeenCalledWith('bp')
    expect(container.textContent).toBe('blob:screenshot')
    expect(createObjectURL.mock.calls[0]![0].type).toBe('image/png')

    await act(async () => root.render(<Probe api={apiWith(read)} />))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:screenshot')
    expect(container.textContent).toBe('placeholder')
  })

  it('falls back to the placeholder when the read fails or finds nothing', async () => {
    await act(async () => root.render(<Probe api={apiWith(async () => { throw new Error('gone') })} url={URL_PUBLIC} />))
    expect(container.textContent).toBe('placeholder')
    await act(async () => root.render(<Probe api={apiWith(async () => null)} url={`${URL_PUBLIC}2`} />))
    expect(container.textContent).toBe('placeholder')
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
