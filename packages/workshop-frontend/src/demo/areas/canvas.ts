// Demo fixtures and scenarios for the "canvas" views (InferOps Canvas home and a workspace's canvas
// page). Canvases are kept per workspace in memory, so creating, editing and deleting work for the
// page load. Gadget widgets reference the workspace area's fixture gadgets by ID (see CANVAS_GADGETS).

import {
  applyCanvasOperations,
  parseCanvasDefinition,
  type CanvasCatalog,
  type CanvasContent,
  type CanvasDefinition,
  type CanvasSection,
  type CanvasWidget,
} from '@gadgets/workshop-shared/canvas'
import type { WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { demoContext, forever, provide } from '../registry'
import { scenario } from '../scenarios'
import { world } from '../world'
import { workspaceDemo, workspaceFixtures } from './workspace'

/** Gadget workpiece IDs the canvas fixtures reference in `ws-ops`; `missing` deliberately does not exist. */
export const CANVAS_GADGETS = { dashboard: 0, incidents: 1, onCall: 2, deploys: 3, costs: 4, sla: 5, draft: 7, missing: 404 } as const

// Extra gadgets for the canvas, added to the workspace area's ws-ops workpieces (1 and 2 are its own).
const extraGadgets: WorkpieceSummary[] = [
  { id: 3, type: 'gadget', title: 'Deploy frequency — last 30 days', commitId: '3a9f0c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f901' },
  { id: 4, type: 'gadget', title: 'Cloud spend by team', commitId: '4b0e1f2a3c5d6e7f8091a2b3c4d5e6f708192a3b' },
  { id: 5, type: 'gadget', title: 'SLA burn-down', commitId: '5c1f2a3b4d6e7f8091a2b3c4d5e6f708192a3b4c' },
  { id: 7, type: 'gadget', title: 'Escalation heatmap (draft)', chatId: 12 },
]
const opsWorkpieces = workspaceFixtures['ws-ops']?.workpieces
if (opsWorkpieces) for (const item of extraGadgets) if (!opsWorkpieces.some(existing => existing.id === item.id)) opsWorkpieces.push(item)

const board = (id: string, key: string, size: CanvasWidget['size'] = 'full', workflow: 'software' | 'content' = 'software', showCompleted = false): CanvasWidget =>
  ({ id, kind: 'inferops.project-board', version: 1, targetRef: `inferops://demo.local/project/board/${key}`, size, params: { workflow, showCompleted } })
const gadget = (id: string, gadgetId: number, size: CanvasWidget['size'] = 'normal'): CanvasWidget =>
  ({ id, kind: 'inferos.gadget', version: 1, targetRef: `gadget:${gadgetId}`, size, params: {} })
const section = (id: string, title: string, columns: 1 | 2 | 3, widgets: CanvasWidget[]): CanvasSection => ({ id, title, columns, widgets })
const view = (id: string, revision: string, title: string, sections: CanvasSection[]): CanvasDefinition =>
  parseCanvasDefinition({ schemaVersion: 1, id, revision, title, sections })

const G = CANVAS_GADGETS

/** The deployment catalog: both widget kinds, blueprint widgets the agent can build, and templates. */
export const DEMO_CANVAS_CATALOG: CanvasCatalog = {
  widgetKinds: ['inferops.project-board', 'inferos.gadget'],
  blueprints: [
    { blueprintId: 'inferops.kanban', label: 'InferOps Kanban', description: 'A live Kanban of one InferOps project board, with approved transitions.' },
    { blueprintId: 'inferops.activity', label: 'Agent activity', description: 'A feed of what agents changed on the board, newest first.' },
    { blueprintId: 'inferops.burndown', label: 'Sprint burndown', description: 'Remaining points per day for the current sprint of a board.' },
  ],
  screens: [
    { id: 'tpl-operations', content: { title: 'Operations', sections: [
      { id: 'tpl-ops-delivery', title: 'Delivery', columns: 1, widgets: [board('tpl-ops-board', 'DEMO')] }] } },
    { id: 'tpl-release', content: { title: 'Release train', sections: [
      { id: 'tpl-rel-now', title: 'This release', columns: 2, widgets: [board('tpl-rel-board', 'REL', 'wide')] },
      { id: 'tpl-rel-next', title: 'Next release', columns: 1, widgets: [] }] } },
  ],
}

/** Saved canvases by workspace ID. Scenarios mutate this in `setup`. */
export const canvasStore: Record<string, CanvasDefinition[]> = {
  'ws-ops': [
    view('ops-overview', '14', 'Operations overview', [
      section('ops-delivery', 'Delivery pipeline', 2, [
        board('ops-board-demo', 'DEMO', 'full'),
        gadget('ops-gadget-deploys', G.deploys),
        gadget('ops-gadget-incidents', G.incidents),
      ]),
      section('ops-health', 'Service health and spend', 3, [
        gadget('ops-gadget-sla', G.sla),
        gadget('ops-gadget-oncall', G.onCall),
        gadget('ops-gadget-costs', G.costs),
        gadget('ops-gadget-dashboard', G.dashboard, 'wide'),
      ]),
      section('ops-content', 'Content calendar', 1, [board('ops-board-content', 'MARKETING-CONTENT', 'full', 'content', true)]),
    ]),
    view('ops-team', '6', 'Team gadgets (needs attention)', [
      section('team-attention', 'Widgets that need attention', 2, [
        gadget('team-gadget-draft', G.draft),
        gadget('team-gadget-missing', G.missing),
        gadget('team-gadget-oncall', G.onCall, 'wide'),
      ]),
    ]),
    view('ops-release', '3', 'Release readiness — Q4 platform migration and customer onboarding', [
      section('rel-boards', 'Boards', 2, [
        board('rel-board-platform', 'PLATFORM', 'wide'),
        board('rel-board-onboarding', 'ONBOARDING', 'normal', 'content'),
        board('rel-board-security', 'SECURITY-REVIEW', 'normal', 'software', true),
      ]),
    ]),
    view('ops-long', '9', 'Gadget wall', [
      section('wall-1', 'Delivery', 1, [board('wall-board-1', 'DEMO'), gadget('wall-gadget-deploys', G.deploys, 'full')]),
      section('wall-2', 'Incidents', 1, [gadget('wall-gadget-incidents', G.incidents, 'full')]),
      section('wall-3', 'Far below the fold', 1, [gadget('wall-gadget-sla', G.sla, 'full')]),
    ]),
    view('ops-war-room', '2', 'Incident war room', [
      section('war-timeline', 'Timeline', 2, []),
      section('war-comms', 'Customer comms', 1, []),
    ]),
    view('ops-scratch', '1', 'Scratch', []),
  ],
  'ws-triage': [
    view('triage-board', '21', 'Triage board', [
      section('triage-inbox', 'Inbox', 1, [board('triage-board-inbox', 'SUPPORT')]),
      section('triage-escalations', 'Escalations', 2, [board('triage-board-esc', 'ESCALATIONS', 'normal'), board('triage-board-bugs', 'BUGS', 'normal')]),
    ]),
    view('triage-weekly', '4', 'Weekly review', [section('weekly-summary', 'Summary', 1, [])]),
  ],
  'ws-notes': [],
}

/** How the canvas fixtures misbehave, for loading and error scenarios. */
export const canvasDemo = { listCanvases: 'ok' as 'ok' | 'forever' | 'fail', failWorkspaces: new Set<string>() }

// The Overseer's context is set by the workspace area's openGadget; accept an ID or an object with one.
const workspaceOf = (target: object): string => {
  const context = demoContext<unknown>(target)
  if (typeof context === 'string') return context
  if (context && typeof context === 'object') {
    const record = context as Record<string, unknown>
    for (const key of ['workspaceId', 'id']) if (typeof record[key] === 'string') return record[key] as string
  }
  return world.defaultParams.id
}
const viewsOf = (target: object) => (canvasStore[workspaceOf(target)] ??= [])
const find = (target: object, id: string) => {
  const found = viewsOf(target).find(item => item.id === id)
  if (!found) throw new Error('Canvas not found')
  return found
}

provide('Overseer', {
  listCanvases() {
    const workspaceId = workspaceOf(this)
    if (canvasDemo.listCanvases === 'forever') return forever()
    if (canvasDemo.listCanvases === 'fail' || canvasDemo.failWorkspaces.has(workspaceId)) {
      throw new Error('This workspace needs observer setup before its screens can be read')
    }
    return viewsOf(this)
  },
  getCanvas(id) {
    return viewsOf(this).find(item => item.id === id) ?? null
  },
  createCanvas(content: CanvasContent) {
    const created = parseCanvasDefinition({ ...content, schemaVersion: 1, id: crypto.randomUUID(), revision: '1' })
    viewsOf(this).push(created)
    return created
  },
  editCanvas(id, expectedRevision, operations) {
    const updated = applyCanvasOperations(find(this, id), expectedRevision, operations, DEMO_CANVAS_CATALOG.widgetKinds)
    const list = viewsOf(this)
    list[list.findIndex(item => item.id === id)] = updated
    return updated
  },
  deleteCanvas(id, expectedRevision) {
    if (find(this, id).revision !== expectedRevision) throw new Error('Canvas changed; reload before applying this edit')
    canvasStore[workspaceOf(this)] = viewsOf(this).filter(item => item.id !== id)
  },
})

world.serverConfig.canvasFeatures = { composableViews: true, durableViews: true, catalog: DEMO_CANVAS_CATALOG }

const PAGE = '/workspace/ws-ops/inferops-canvas'
const EDIT = [{ click: 'text=Edit layout' }]
const disableComposable = (w: typeof world) => { w.serverConfig.canvasFeatures = { composableViews: false, durableViews: false } }
const noViews = () => { canvasStore['ws-ops'] = [] }

scenario({
  'canvas.home.disabled': { setup: disableComposable },
  'canvas.home.empty': { setup: w => { w.workspaces = w.workspaces.filter(item => item.role === 'use') } },
  'canvas.home.error': {
    setup: () => provide('AuthenticatedApi', { listGadgets: () => { throw new Error('Connection lost') } }, { override: true }),
  },
  'canvas.home.loading': { setup: () => { canvasDemo.listCanvases = 'forever' } },
  'canvas.home.new-screen': {
    steps: [{ type: 'Platform on-call rotation and incident response', into: 'input[name="title"]' }],
  },
  'canvas.home.saved-disabled-notice': { setup: w => { w.serverConfig.canvasFeatures = { composableViews: true, durableViews: false, catalog: DEMO_CANVAS_CATALOG } } },
  'canvas.home.workspace-row': {
    setup: w => {
      const created = new Date(Date.now() - 86_400_000 * 60)
      w.workspaces = [...w.workspaces, { id: 'ws-archive', title: 'Archived vendor integrations (needs observer setup)',
        defaultGadgetId: 0, role: 'build', created, lastActive: created }]
      canvasDemo.failWorkspaces.add('ws-archive')
    },
  },
  'canvas.select-popover': {
    path: `${PAGE}?view=ops-overview`,
    steps: [...EDIT, { click: 'form[aria-label="Move a widget between sections"] [role="combobox"], form[aria-label="Move a widget between sections"] button' }],
  },
  'canvas.workspace.create-form': { setup: noViews },
  'canvas.workspace.disabled': { setup: disableComposable },
  'canvas.workspace.error': { path: '/workspace/does-not-exist/inferops-canvas' },
  'canvas.workspace.loading': {
    setup: () => { workspaceDemo.openHangs = true },
  },
  'canvas.workspace.no-view': { setup: noViews },
  'canvas.workspace.edit': { path: `${PAGE}?view=ops-overview`, steps: EDIT },
  'canvas.workspace.edit.add-section': {
    path: `${PAGE}?view=ops-overview`,
    steps: [...EDIT, { type: 'Customer escalations', into: 'input[name="section"]' }],
  },
  'canvas.workspace.edit.delete-dialog': { path: `${PAGE}?view=ops-overview`, steps: [...EDIT, { click: 'text=Delete view' }] },
  'canvas.workspace.edit.move-widget': {
    path: `${PAGE}?view=ops-overview`,
    steps: [...EDIT, { type: 'Customer escalations', into: 'input[name="section"]' }],
  },
  'canvas.workspace.edit.rename-view': {
    path: `${PAGE}?view=ops-overview`,
    steps: [...EDIT, { type: 'Operations overview — week 41', into: 'input[name="title"][maxlength="120"][value="Operations overview"]' }],
  },
  'canvas.workspace.edit.section': { path: `${PAGE}?view=ops-overview`, steps: EDIT },
  'canvas.workspace.edit.add-board': {
    path: `${PAGE}?view=ops-release`,
    steps: [...EDIT, { type: 'inferops://demo.local/project/board/DEMO', into: 'input[name="target"]' }],
  },
  'canvas.workspace.edit.add-gadget': { path: `${PAGE}?view=ops-war-room`, steps: EDIT },
  'canvas.workspace.edit.blueprints': { path: `${PAGE}?view=ops-war-room`, steps: EDIT },
  'canvas.workspace.edit.widget.board': { path: `${PAGE}?view=ops-release`, steps: EDIT },
  'canvas.workspace.edit.widget.gadget': { path: `${PAGE}?view=ops-team`, steps: EDIT },
  'canvas.workspace.view': { path: `${PAGE}?view=ops-overview` },
  'canvas.workspace.view.empty': { path: `${PAGE}?view=ops-war-room` },
  'canvas.workspace.widget.board': { path: `${PAGE}?view=ops-release` },
  'canvas.workspace.widget.gadget': { path: `${PAGE}?view=ops-overview` },
  'canvas.workspace.widget.gadget.deferred': { path: `${PAGE}?view=ops-long` },
  'canvas.workspace.widget.gadget.draft': { path: `${PAGE}?view=ops-team` },
  'canvas.workspace.widget.gadget.missing': { path: `${PAGE}?view=ops-team` },
})
