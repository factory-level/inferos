import { AppWindowIcon, FlowArrowIcon, SquaresFourIcon, type Icon } from '@phosphor-icons/react'
import { DEFAULT_WORKSPACE_KIND, type WorkspaceKind } from '@gadgets/workshop-shared/api'

/** How a workspace kind is presented wherever it is named. */
export type WorkspaceKindPresentation = {
  /** Short name, e.g. "Workflow". */
  label: string
  /** Phosphor icon component for the kind. */
  icon: Icon
  /** One line saying what the kind is. */
  description: string
  /** How the kind appears in Operate, completing "In Operate: …". */
  operate: string
  /** What switching *to* this kind changes, shown before the switch is confirmed. */
  switchConsequence: string
}

/** Label, icon and copy for each `WorkspaceKind`. */
export const WORKSPACE_KIND_PRESENTATION: Record<WorkspaceKind, WorkspaceKindPresentation> = {
  app: {
    label: 'App',
    icon: AppWindowIcon,
    description: 'A full-screen gadget people open and use. Has a Chat ↔ App toggle.',
    operate: 'a launch card on screens; opens full-screen with Chat ↔ App',
    switchConsequence:
      'Switching to App brings back the app view with a Chat ↔ App toggle. Its gadget code is kept.',
  },
  widget: {
    label: 'Widget',
    icon: SquaresFourIcon,
    description: 'A small gadget that lives as a tile on InferOps Canvas screens.',
    operate: 'a live tile on screens',
    switchConsequence:
      'Switching to Widget removes the Chat ↔ App toggle and presents the gadget as a tile on screens. Its gadget code is kept.',
  },
  workflow: {
    label: 'Workflow',
    icon: FlowArrowIcon,
    description: 'No UI. The agent runs on a schedule or when an event arrives.',
    operate: 'a status tile on screens, with triggers, runs and approvals',
    switchConsequence:
      'Switching to Workflow hides the app view and shows its triggers instead. Its gadget code is kept; add a timed or event trigger to start runs.',
  },
}

/**
 * A workspace's kind from its metadata (or a `listGadgets()` entry). Records that predate kinds
 * have none and read as the default, "app". Never inferred from anything else.
 */
export function kindOf(metadata: { kind?: WorkspaceKind }): WorkspaceKind {
  return metadata.kind ?? DEFAULT_WORKSPACE_KIND
}

/** Only an app has a standalone app view to toggle to. */
export function hasAppViewToggle(kind: WorkspaceKind): boolean {
  return kind === 'app'
}

/** What the output pane's first tab shows: the gadget's UI, or a workflow's triggers. */
export function workspaceOutputView(kind: WorkspaceKind): 'app' | 'triggers' {
  return kind === 'workflow' ? 'triggers' : 'app'
}
