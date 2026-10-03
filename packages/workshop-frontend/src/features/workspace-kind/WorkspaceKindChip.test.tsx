// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, describe, expect, it } from 'vitest'
import { WorkspaceKindChip } from './WorkspaceKindChip'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function renderChip(kind: Parameters<typeof WorkspaceKindChip>[0]['kind']) {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(<WorkspaceKindChip kind={kind} />))
  const text = container.textContent
  act(() => root.unmount())
  return text
}

describe('WorkspaceKindChip', () => {
  it('labels a list entry with no stored kind as App', () => {
    expect(renderChip(undefined)).toBe('App')
  })

  it('labels each stored kind', () => {
    expect(renderChip('widget')).toBe('Widget')
    expect(renderChip('workflow')).toBe('Workflow')
  })
})
