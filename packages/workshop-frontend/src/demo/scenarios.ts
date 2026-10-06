// Demo scenarios: how to bring up one registered view (`views.json`) in demo mode.
//
// `?demo=<view-id>` selects a scenario. Before the app renders, the scenario may mutate the
// fixture world (empty lists, errors, flags) and pick the path to open; after it renders, its
// `steps` click through to whatever the route alone does not show (menus, dialogs, tabs).
// A view without a scenario opens its route with the default world.

import type { DemoWorld } from './world'

/** One UI step, run in order once the page has rendered. Each waits for its selector to appear. */
export type DemoStep =
  | { click: string }
  | { hover: string }
  | { type: string; into: string }
  | { press: string; on?: string }
  | { wait: string }

export interface DemoScenario {
  /** Path (and query) to open; defaults to the view's route with the world's default params. */
  path?: string
  /** Adjusts the fixture world before anything renders. */
  setup?: (world: DemoWorld) => void
  steps?: DemoStep[]
  /** Browser storage to seed before boot (e.g. remembered panel widths, theme). */
  localStorage?: Record<string, string>
}

const scenarios = new Map<string, DemoScenario>()

/** Registers scenarios by view id. Ids must exist in views.json; `pnpm views check` verifies. */
export function scenario(entries: Record<string, DemoScenario>): void {
  for (const [id, entry] of Object.entries(entries)) scenarios.set(id, entry)
}

export function getScenario(id: string): DemoScenario | undefined {
  return scenarios.get(id)
}

export function scenarioIds(): string[] {
  return [...scenarios.keys()]
}
