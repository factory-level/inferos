// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { CanvasProjectBoardWidget, CanvasWidget, CanvasWikiWidget } from '@gadgets/workshop-shared/canvas'
import { CanvasDataBindingEditor } from './CanvasDataBindingEditor'

const { boardState, wikiState, useBoardData, useWikiData } = vi.hoisted(() => ({
  boardState: { status: 'ready' as string, code: '' },
  wikiState: { status: 'ready' as string, code: '' },
  useBoardData: vi.fn<(...args: unknown[]) => void>(),
  useWikiData: vi.fn<(...args: unknown[]) => void>(),
}))

vi.mock('./useBoardData', () => ({ useBoardData: (...args: unknown[]) => { useBoardData(...args); return { state: boardState } } }))
vi.mock('./useWikiData', () => ({ useWikiData: (...args: unknown[]) => { useWikiData(...args); return { snapshot: { list: wikiState } } } }))
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, onClick, type = 'button', disabled }: { children: ReactNode; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean }) => <button type={type} onClick={onClick} disabled={disabled}>{children}</button>,
  Input: ({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) => <label>{label}<input {...props} /></label>,
  Select: Object.assign(({ label, value, onValueChange, children }: { label: string; value: string; onValueChange: (value: string) => void; children: ReactNode }) => <label>{label}<select value={value} onChange={event => onValueChange(event.currentTarget.value)}>{children}</select></label>, {
    Option: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  }),
}))

let root: Root
let container: HTMLDivElement
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
beforeAll(() => { testGlobal.IS_REACT_ACT_ENVIRONMENT = true })
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})
const widget: CanvasProjectBoardWidget = { id: 'board-1', kind: 'inferops.project-board', version: 1,
  targetRef: 'inferops://demo.local/project/board/DEMO', size: 'wide', params: { workflow: 'software', showCompleted: false } }
const render = async (onSave = vi.fn<(next: CanvasWidget) => void>(), selectedWidget: CanvasProjectBoardWidget | CanvasWikiWidget = widget) => act(async () => {
  root.render(<CanvasDataBindingEditor widget={selectedWidget} overseer={{} as never} busy={false} onSave={onSave} />)
})
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)!
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  boardState.status = 'ready'; boardState.code = ''; wikiState.status = 'ready'; wikiState.code = ''
  useBoardData.mockClear(); useWikiData.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('reports an incompatible resource type without probing it', async () => {
  await render()
  await act(async () => {
    const select = container.querySelector('select')!
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'knowledge/wiki')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => button('Check read access').click())
  expect(container.textContent).toContain('This resource type cannot be bound to this widget.')
  expect(useBoardData).not.toHaveBeenCalled()
  expect(useWikiData).not.toHaveBeenCalled()
})

it('reports missing read permission with a fixed message', async () => {
  boardState.status = 'error'; boardState.code = 'FORBIDDEN'
  await render()
  await act(async () => button('Check read access').click())
  await settle()
  expect(container.textContent).toContain('You do not have read access to this resource.')
})

it('reports an unavailable resource without exposing provider text', async () => {
  boardState.status = 'error'; boardState.code = 'NOT_FOUND'
  await render()
  await act(async () => button('Check read access').click())
  await settle()
  expect(container.textContent).toContain('This resource is unavailable.')
  expect(container.textContent).not.toContain('NOT_FOUND')
})

it('saves the typed binding only after the existing read succeeds', async () => {
  const onSave = vi.fn<(next: CanvasWidget) => void>()
  await render(onSave)
  await act(async () => button('Check read access').click())
  await settle()
  expect(container.textContent).toContain('Read access confirmed.')
  await act(async () => button('Use this read binding').click())
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ targetRef: widget.targetRef,
    dataBinding: { resource: 'project/board', ref: widget.targetRef, schemaVersion: 1 } }))
})

it('checks a Wiki through WikiData and saves its typed source', async () => {
  const wiki: CanvasWikiWidget = { id: 'wiki-1', kind: 'inferops.wiki', version: 1,
    targetRef: 'inferops://demo.local/knowledge/wiki', size: 'wide', params: { page: null } }
  const onSave = vi.fn<(next: CanvasWidget) => void>()
  await render(onSave, wiki)
  await act(async () => button('Check read access').click())
  await settle()
  expect(useWikiData).toHaveBeenCalledWith(expect.anything(), wiki.targetRef)
  await act(async () => button('Use this read binding').click())
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dataBinding: {
    resource: 'knowledge/wiki', ref: wiki.targetRef, schemaVersion: 1,
  } }))
})
