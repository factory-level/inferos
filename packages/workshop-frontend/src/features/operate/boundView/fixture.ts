import type { HostBoardViewSnapshot } from '@gadgets/workshop-shared/operate-console'

/**
 * A synthetic board the Build preview evaluates a `view.json` over, for every requirement. It is
 * made up, never read from InferOps: real board data appears only in a console's draft preview in
 * Operate, read with the builder's own connection.
 */
export const BOUND_VIEW_FIXTURE: HostBoardViewSnapshot = {
  project: { identifier: 'DEMO', name: 'Sample project' },
  columns: [
    { label: 'Backlog', group: 'backlog', issues: [
      { identifier: 'DEMO-7', title: 'Sample: tidy the onboarding checklist', priority: 'low', targetDate: null, blocked: false },
      { identifier: 'DEMO-8', title: 'Sample: draft the quarterly summary', priority: 'none', targetDate: null, blocked: false },
    ] },
    { label: 'Todo', group: 'unstarted', issues: [
      { identifier: 'DEMO-4', title: 'Sample: replace the staging certificate', priority: 'urgent', targetDate: '2026-01-15', blocked: false },
      { identifier: 'DEMO-5', title: 'Sample: review the access list', priority: 'high', targetDate: '2026-01-20', blocked: true },
      { identifier: 'DEMO-6', title: 'Sample: update the runbook', priority: 'medium', targetDate: null, blocked: false },
    ] },
    { label: 'In progress', group: 'started', issues: [
      { identifier: 'DEMO-2', title: 'Sample: migrate the reporting job', priority: 'high', targetDate: '2026-01-10', blocked: false },
      { identifier: 'DEMO-3', title: 'Sample: fix the export timeout', priority: 'urgent', targetDate: null, blocked: true },
    ] },
    { label: 'Done', group: 'completed', issues: [
      { identifier: 'DEMO-1', title: 'Sample: set up the project board', priority: 'medium', targetDate: '2026-01-05', blocked: false },
    ] },
  ],
}
