/**
 * The two halves of the Workshop. Build is where workspaces, blueprints and outputs are made;
 * Operate is the InferOps Canvas, where saved screens are used. The mode is a pure function of the
 * URL, never stored state, so links and reloads always land in the mode their page belongs to.
 */
export type AppMode = 'build' | 'operate'

/** Where the Operate toggle goes: the InferOps Canvas home, which lists and creates screens. */
export const OPERATE_HOME = '/inferops-canvas'

const OPERATE_PATH = /^\/(?:inferops-canvas|workspace\/[^/]+\/inferops-canvas)\/?$/

/** The mode a pathname belongs to: the InferOps Canvas routes are Operate, everything else Build. */
export const modeForPath = (pathname: string): AppMode => OPERATE_PATH.test(pathname) ? 'operate' : 'build'

const WORKSPACE_CANVAS_PATH = /^\/workspace\/([^/]+)\/inferops-canvas\/?$/

// The last location seen in each mode this session (path, search and hash), so the toggle returns
// the user where they left off. In memory only: a reload starts again from each mode's home.
const lastHref: Record<AppMode, string | null> = { build: null, operate: null }

/** Records `href` as the place the toggle returns to for the mode `pathname` belongs to. */
export const rememberLocation = (pathname: string, href: string) => {
  lastHref[modeForPath(pathname)] = href
}

/**
 * Where the Build toggle goes: the last Build location visited this session. With none (a reload
 * or a link straight into Operate), a workspace's canvas returns to that workspace, anything else Home.
 */
export const buildReturnHref = (pathname?: string) => {
  if (lastHref.build) return lastHref.build
  const workspaceId = pathname ? WORKSPACE_CANVAS_PATH.exec(pathname)?.[1] : undefined
  return workspaceId ? `/workspace/${workspaceId}` : '/'
}

/** Where the Operate toggle goes: the last Operate location visited this session, else its home. */
export const operateReturnHref = () => lastHref.operate ?? OPERATE_HOME

/** Test-only: forgets the remembered locations. */
export const resetReturnLocationsForTests = () => { lastHref.build = null; lastHref.operate = null }
