// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-9: a widget a newer InferOS stored is drawn as a note saying what it needs, and the editor's
// card for it offers no controls: its canvas can't be changed here.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasSection, CanvasUnsupportedWidget as Widget } from '@gadgets/workshop-shared/canvas'
import { CanvasWidgetCard } from './CanvasWidgetCard'

const WIDGET: Widget = { id: 'rows', kind: 'inferos.unsupported', version: 1, targetRef: '', size: 'full', params: {}, storedKind: 'inferos.governed-table' }
const SECTION: CanvasSection = { id: 'work', title: 'Work', columns: 2, widgets: [WIDGET] }

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('says the widget needs a newer InferOS, and offers nothing to change it', async () => {
  const onEdit = vi.fn<(operations: unknown[]) => Promise<boolean>>(async () => true)
  await act(async () => root.render(<CanvasWidgetCard widget={WIDGET} section={SECTION} index={0} busy={false} gadgets={new Map()}
    overseer={{} as RpcStub<Overseer>} onEdit={onEdit} />))
  expect(container.querySelector('[role="note"]')?.textContent).toBe('This widget needs a newer InferOS (inferos.governed-table).')
  expect(container.querySelectorAll('button')).toHaveLength(0)
  expect(onEdit).not.toHaveBeenCalled()
})
