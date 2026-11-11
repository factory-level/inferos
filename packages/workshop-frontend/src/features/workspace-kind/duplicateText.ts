import {
  MAX_WORKFLOW_DEFINITION_TITLE_LENGTH,
  WORKFLOW_BINDINGS_NEEDED,
  WORKFLOW_BINDINGS_NOT_OWNERS,
  WORKFLOW_BINDINGS_UNATTRIBUTED,
  type WorkflowDefinitionProvenance,
  type WorkflowRequiredBinding,
} from '@gadgets/workshop-shared/workflow-definition'

/**
 * Why a definition can't run yet (FAC-123), in the server's own words: the same sentence it refuses
 * a run with, chosen in its order (one made before InferOS recorded whose account it uses, then one
 * from another person's account or model, then one not set up). Null when nothing is needed.
 */
export const bindingsNeededText = (needed: readonly WorkflowRequiredBinding[] | undefined): string | null => {
  if (!needed || needed.length === 0) return null
  if (needed.some(binding => binding.unmet === 'unattributed')) return WORKFLOW_BINDINGS_UNATTRIBUTED
  if (needed.some(binding => binding.unmet === 'not-owners')) return WORKFLOW_BINDINGS_NOT_OWNERS
  return WORKFLOW_BINDINGS_NEEDED
}

/** What is wrong with one required connection, as its owner reads it while setting it up. */
export const unmetText = (binding: WorkflowRequiredBinding): string => {
  if (binding.unmet === 'not-owners') return "Made from another person's account or model. Set it up from your own."
  if (binding.unmet === 'unattributed') {
    return 'Made before InferOS recorded whose account it uses. Set it up again from your own.'
  }
  return 'Not set up yet.'
}

/**
 * Where a duplicate came from, as this viewer may know it: the source's title and revision only
 * when the server shows them, which it does only to someone who can see that source.
 */
export const duplicatedFromText = (from: WorkflowDefinitionProvenance): string => {
  if (from.title === undefined) return 'Duplicated from a workflow'
  return `Duplicated from “${from.title}”${from.revision === undefined ? '' : `, revision ${from.revision}`}`
}

/** The title a copy is offered: the source's, marked as a copy, within the title limit. */
export const copyTitle = (title: string): string => {
  const suffix = ' (copy)'
  return title.slice(0, MAX_WORKFLOW_DEFINITION_TITLE_LENGTH - suffix.length) + suffix
}
