import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { Badge, Button } from '@cloudflare/kumo'
import type { Overseer, WorkspaceReadiness as Readiness, WorkspaceReadinessItem } from '@gadgets/workshop-shared/api'

const STATUS: Record<WorkspaceReadinessItem['status'], { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  ready: { label: 'Ready', variant: 'success' },
  attention: { label: 'Needs you', variant: 'warning' },
  blocked: { label: 'Blocked', variant: 'destructive' },
}

const TITLES: Record<WorkspaceReadinessItem['name'], string> = {
  'inferops-connection': 'InferOps account',
  'records-binding': 'Records (custom table)',
  'workflow-policy-binding': 'Workflow policy',
  'published-console': 'Published console',
}

type Read = { status: 'loading' } | { status: 'error' } | { status: 'ready'; readiness: Readiness }

/**
 * This workspace's deployment readiness (FAC-144), as the server computes it now: each item, what
 * it found and what to do next. "Ready" is this workspace's InferOS side only; the company's
 * InferOps side (its people, model and flags) is checked in InferOps. A read that fails says so,
 * never an empty or ready list. Checking again asks the server again.
 */
export const WorkspaceReadiness = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    overseer.getWorkspaceReadiness().then(
      readiness => { if (current) setRead({ status: 'ready', readiness }) },
      () => { if (current) setRead({ status: 'error' }) })
    return () => { current = false }
  }, [overseer, attempt])
  const checkAgain = () => { setRead({ status: 'loading' }); setAttempt(n => n + 1) }

  return <section aria-labelledby="workspace-readiness-heading" className="space-y-3 rounded-xl border border-kumo-line p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 id="workspace-readiness-heading" className="text-sm font-medium text-kumo-default">Workspace readiness</h2>
        <p className="mt-1 text-sm text-kumo-subtle">What this workspace needs before you hand it over. Your company&apos;s people and InferOps setup are checked in InferOps.</p>
      </div>
      <Button size="sm" disabled={read.status === 'loading'} onClick={checkAgain}>Check again</Button>
    </div>
    {read.status === 'loading' && <p role="status" className="text-sm text-kumo-subtle">Checking this workspace…</p>}
    {read.status === 'error' && <p role="alert" className="text-sm text-kumo-danger">Couldn&apos;t check this workspace&apos;s readiness. Check your access, then check again.</p>}
    {read.status === 'ready' && <>
      <p role="status" className="text-sm font-medium text-kumo-default">
        {read.readiness.deploymentReady ? 'InferOS side: ready' : 'InferOS side: not ready yet'}
      </p>
      <ul className="space-y-2">
        {read.readiness.items.map(item => <li key={item.name} className="space-y-0.5 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={STATUS[item.status].variant}>{STATUS[item.status].label}</Badge>
            <span className="text-kumo-default">{TITLES[item.name]}</span>
          </div>
          <p className="text-kumo-subtle">{item.detail}</p>
          {item.action && <p className="text-kumo-default">{item.action}</p>}
        </li>)}
      </ul>
    </>}
  </section>
}
