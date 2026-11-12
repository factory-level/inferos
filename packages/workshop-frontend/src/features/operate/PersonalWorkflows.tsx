import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import {
  parseConsoleCommandRef, personalWorkflowRef, type PersonalWorkflow,
} from '@gadgets/workshop-shared/personal-workflow'
import type { SessionWorkspace } from './useSessionWorkspace'

/**
 * The reference a person hands their Dot to run `workflow` (FAC-134 capability 2): its own session
 * workspace and id, under the InferOps company and workspace its steps were proposed in. It names a
 * workflow and authorizes nothing: running it is a separate approval here.
 */
const referenceOf = (workflow: PersonalWorkflow, sessionWorkspaceId: string): string | null => {
  const step = workflow.steps[0] ? parseConsoleCommandRef(workflow.steps[0].reference) : null
  return step
    ? personalWorkflowRef({ company: step.company, workspace: step.workspace, sessionWorkspaceId, personalWorkflowId: workflow.id })
    : null
}

/** One personal workflow: its steps, when it expires, and its reference to copy. */
const PersonalWorkflowItem = ({ workflow, sessionWorkspaceId }: { workflow: PersonalWorkflow; sessionWorkspaceId: string }) => {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const reference = referenceOf(workflow, sessionWorkspaceId)
  const copy = async () => {
    if (!reference) return
    try {
      await navigator.clipboard.writeText(reference)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }
  return <li className="space-y-2 rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <p className="m-0 min-w-0 flex-1">
        <span className="font-medium">{workflow.title}</span>
        <span className="text-kumo-subtle">
          {' '}· {workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'} · expires {new Date(workflow.expiresAt).toLocaleString()}
        </span>
      </p>
      {reference && <Button size="sm" onClick={() => void copy()}>Copy reference</Button>}
    </div>
    <ol className="m-0 list-decimal space-y-1 pl-5 text-kumo-subtle">
      {workflow.steps.map((step, index) =>
        <li key={index}>{step.command} on console {step.consoleId}: issue {step.input.issueId} to state {step.input.toStateId}</li>)}
    </ol>
    {reference && <code className="block break-all text-xs text-kumo-subtle">{reference}</code>}
    {copied === 'copied' && <p role="status" className="m-0 text-kumo-subtle">Copied. Give it to your Dot to propose running it; you approve each run here.</p>}
    {copied === 'failed' && <p role="alert" className="m-0 text-kumo-danger">Couldn't copy it. Select the reference above instead.</p>}
  </li>
}

/**
 * The person's own personal workflows in this operate session (FAC-134 capability 2), each created
 * by their own approval of a Dot proposal and expiring. Nothing here creates or runs one: running it
 * is a Dot proposal they approve, and each step then only places a request that its console's
 * builders decide. Shows nothing while loading or when there are none.
 */
export const PersonalWorkflows = ({ workspace }: { workspace: SessionWorkspace | null }) => {
  const [attempt, setAttempt] = useState(0)
  const [shown, setShown] = useState<{ stub: SessionWorkspace['stub']; attempt: number;
    workflows: PersonalWorkflow[] | null }>()
  const stub = workspace?.stub
  useEffect(() => {
    if (!stub) return
    let cancelled = false
    stub.listPersonalWorkflows().then(
      workflows => { if (!cancelled) setShown({ stub, attempt, workflows }) },
      caught => {
        console.error('Failed to list personal workflows:', caught)
        if (!cancelled) setShown({ stub, attempt, workflows: null })
      })
    return () => { cancelled = true }
  }, [stub, attempt])
  // Only the answer for this workspace and attempt is shown: a new one never shows the last.
  const current = shown && shown.stub === stub && shown.attempt === attempt ? shown : undefined
  if (!workspace || !current) return null
  if (current.workflows === null) {
    return <section aria-label="Personal workflows" className="shrink-0 px-5 pb-3">
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
        <p className="m-0 text-kumo-danger">Couldn't load your personal workflows.</p>
        <Button size="sm" onClick={() => setAttempt(n => n + 1)}>Try again</Button>
      </div>
    </section>
  }
  if (current.workflows.length === 0) return null
  return <section aria-label="Personal workflows" className="shrink-0 space-y-2 px-5 pb-3">
    <div className="flex items-center gap-2">
      <h2 className="m-0 flex-1 text-sm font-medium">Your personal workflows</h2>
      <Button size="sm" variant="ghost" onClick={() => setAttempt(n => n + 1)}>Refresh</Button>
    </div>
    <ul className="m-0 space-y-2 p-0">
      {current.workflows.map(workflow =>
        <PersonalWorkflowItem key={workflow.id} workflow={workflow} sessionWorkspaceId={workspace.id} />)}
    </ul>
  </section>
}
