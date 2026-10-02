import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { CanvasCatalogBlueprint } from '@gadgets/workshop-shared/canvas'

/**
 * The catalog's blueprint widgets for one section. Building one takes the agent (it creates the
 * gadget, wires its connection and places it), so each button hands a request to a new chat.
 */
export const CanvasBlueprintWidgets = ({ blueprints, viewTitle, sectionTitle, busy, onAskAgent }: {
  blueprints: CanvasCatalogBlueprint[]
  viewTitle: string
  sectionTitle: string
  busy: boolean
  onAskAgent: (request: string) => Promise<void>
}) => {
  const [asking, setAsking] = useState(false)
  const [failed, setFailed] = useState(false)
  if (blueprints.length === 0) return null
  const ask = async (blueprint: CanvasCatalogBlueprint) => {
    setAsking(true); setFailed(false)
    try {
      await onAskAgent(`Add a ${blueprint.label} widget (blueprint ${blueprint.blueprintId}) to the "${sectionTitle}" ` +
        `section of the "${viewTitle}" canvas. Ask me which board or resource it should show if it needs one.`)
    } catch {
      setFailed(true)
    } finally {
      setAsking(false)
    }
  }
  return <div className="space-y-2" role="group" aria-label={`Widgets the agent can build for ${sectionTitle}`}>
    <p className="text-xs text-kumo-subtle">Ask the agent to build and place a widget here:</p>
    <div className="flex flex-wrap gap-2">
      {blueprints.map(blueprint => <Button key={blueprint.blueprintId} size="sm" disabled={busy || asking}
        title={blueprint.description} onClick={() => void ask(blueprint)}>{blueprint.label}</Button>)}
    </div>
    {failed && <p role="alert" className="text-xs text-kumo-danger">Could not start the chat. Check your connection and try again.</p>}
  </div>
}
