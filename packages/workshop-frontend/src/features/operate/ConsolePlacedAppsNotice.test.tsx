// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GadgetSummary, WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { ConsolePlacedAppsNotice } from './ConsolePlacedAppsNotice'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const gadget = (id: WorkpieceId, title: string, commitId: string, extra: Partial<GadgetSummary> = {}): GadgetSummary =>
  ({ id, type: 'gadget', title, commitId, ...extra })
const pieces = (...gadgets: GadgetSummary[]): Map<WorkpieceId, WorkpieceSummary> => new Map(gadgets.map(piece => [piece.id, piece]))
const APPS = [{ gadgetId: 3, commitId: 'c1' }, { gadgetId: 4, commitId: 'c7' }]
it('names each app whose head moved since the console was published, and the console to publish again', async () => {
  await act(async () => root.render(<ConsolePlacedAppsNotice published={{ apps: APPS }} placed={null} consoleTitle="Floor"
    workpieces={pieces(gadget(3, 'Counter', 'c2'), gadget(4, 'Notes', 'c7'))} />))
  expect(container.textContent).toContain("Operators can't open Counter until you publish Floor again")
  expect(container.textContent).not.toContain('Notes')
})

it('says nothing while every app is at its published commit, before the gadgets load, or for an unpublished console', async () => {
  await act(async () => root.render(<ConsolePlacedAppsNotice published={{ apps: APPS }} placed={null} consoleTitle="Floor"
    workpieces={pieces(gadget(3, 'Counter', 'c1'), gadget(4, 'Notes', 'c7'))} />))
  expect(container.textContent).toBe('')
  await act(async () => root.render(<ConsolePlacedAppsNotice published={{ apps: APPS }} placed={null} consoleTitle="Floor" workpieces={pieces()} />))
  expect(container.textContent).toBe('')
  await act(async () => root.render(<ConsolePlacedAppsNotice published={null} placed={null} consoleTitle="Floor"
    workpieces={pieces(gadget(3, 'Counter', 'c2'))} />))
  expect(container.textContent).toBe('')
})

it('counts an app no longer in the workspace as one operators can\'t open', async () => {
  await act(async () => root.render(<ConsolePlacedAppsNotice published={{ apps: APPS }} placed={null} consoleTitle="Floor"
    workpieces={pieces(gadget(4, 'Notes', 'c7'))} />))
  expect(container.textContent).toContain("Operators can't open app 3 until you publish Floor again")
})

it('asks for a republish of every app a console published before apps were fenced places on its published pages, and of no widget', async () => {
  const frozenFor = { consoleId: 'floor', revision: '4', sourceGadgetId: 2 }
  await act(async () => root.render(<ConsolePlacedAppsNotice published={{}} placed={[3, 9, 3]} consoleTitle="Floor"
    workpieces={pieces(gadget(3, 'Counter', 'c1'), gadget(9, 'Status', 'c9', { frozenFor }))} />))
  expect(container.textContent).toContain("Operators can't open Counter until you publish Floor again")
  expect(container.textContent).toContain('published before')
  expect(container.textContent).not.toContain('Status')
})
