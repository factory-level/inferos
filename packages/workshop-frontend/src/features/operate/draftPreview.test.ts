import { describe, expect, it } from 'vitest'
import { parseCanvasPage } from '@gadgets/workshop-shared/canvas-model'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import { applyOperateEvent, INITIAL_OPERATE_PAGE } from '@gadgets/workshop-shared/operate-session'
import { openDraftEvent, previewScreen, previewWidgetEvent } from './draftPreview'

// FAC-96: how a widget event moves the simulated preview's own page, and what it only reports.
const DRAFT = {
  id: 'c', revision: '2', title: 'Floor', fullChat: 'off', published: null,
  views: [{ id: 'v-work', title: 'Work', type: 'rollup', screens: ['form', 'review'] }, { id: 'v-done', title: 'Done', type: 'screen', screen: 'done' }],
} as unknown as OperateConsole
const page = (effects: unknown[]) => parseCanvasPage({ schemaVersion: 2, id: 'form', revision: '0', title: 'Form', children: ['a'], attachments: [], nodes: [
  { nodeType: 'object', id: 'a', title: 'A', columns: 1, children: ['g', 'b'], attachments: [] },
  { nodeType: 'widget', id: 'g', kind: 'inferos.gadget', version: 1, targetRef: 'gadget:7', size: 'normal', params: {},
    attachments: effects.map((effect, index) => ({ id: `e${index}`, version: 1, on: 'submit', effect })) },
  { nodeType: 'widget', id: 'b', kind: 'inferops.project-board', version: 1, targetRef: 'inferops://acme.operations/project/board/ENG',
    size: 'normal', params: { workflow: 'software', showCompleted: false }, attachments: [] },
] })
const opened = applyOperateEvent(INITIAL_OPERATE_PAGE, openDraftEvent('ws', DRAFT))

describe('a widget event in the simulated preview', () => {
  it('moves within the open view, or opens the view showing the page, as Operate would', () => {
    expect(previewWidgetEvent(page([{ kind: 'navigate', page: 'review' }]), 'gadget:7', 'submit', DRAFT, opened))
      .toEqual({ move: { type: 'showScreen', screenId: 'review' }, notices: [] })
    expect(previewWidgetEvent(page([{ kind: 'navigate', page: 'done' }]), 'gadget:7', 'submit', DRAFT, opened).move)
      .toEqual({ type: 'openView', viewId: 'v-done' })
  })

  it('only reports a requested action, and a page the console doesn’t show', () => {
    expect(previewWidgetEvent(page([{ kind: 'navigate', page: 'elsewhere' }]), 'gadget:7', 'submit', DRAFT, opened))
      .toEqual({ move: null, notices: [{ kind: 'not-shown', page: 'elsewhere' }] })
    expect(previewWidgetEvent(page([]), 'gadget:7', 'submit', DRAFT, opened)).toEqual({ move: null, notices: [] })
  })

  // FAC-98: a wired draft prompt is only reported, as the draft it would put in the person's chat;
  // it moves nothing, and the navigation beside it still moves the preview's own page.
  it('reports a wired draft prompt as the draft it would put in the chat, beside the navigation', () => {
    expect(previewWidgetEvent(page([{ kind: 'insert-prompt', text: 'Summarise this intake' }]), 'gadget:7', 'submit', DRAFT, opened))
      .toEqual({ move: null, notices: [{ kind: 'would-draft', text: 'Summarise this intake' }] })
    expect(previewWidgetEvent(page([{ kind: 'insert-prompt', text: 'Check it' }, { kind: 'navigate', page: 'review' }]), 'gadget:7', 'submit', DRAFT, opened))
      .toEqual({ move: { type: 'showScreen', screenId: 'review' }, notices: [{ kind: 'would-draft', text: 'Check it' }] })
  })

  it('shows the running flow’s step, else the open screen or screen view', () => {
    expect(previewScreen(DRAFT, opened)).toBeNull()
    expect(previewScreen(DRAFT, applyOperateEvent(opened, { type: 'showScreen', screenId: 'form' }))).toBe('form')
    expect(previewScreen(DRAFT, applyOperateEvent(opened, { type: 'openView', viewId: 'v-done' }))).toBe('done')
    const running = applyOperateEvent(opened, { type: 'startFlow', workspaceId: 'ws', flowId: 'f', title: 'F', steps: ['review', 'done'] })
    expect(previewScreen(DRAFT, running)).toBe('review')
  })
})
