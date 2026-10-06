// Demo fixtures and scenarios for the "shell" and "home" views. See ../registry.ts and ../scenarios.ts.
//
// The shell reaches no AuthenticatedApi method of its own: the sidebar and palette use listGadgets
// (core), blueprint/output-format lists (browse) and Overseer actions (workspace). This file adds
// richer workspace lists and the scenarios that open the shell's menus, dialogs and states.

import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { forever, provide } from '../registry'
import { scenario } from '../scenarios'
import type { DemoWorld } from '../world'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

// [title, minutes since last active, pinned?, shared-by]
const MANY: [string, number, boolean?, string?][] = [
  ['Quarterly revenue forecast and pipeline review for the EMEA sales organisation', 4, true],
  ['Customer support inbox', 35, true],
  ['Hiring pipeline', 60 * 3, true, 'Priya Natarajan'],
  ['Incident postmortems', 60 * 8],
  ['Weekly team standup deck', 60 * 20],
  ['Expense report helper', 60 * 30, false, 'Marcus Chen'],
  ['Product roadmap Q4', 60 * 50],
  ['Onboarding checklist for new engineers', 60 * 72],
  ['Marketing site copy review', 60 * 24 * 4],
  ['Vendor contract tracker', 60 * 24 * 6, false, 'Alex Okafor'],
  ['Release notes drafter', 60 * 24 * 9],
  ['Office move planning', 60 * 24 * 15],
  ['Bug bash results', 60 * 24 * 21],
  ['Travel itinerary — Lisbon offsite', 60 * 24 * 40],
]

/** Adds a long, varied workspace list (favorites, shared, "Show all (N)") to the world. */
export function addManyWorkspaces(world: DemoWorld): void {
  const extra: GadgetMetadataWithTimestamps[] = MANY.map(([title, ago, pinned, sharedBy], i) => ({
    id: `ws-many-${i}`,
    title,
    defaultGadgetId: 0,
    pinned: pinned || undefined,
    role: sharedBy ? 'use' : 'build',
    owner: sharedBy ? { type: 'user', id: `user-${i}`, name: sharedBy } : undefined,
    created: minutesAgo(ago + 60 * 24 * 3),
    lastActive: minutesAgo(ago),
  }))
  world.workspaces = [...world.workspaces, ...extra]
}

// Holds a core method pending for one scenario; the override is scoped to the page load.
const hold = (method: 'listGadgets' | 'isOnboardingCompleted') => () =>
  provide('AuthenticatedApi', { [method]: () => forever() }, { override: true })

const expanded = { 'gadgets:sidebar-collapsed': '0' }
const openRowMenu = [{ hover: 'aside[aria-label="Primary"] a[href^="/workspace/"]' }, { click: 'text=Workspace actions' }]
// The row menu acts on the first row: a favorite owned by the user in the default world.
const PALETTE = '[role="dialog"][aria-label="Command palette"] input'

scenario({
  // Shell chrome with a well-populated rail.
  shell: { path: '/', setup: addManyWorkspaces, localStorage: expanded },
  'shell.sidebar': { path: '/', setup: addManyWorkspaces, localStorage: expanded },
  'shell.sidebar.brand': { path: '/', localStorage: expanded },
  'shell.sidebar.nav': { path: '/', localStorage: expanded },
  'shell.sidebar.utility': { path: '/', localStorage: expanded },
  'shell.sidebar.workspaces': { path: '/', setup: addManyWorkspaces, localStorage: expanded },
  'shell.sidebar.collapsed': { path: '/', setup: addManyWorkspaces, localStorage: { 'gadgets:sidebar-collapsed': '1' } },
  'shell.sidebar.mobile-drawer': {
    path: '/', setup: addManyWorkspaces, localStorage: expanded,
    steps: [{ click: 'text=Open menu' }],
  },
  'shell.sidebar.utility.user-menu': { path: '/', localStorage: expanded, steps: [{ click: 'text=Open profile menu' }] },
  'shell.sidebar.workspaces.loading': { path: '/', setup: hold('listGadgets'), localStorage: expanded },
  'shell.sidebar.workspaces.row': {
    path: '/', localStorage: expanded,
    steps: [...openRowMenu, { click: 'text=Rename' }],
  },
  'shell.sidebar.workspaces.row.menu': { path: '/', localStorage: expanded, steps: openRowMenu },
  'shell.sidebar.workspaces.delete-dialog': {
    path: '/', localStorage: expanded,
    steps: [...openRowMenu, { click: 'text=Delete' }],
  },
  'shell.sidebar.workspaces.share-modal': {
    path: '/', localStorage: expanded,
    steps: [...openRowMenu, { click: 'text=Share' }],
  },

  // Command palette, opened from the rail's Search button.
  'shell.command-palette': {
    path: '/', setup: addManyWorkspaces, localStorage: expanded,
    steps: [{ click: 'text=Search' }, { wait: PALETTE }],
  },
  'shell.command-palette.no-results': {
    path: '/', localStorage: expanded,
    steps: [{ click: 'text=Search' }, { type: 'zzzzqq', into: PALETTE }],
  },

  // Deployment-wide banner (main.tsx) and the admin notice in the top bar (>= lg).
  'shell.announcement-banner': {
    path: '/',
    localStorage: { dismissedBanner: '' },
    setup: world => {
      world.serverConfig.banner = 'Scheduled maintenance: the Workshop will be read-only on Saturday from 02:00 to 04:00 UTC.'
      world.serverConfig.bannerColor = 'warning'
    },
  },
  'shell.topbar': { path: '/', localStorage: expanded },
  'shell.topbar.notice': {
    path: '/',
    setup: world => {
      world.serverConfig.announcement = 'New: connect your **InferOps** boards — [read the guide](https://example.com/inferops)'
    },
  },

  // Root render states.
  'shell.state.onboarding-check': { path: '/', setup: hold('isOnboardingCompleted') },
  'shell.state.crashed': {
    path: '/',
    // A workspace whose lastActive is not a Date makes the sidebar's sort throw during render,
    // which the top-level FrontendErrorBoundary catches.
    setup: world => {
      world.workspaces[1] = { ...world.workspaces[1], lastActive: 'not a date' as unknown as Date }
    },
  },

  // Signed-out public blueprint page: standalone layout with the legacy header.
  'shell.standalone': { setup: world => { world.signedIn = false } },
  'shell.standalone.header': { setup: world => { world.signedIn = false } },
  'shell.standalone.header.mobile-menu': {
    setup: world => { world.signedIn = false },
    steps: [{ click: 'header.app-header div.sm\\:hidden > button' }],
  },

  // Workspace editor top bar (content owned by the workspace area).
  'shell.activity-popover': { steps: [{ click: 'button[aria-label^="Activity"]' }] },

  // Home with a pre-filled composer.
  'home.composer': { path: '/?prompt=Build%20a%20dashboard%20that%20tracks%20open%20incidents%20by%20severity%20and%20owner' },
})
