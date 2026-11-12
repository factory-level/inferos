// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-120: the workflow run an approval starts, wherever a decision is shown. It is read only from
// the kernel's marker (`ActionContext.declaredRun`), never from a field label a connection wrote,
// and it is marked as InferOS's own, apart from the connection's text.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActionEntry } from '../actionDecision'
import { ActionDecision } from './ActionDecision'
import { DECLARED_RUN_PROVENANCE, DECLARED_RUN_TEXT } from './DeclaredRunNotice'

const REFERENCE = 'inferops://acme.operations/inferos/workflow-trigger/abc/11?definition="def-1"&revision="2"'
const LABEL = 'Workflow run this approval starts (shown by InferOS)'

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const entry = (patch: Partial<ActionEntry> = {}): ActionEntry => ({
  type: 'action', id: 7, gatekeeperId: 3, resourceTitle: 'Dot', createdAt: new Date(0), state: 'pending',
  description: { title: 'Run the refund workflow', description: 'Starts it.', implementsRevert: false },
  ...patch,
} as ActionEntry)
const show = (shown: ActionEntry) => act(() => { root.render(<ActionDecision entry={shown} />) })

describe('the declared run on a decision (FAC-120)', () => {
  it("names the run from the kernel's marker, marked as shown by InferOS", () => {
    show(entry({ context: { kind: 'declared-run', declaredRun: { reference: REFERENCE } } }))
    expect(container.textContent).toContain(`${DECLARED_RUN_TEXT}:`)
    expect(container.textContent).toContain(REFERENCE)
    expect(container.textContent).toContain(DECLARED_RUN_PROVENANCE)
  })

  it("shows it beside another origin, as an agent's turn on someone's behalf", () => {
    show(entry({ context: { kind: 'agent-turn', onBehalfOf: { profileId: 'ada', name: 'Ada' }, declaredRun: { reference: REFERENCE } } }))
    expect(container.textContent).toContain(REFERENCE)
  })

  it("never reads it from a field: a connection's field with the kernel's label shows no run", () => {
    show(entry({ description: { title: 'Create an issue', description: 'Creates one.', implementsRevert: false,
      fields: [{ label: LABEL, kind: 'inline', value: REFERENCE }] } }))
    expect(container.textContent).not.toContain(DECLARED_RUN_TEXT)
    expect(container.textContent).not.toContain(DECLARED_RUN_PROVENANCE)
  })

  it('shows nothing for an action that declared no run', () => {
    show(entry({ context: { kind: 'agent-turn' } }))
    expect(container.textContent).not.toContain(DECLARED_RUN_TEXT)
  })
})
