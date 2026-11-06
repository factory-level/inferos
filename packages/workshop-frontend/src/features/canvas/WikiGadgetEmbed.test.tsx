// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EmbeddedConsoleWidget } from '@gadgets/workshop-shared/operate-console'
import { embedViewerKey, WikiGadgetEmbed } from './WikiGadgetEmbed'
import { parseWikiReference, type WikiReference } from './wikiPage'

// FAC-12: a published console's widget embedded in a Wiki page, in each of its states. The kernel
// is a stand-in: `openGadget` gives the console workspace with the person's own access, which
// resolves the link and opens the widget; GadgetUI only records the capability it was given.
const shownWith = vi.fn<(gadget: unknown) => void>()
vi.mock('../../GadgetUI', () => ({ default: ({ gadget }: { gadget: unknown }) => { shownWith(gadget); return <p>frame</p> } }))
let auth: { authenticatedApi: { openGadget: (id: string) => unknown }; accountKey?: object } | null = null
vi.mock('../../AuthContext', () => ({ useOptionalAuthenticatedApi: () => auth }))

const HREF = 'inferops://acme.kb/knowledge/inferos-widget/ws-7/floor/41?blueprint="bp"&version="1"'
const reference = parseWikiReference(HREF) as Extract<WikiReference, { kind: 'gadget' }>
const AVAILABLE: EmbeddedConsoleWidget = { status: 'available', consoleId: 'floor', revision: '4', gadgetId: 101, label: 'Counter', blueprintId: 'bp', version: 1 }

let root: Root
let container: HTMLDivElement
const disposed: string[] = []
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

/** A kernel whose workspace resolves to `resolved`; `opens` says how getEmbeddedWidget answers. */
function kernel(resolved: EmbeddedConsoleWidget | Error, opens: 'ok' | 'refused' = 'ok') {
  let broken: (() => void) | undefined
  const stub = {
    getId: async () => { if (opens === 'refused') throw new Error('Console floor has changed since it was opened.'); return 101 },
    onRpcBroken: (callback: () => void) => { broken = callback },
    [Symbol.dispose]: () => disposed.push('widget'),
  }
  const workspace = {
    resolveEmbeddedWidget: vi.fn<(consoleId: string, sourceGadgetId: number) => Promise<EmbeddedConsoleWidget>>(async () => { if (resolved instanceof Error) throw resolved; return resolved }),
    getEmbeddedWidget: vi.fn<(consoleId: string, revision: string, gadgetId: number) => typeof stub>(() => stub),
    [Symbol.dispose]: () => disposed.push('workspace'),
  }
  const openGadget = vi.fn<(id: string) => typeof workspace>(() => workspace)
  auth = { authenticatedApi: { openGadget }, accountKey: {} }
  return { openGadget, workspace, stub, breakIt: () => broken?.() }
}

const render = async (ref = reference) => {
  await act(async () => root.render(<WikiGadgetEmbed reference={ref} label="Finder" />))
  await settle()
}
const text = () => container.textContent ?? ''

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  shownWith.mockClear(); disposed.length = 0; auth = null
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('runs the console’s current frozen install, opened through that workspace with the person’s own access', async () => {
  const k = kernel(AVAILABLE)
  await render()
  expect(k.openGadget).toHaveBeenCalledWith('ws-7')
  expect(k.workspace.resolveEmbeddedWidget).toHaveBeenCalledWith('floor', 41)
  expect(k.workspace.getEmbeddedWidget).toHaveBeenCalledWith('floor', '4', 101)
  expect(shownWith).toHaveBeenLastCalledWith(k.stub)
  expect(text()).toContain('Counter')
  expect(text()).not.toContain('Updated since it was placed')
  await act(async () => root.unmount())
  expect(disposed.toSorted()).toEqual(['widget', 'workspace'])
  root = createRoot(container)
})

it('says a newer publication runs another version than the link was written for, and still shows it', async () => {
  kernel({ ...AVAILABLE, version: 2 })
  await render()
  expect(text()).toContain('Updated since it was placed')
  expect(shownWith).toHaveBeenCalled()
})

it('shows nothing of the widget to someone who can’t open its workspace, or who isn’t signed in', async () => {
  kernel(new Error('Unauthorized'))
  await render()
  expect(text()).toContain('in a workspace you can’t open')
  expect(shownWith).not.toHaveBeenCalled()
  auth = null
  await act(async () => root.render(<WikiGadgetEmbed reference={{ ...reference, consoleId: 'other' }} label="Finder" />))
  await settle()
  expect(text()).toContain('in a workspace you can’t open')
  expect(shownWith).not.toHaveBeenCalled()
})

it('says why it’s unavailable, in the kernel’s fixed reasons', async () => {
  for (const [reason, words] of [
    ['not-published', 'Its console is not published'],
    ['not-offered', 'no longer offers this widget'],
    ['no-ui', 'has no UI to show here'],
  ] as const) {
    kernel({ status: 'unavailable', reason })
    await render({ ...reference, consoleId: reason })
    expect(text()).toContain(words)
  }
  expect(shownWith).not.toHaveBeenCalled()
})

it('reports a refused open as an error, never an empty frame, and checks again on request', async () => {
  const k = kernel(AVAILABLE, 'refused')
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('has changed since it was opened')
  expect(shownWith).not.toHaveBeenCalled()
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Check again')!.click())
  await settle()
  expect(k.workspace.resolveEmbeddedWidget).toHaveBeenCalledTimes(2)
})

it('reads as revoked once the shown capability breaks', async () => {
  const k = kernel(AVAILABLE)
  await render()
  expect(text()).toContain('frame')
  await act(async () => k.breakIt())
  expect(text()).toContain('no longer available to you here')
  expect(text()).not.toContain('frame')
})

// r2 round 1 on #392: the shown widget belongs to the reference it was resolved for. When the
// embed's target changes, the old widget is never rendered again, not even for one commit.
it('never renders the previous widget once the embed names another one', async () => {
  const shown = kernel(AVAILABLE)
  await render()
  expect(shownWith).toHaveBeenLastCalledWith(shown.stub)
  // The next target is one this person can't open.
  const refused = kernel(new Error('Unauthorized'))
  shownWith.mockClear()
  await act(async () => root.render(<WikiGadgetEmbed reference={{ ...reference, consoleId: 'secret', href: `${HREF}#secret` }} label="Finder" />))
  await settle()
  expect(shownWith).not.toHaveBeenCalled()
  expect(refused.openGadget).toHaveBeenCalledWith('ws-7')
  expect(text()).toContain('in a workspace you can’t open')
})

// r1 round 1 on #392: a failed resolve, which may be transient, can be checked again.
it('offers to check again where it can’t open the workspace', async () => {
  const k = kernel(new Error('Network down'))
  await render()
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Check again')!.click())
  await settle()
  expect(k.workspace.resolveEmbeddedWidget).toHaveBeenCalledTimes(2)
})

// r2 round 2 on #392: the shown widget also belongs to the viewer it was resolved for. When the
// signed-in account changes on the same mounted page, the previous viewer's widget never renders.
it('never renders the previous viewer’s widget once another account is signed in', async () => {
  const viewerA = kernel(AVAILABLE)
  await render()
  expect(shownWith).toHaveBeenLastCalledWith(viewerA.stub)
  // Viewer B, who can't open the workspace, on the same page and the same embed.
  const viewerB = kernel(new Error('Unauthorized'))
  shownWith.mockClear()
  await render()
  expect(shownWith).not.toHaveBeenCalled()
  expect(viewerB.openGadget).toHaveBeenCalledWith('ws-7')
  expect(text()).toContain('in a workspace you can’t open')
})

it('keys each signed-in account apart, and the same account the same way', () => {
  const a = {}, b = {}
  expect(embedViewerKey(a)).toBe(embedViewerKey(a))
  expect(embedViewerKey(a)).not.toBe(embedViewerKey(b))
  expect(embedViewerKey(null)).toBe('anonymous')
})
