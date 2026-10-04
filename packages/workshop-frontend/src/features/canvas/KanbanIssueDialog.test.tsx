// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NewIssue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { ProposalResult } from './boardData'
import { KanbanIssueDialog } from './KanbanIssueDialog'

// The real Kumo Dialog and Select: what is under test is how their Base UI portals and the modal
// dialog's hiding of everything outside it combine.

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const TODO: State = { id: 'todo', name: 'Todo', group: 'unstarted', position: 0, workflow: 'software' }
const onCreate = vi.fn<(issue: NewIssue) => Promise<ProposalResult>>(async () => ({ ok: true }))
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })

/** Whether an element is outside the accessibility tree because it or an ancestor is hidden or inert. */
const hiddenFromAssistiveTech = (element: Element) => {
  for (let node: Element | null = element; node; node = node.parentElement)
    if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) return true
  return false
}

it('keeps the priority options reachable by assistive tech while the modal dialog is open', async () => {
  await act(async () => root.render(<KanbanIssueDialog kind="create" state={TODO} onCreate={onCreate}
    trigger={<button type="button">New issue</button>} />))
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'New issue')!.click())
  await settle()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog).not.toBeNull()

  const priority = dialog.querySelector<HTMLElement>('[role="combobox"]')!
  await act(async () => priority.click())
  await settle()

  const options = [...document.querySelectorAll('[role="option"]')]
  expect(options.map(option => option.textContent)).toEqual(['No priority', 'Urgent', 'High', 'Medium', 'Low'])
  for (const option of options) expect(hiddenFromAssistiveTech(option)).toBe(false)
  // The listbox lives in the dialog's own portal, the subtree the dialog leaves visible.
  const dialogPortal = dialog.closest('[data-base-ui-portal]')!
  expect(dialogPortal.contains(options[0]!)).toBe(true)
})
