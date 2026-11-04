import { Banner } from '@cloudflare/kumo'
import type { WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import type { ConsolePublishedApp } from '@gadgets/workshop-shared/operate-console'

/**
 * Tells a builder which apps operators can't open: a published console fences each app it places
 * at the commit it published (FAC-89 part 2), so once the app's head moves, operators are refused
 * it until the console is published again. Nothing is shown while every app is still at its
 * published commit, or before the workspace's gadgets have loaded.
 */
export const ConsolePlacedAppsNotice = ({ apps, workpieces, consoleTitle }: {
  /** The published revision's fenced apps; undefined when unpublished or published before apps were fenced. */
  apps: readonly ConsolePublishedApp[] | undefined
  workpieces: ReadonlyMap<WorkpieceId, WorkpieceSummary>
  consoleTitle: string
}) => {
  const changed = (apps ?? []).flatMap(app => {
    const piece = workpieces.get(app.gadgetId)
    if (piece === undefined) return workpieces.size === 0 ? [] : [`app ${app.gadgetId}`]
    return piece.type === 'gadget' && piece.commitId !== app.commitId ? [piece.title] : []
  })
  if (changed.length === 0) return null
  return <Banner variant="alert" title={`Operators can't open ${changed.join(', ')} until you publish ${consoleTitle} again`}
    description={changed.length === 1 ? 'It changed after this console was published, and operators only get the version a console publishes.'
      : 'They changed after this console was published, and operators only get the versions a console publishes.'} />
}
