// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, type RpcStub } from 'capnweb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthoredWidgetPreview as PreviewResult } from '@gadgets/workshop-shared/api'
import { AuthoredWidgetPreview, type PreviewOverseer } from './AuthoredWidgetPreview'

let container: HTMLDivElement
let root: Root
const sessions: RpcStub<Record<string, (...args: unknown[]) => Promise<unknown>>>[] = []

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]()
  await act(async () => root.unmount())
  container.remove(); vi.unstubAllGlobals()
})

const built = (jsCode = 'document.body.textContent = "authored"'): PreviewResult =>
  ({ jsCode, measurements: { durationMs: 412, clientBytes: 2048 } })

// Only the preview method: the component is never handed anything that could change the workspace.
const overseerWith = (preview: PreviewOverseer['previewAuthoredWidget']) => ({ previewAuthoredWidget: vi.fn<PreviewOverseer['previewAuthoredWidget']>(preview) })

const render = async (overseer: PreviewOverseer, chatId: number | undefined, reloadTrigger = 0) => {
  await act(async () => root.render(
    <AuthoredWidgetPreview overseer={overseer} gadgetId={7} chatId={chatId} reloadTrigger={reloadTrigger} />))
}
const frame = () => container.querySelector('iframe')
const text = () => container.textContent ?? ''
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)
const handshake = () => {
  const { port1, port2 } = new MessageChannel()
  const child = newMessagePortRpcSession<Record<string, (...args: unknown[]) => Promise<unknown>>>(port1)
  sessions.push(child)
  window.dispatchEvent(new MessageEvent('message', { data: 'handshake', origin: 'null', source: frame()!.contentWindow, ports: [port2] }))
  return child
}

it('builds the chat\'s draft on the server and runs it in the sandboxed Gadget frame', async () => {
  const overseer = overseerWith(async () => built())
  await render(overseer, 3)
  await vi.waitFor(() => expect(frame()).not.toBeNull())
  expect(overseer.previewAuthoredWidget).toHaveBeenCalledWith(7, 3)
  expect(frame()!.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox')
  expect(frame()!.srcdoc).toContain("connect-src 'none'")
  expect(frame()!.srcdoc).toContain(encodeURIComponent('document.body.textContent = "authored"'))
  expect(text()).toContain('Built in 412 ms · 2.0 KB')
})

it('says there is nothing to preview without a chat draft, and builds nothing', async () => {
  const overseer = overseerWith(async () => built())
  await render(overseer, undefined)
  expect(text()).toContain('Nothing to preview yet')
  expect(overseer.previewAuthoredWidget).not.toHaveBeenCalled()
  expect(frame()).toBeNull()
})

it('shows that the build is running until the server answers', async () => {
  let finish!: (value: PreviewResult) => void
  await render(overseerWith(() => new Promise(resolve => { finish = resolve })), 3)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Building the preview')
  expect(frame()).toBeNull()
  await act(async () => finish(built()))
  await vi.waitFor(() => expect(frame()).not.toBeNull())
})

it('shows a build refusal in the server\'s words and never a frame, then builds again on request', async () => {
  const overseer = overseerWith(async () => { throw new Error('Invalid source path.') })
  await render(overseer, 3)
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Invalid source path.'))
  expect(frame()).toBeNull()
  overseer.previewAuthoredWidget.mockImplementation(async () => built())
  await act(async () => button('Try again')!.click())
  await vi.waitFor(() => expect(frame()).not.toBeNull())
  expect(overseer.previewAuthoredWidget).toHaveBeenCalledTimes(2)
})

it('says the viewer may not build a preview, without offering a retry', async () => {
  await render(overseerWith(async () => {
    throw new Error("Unauthorized: this collaborator only has permission to use the gadget's UI.")
  }), 3)
  await vi.waitFor(() => expect(text()).toContain('You can\'t build a preview'))
  expect(text()).toContain("this collaborator only has permission to use the gadget's UI.")
  expect(button('Try again')).toBeUndefined()
  expect(frame()).toBeNull()
})

it('connects the frame to mock bindings only: its calls are listed and change nothing', async () => {
  await render(overseerWith(async () => built()), 3)
  await vi.waitFor(() => expect(frame()).not.toBeNull())
  const gadget = handshake()
  await expect(gadget.saveRecord('fictional-1')).resolves.toBeUndefined()
  await expect(gadget.listRecords()).resolves.toBeUndefined()
  await vi.waitFor(() => expect([...container.querySelectorAll('[aria-label="Calls from the preview"] li')]
    .map(item => item.textContent)).toEqual(['saveRecord', 'listRecords']))
  expect(text()).toContain('change nothing')
})

it('builds again after a code change, and drops the old build\'s calls', async () => {
  const overseer = overseerWith(async () => built())
  await render(overseer, 3)
  await vi.waitFor(() => expect(frame()).not.toBeNull())
  const gadget = handshake()
  await gadget.saveRecord('fictional-1')
  await vi.waitFor(() => expect(container.querySelectorAll('[aria-label="Calls from the preview"] li')).toHaveLength(1))
  overseer.previewAuthoredWidget.mockImplementation(async () => built('document.body.textContent = "changed"'))
  await render(overseer, 3, 1)
  await vi.waitFor(() => expect(frame()!.srcdoc).toContain(encodeURIComponent('"changed"')))
  expect(overseer.previewAuthoredWidget).toHaveBeenCalledTimes(2)
  expect(container.querySelectorAll('[aria-label="Calls from the preview"] li')).toHaveLength(0)
})

it('ignores a late answer for a draft it no longer shows', async () => {
  const answers: ((value: PreviewResult) => void)[] = []
  const overseer = overseerWith(() => new Promise(resolve => { answers.push(resolve) }))
  await render(overseer, 3)
  await render(overseer, 4)
  await act(async () => answers[1]!(built('document.body.textContent = "chat four"')))
  await act(async () => answers[0]!(built('document.body.textContent = "chat three"')))
  await vi.waitFor(() => expect(frame()!.srcdoc).toContain(encodeURIComponent('"chat four"')))
  expect(frame()!.srcdoc).not.toContain(encodeURIComponent('"chat three"'))
})
