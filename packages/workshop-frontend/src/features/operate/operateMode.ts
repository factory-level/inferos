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

// The last Build location seen this session (path, search and hash), so the Build toggle returns
// the user where they left off. In memory only: a reload starts again from Home.
let lastBuildHref: string | null = null

/** Records `href` as the place the Build toggle returns to, if it is a Build location. */
export const rememberBuildLocation = (pathname: string, href: string) => {
  if (modeForPath(pathname) === 'build') lastBuildHref = href
}

/** Where the Build toggle goes: the last Build location visited this session, else Home. */
export const buildReturnHref = () => lastBuildHref ?? '/'

/** Test-only: forgets the remembered Build location. */
export const resetBuildLocationForTests = () => { lastBuildHref = null }
