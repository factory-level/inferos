import { useState } from 'react'
import { Button, InputArea } from '@cloudflare/kumo'

/**
 * The request handed to the agent for a change to one selected target (FAC-84). It names the
 * canvas, the page revision the person is looking at and the exact target, which the agent's
 * editCanvas tool takes as they are, so the edit goes through the same operations and revision
 * check as a control's, and is refused if the view moved on or the target is gone.
 */
export const canvasTargetRequest = ({ viewTitle, canvasId, revision, target, change }: {
  viewTitle: string
  canvasId: string
  revision: string
  target: string
  change: string
}) => `On the "${viewTitle}" canvas, change the selected target ${target}: ${change}\n\n` +
  `Edit with editCanvas: canvasId ${canvasId}, expectedRevision ${revision}, target ${target}. ` +
  'Change nothing else, and publish nothing. If the canvas changed since this revision, tell me rather than redoing the change on the new content.'

/** Ask the agent, in a new chat, to make a described change to the selected target. */
export const CanvasTargetPrompt = ({ viewTitle, canvasId, revision, target, busy, onAskAgent }: {
  viewTitle: string
  canvasId: string
  /** The page revision shown, which the agent's edit must still be at. */
  revision: string
  /** The selected target's written form (`formatCanvasTarget`). */
  target: string
  busy: boolean
  onAskAgent: (request: string) => Promise<void>
}) => {
  const [change, setChange] = useState('')
  const [asking, setAsking] = useState(false)
  const [failed, setFailed] = useState(false)
  const ask = async () => {
    setAsking(true); setFailed(false)
    try {
      await onAskAgent(canvasTargetRequest({ viewTitle, canvasId, revision, target, change: change.trim() }))
      setChange('')
    } catch {
      setFailed(true)
    } finally {
      setAsking(false)
    }
  }
  return <form className="space-y-2" aria-label="Ask the agent to change this" onSubmit={event => { event.preventDefault(); void ask() }}>
    <InputArea label="Describe a change to this" rows={3} maxLength={2000} value={change} disabled={busy || asking}
      onChange={event => setChange(event.target.value)} />
    <p className="text-xs text-kumo-subtle">The agent makes the same edits as these controls, at this revision, and publishes nothing.</p>
    <Button type="submit" disabled={busy || asking || change.trim() === ''}>Ask the agent</Button>
    {failed && <p role="alert" className="text-xs text-kumo-danger">Could not start the chat. Check your connection and try again.</p>}
  </form>
}
