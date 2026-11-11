// FAC-123: what a duplicate says about where it came from and why it can't run yet. The reasons are
// the server's own sentences, chosen in the server's order; nothing names a source a viewer can't see.
import { expect, it } from 'vitest'
import {
  MAX_WORKFLOW_DEFINITION_TITLE_LENGTH,
  WORKFLOW_BINDINGS_NEEDED,
  WORKFLOW_BINDINGS_NOT_OWNERS,
  WORKFLOW_BINDINGS_UNATTRIBUTED,
  type WorkflowRequiredBinding,
} from '@gadgets/workshop-shared/workflow-definition'
import { bindingsNeededText, copyTitle, duplicatedFromText, unmetText } from './duplicateText'

const binding = (unmet?: WorkflowRequiredBinding['unmet']): WorkflowRequiredBinding =>
  ({ name: 'BOARD', type: 'gatekeeper', vendorId: 'inferops', typeUrlPattern: 'inferops://*', ...(unmet ? { unmet } : {}) })

it("says nothing when nothing is needed, and otherwise the server's refusal in its order", () => {
  expect(bindingsNeededText(undefined)).toBeNull()
  expect(bindingsNeededText([])).toBeNull()
  expect(bindingsNeededText([binding('missing')])).toBe(WORKFLOW_BINDINGS_NEEDED)
  expect(bindingsNeededText([binding()])).toBe(WORKFLOW_BINDINGS_NEEDED)
  expect(bindingsNeededText([binding('missing'), binding('not-owners')])).toBe(WORKFLOW_BINDINGS_NOT_OWNERS)
  expect(bindingsNeededText([binding('not-owners'), binding('unattributed')])).toBe(WORKFLOW_BINDINGS_UNATTRIBUTED)
})

it('says what is wrong with each connection being set up', () => {
  expect(unmetText(binding('missing'))).toBe('Not set up yet.')
  expect(unmetText(binding('not-owners'))).toContain("another person's account or model")
  expect(unmetText(binding('unattributed'))).toContain('Set it up again from your own')
})

it("names the source only as far as the server shows it", () => {
  expect(duplicatedFromText({ at: new Date(0), definitionId: 'k', title: 'Refunds', revision: 3 }))
    .toBe('Duplicated from “Refunds”, revision 3')
  expect(duplicatedFromText({ at: new Date(0), definitionId: 'k', title: 'Refunds' })).toBe('Duplicated from “Refunds”')
  expect(duplicatedFromText({ at: new Date(0) })).toBe('Duplicated from a workflow')
})

it("offers a copy's title within the title limit", () => {
  expect(copyTitle('Refunds')).toBe('Refunds (copy)')
  const long = copyTitle('x'.repeat(MAX_WORKFLOW_DEFINITION_TITLE_LENGTH))
  expect(long).toHaveLength(MAX_WORKFLOW_DEFINITION_TITLE_LENGTH)
  expect(long.endsWith(' (copy)')).toBe(true)
})
