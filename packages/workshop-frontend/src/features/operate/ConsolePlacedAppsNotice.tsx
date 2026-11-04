import { Banner } from '@cloudflare/kumo'
import type { WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { CANVAS_GADGET_REF, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { ConsolePublication } from '@gadgets/workshop-shared/operate-console'

/**
 * Tells a builder which apps operators can't open: a published console fences each app it places
 * at the commit it published (FAC-89 part 2), so once the app's head moves, operators are refused
 * it until the console is published again. A console published before apps were fenced lists none,
 * so operators get none of its apps: every app its published screens place is named then. Nothing
 * is shown for an unpublished console, while every app is still at its published commit, or before
 * the workspace's gadgets have loaded.
 */
export const ConsolePlacedAppsNotice = ({ published, publishedScreens, workpieces, consoleTitle }: {
  published: Pick<ConsolePublication, 'apps'> | null | undefined
  /** The screens as the published revision copied them; read only for a publication with no `apps`. */
  publishedScreens: readonly CanvasDefinition[]
  workpieces: ReadonlyMap<WorkpieceId, WorkpieceSummary>
  consoleTitle: string
}) => {
  if (!published || workpieces.size === 0) return null
  const legacy = published.apps === undefined
  const changed = legacy ? unfencedApps(publishedScreens, workpieces) : (published.apps ?? []).flatMap(app => {
    const piece = workpieces.get(app.gadgetId)
    if (piece === undefined) return [`app ${app.gadgetId}`]
    return piece.type === 'gadget' && piece.commitId !== app.commitId ? [piece.title] : []
  })
  if (changed.length === 0) return null
  const description = legacy
    ? 'This console was published before apps were tied to the version it publishes, so operators get none of its apps until it is published again.'
    : changed.length === 1 ? 'It changed after this console was published, and operators only get the version a console publishes.'
    : 'They changed after this console was published, and operators only get the versions a console publishes.'
  return <Banner variant="alert" title={`Operators can't open ${changed.join(', ')} until you publish ${consoleTitle} again`} description={description} />
}

// The titles of the apps `screens` place, once each: every gadget there that isn't a widget install,
// registered or frozen. A gadget no longer in the workspace is left out; nothing of it can be opened.
function unfencedApps(screens: readonly CanvasDefinition[], workpieces: ReadonlyMap<WorkpieceId, WorkpieceSummary>): string[] {
  const ids = new Set(screens.flatMap(screen => screen.sections.flatMap(section => section.widgets.flatMap(widget => {
    const match = widget.kind === 'inferos.gadget' ? CANVAS_GADGET_REF.exec(widget.targetRef) : null
    return match ? [Number(match[1])] : []
  }))))
  return [...ids].flatMap(id => {
    const piece = workpieces.get(id)
    return piece?.type === 'gadget' && !piece.frozenFor && piece.installedFrom?.kind !== 'widget' ? [piece.title] : []
  })
}
