import { Banner } from '@cloudflare/kumo'
import type { WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import type { ConsolePublication } from '@gadgets/workshop-shared/operate-console'

/**
 * Tells a builder which apps operators can't open: a published console fences each app it places
 * at the commit it published (FAC-89 part 2), so once the app's head moves, operators are refused
 * it until the console is published again. A console published before apps were fenced lists none,
 * so operators get none of its apps: every app its published pages place (`placed`, read as the
 * kernel's fence reads them, nested pages included) is named then. Nothing
 * is shown for an unpublished console, while every app is still at its published commit, or before
 * the workspace's gadgets have loaded.
 */
export const ConsolePlacedAppsNotice = ({ published, placed, workpieces, consoleTitle }: {
  published: Pick<ConsolePublication, 'apps'> | null | undefined
  /**
   * The gadgets the published pages place (`usePublishedConsolePlacements`), for a publication with
   * no `apps`; null until read.
   */
  placed: readonly WorkpieceId[] | null
  workpieces: ReadonlyMap<WorkpieceId, WorkpieceSummary>
  consoleTitle: string
}) => {
  if (!published || workpieces.size === 0) return null
  const legacy = published.apps === undefined
  const changed = legacy ? unfencedApps(placed ?? [], workpieces) : (published.apps ?? []).flatMap(app => {
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

// The titles of the apps among `placed`, once each: every gadget there that isn't a widget install,
// registered or frozen. A gadget no longer in the workspace is left out; nothing of it can be opened.
function unfencedApps(placed: readonly WorkpieceId[], workpieces: ReadonlyMap<WorkpieceId, WorkpieceSummary>): string[] {
  return [...new Set(placed)].flatMap(id => {
    const piece = workpieces.get(id)
    return piece?.type === 'gadget' && !piece.frozenFor && piece.installedFrom?.kind !== 'widget' ? [piece.title] : []
  })
}
