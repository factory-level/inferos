import { useEffect, useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { CANVAS_WIKI_REF, type CanvasDataBinding, type CanvasWidget } from '@gadgets/workshop-shared/canvas'
import { useBoardData } from './useBoardData'
import { useWikiData } from './useWikiData'

type Resource = CanvasDataBinding['resource']
const RESOURCE_FOR_WIDGET = {
  'inferops.project-board': 'project/board',
  'inferops.wiki': 'knowledge/wiki',
} as const
const RESOURCE_LABEL: Record<Resource, string> = {
  'project/board': 'InferOps project board',
  'knowledge/wiki': 'InferMind Wiki',
}

const BindingProbe = ({ overseer, widget, resource, refValue, onResult }: {
  overseer: RpcStub<Overseer>
  widget: Extract<CanvasWidget, { kind: 'inferops.project-board' | 'inferops.wiki' }>
  resource: Resource
  refValue: string
  onResult: (result: 'checking' | 'allowed' | 'forbidden' | 'unavailable') => void
}) => {
  if (resource === 'project/board') return <BoardProbe overseer={overseer} widget={widget as Extract<CanvasWidget, {kind:'inferops.project-board'}>} refValue={refValue} onResult={onResult} />
  return <WikiProbe overseer={overseer} refValue={refValue} onResult={onResult} />
}

const BoardProbe = ({ overseer, widget, refValue, onResult }: {
  overseer: RpcStub<Overseer>
  widget: Extract<CanvasWidget, {kind:'inferops.project-board'}>
  refValue: string
  onResult: (result: 'checking' | 'allowed' | 'forbidden' | 'unavailable') => void
}) => {
  const { state } = useBoardData(overseer, { ...widget, targetRef: refValue })
  const result = state.status === 'ready' || state.status === 'stale' ? 'allowed'
    : state.status === 'error' && ['FORBIDDEN', 'UNAUTHORIZED'].includes(state.code) ? 'forbidden'
      : state.status === 'loading' ? 'checking' : 'unavailable'
  useEffect(() => onResult(result), [onResult, result])
  return null
}

const WikiProbe = ({ overseer, refValue, onResult }: {
  overseer: RpcStub<Overseer>
  refValue: string
  onResult: (result: 'checking' | 'allowed' | 'forbidden' | 'unavailable') => void
}) => {
  const { snapshot } = useWikiData(overseer, refValue)
  const state = snapshot.list
  const result = state.status === 'ready' ? 'allowed'
    : state.status === 'error' && ['FORBIDDEN', 'UNAUTHORIZED'].includes(state.code) ? 'forbidden'
      : state.status === 'loading' ? 'checking' : 'unavailable'
  useEffect(() => onResult(result), [onResult, result])
  return null
}

/** Configure and verify a typed read source using the same read adapter as its renderer. */
export const CanvasDataBindingEditor = ({ widget, overseer, busy, onSave }: {
  widget: Extract<CanvasWidget, {kind:'inferops.project-board' | 'inferops.wiki'}>
  overseer: RpcStub<Overseer>
  busy: boolean
  onSave: (widget: CanvasWidget) => void
}) => {
  const expected = RESOURCE_FOR_WIDGET[widget.kind]
  const [resource, setResource] = useState<Resource>(widget.dataBinding?.resource ?? expected)
  const [refValue, setRefValue] = useState(widget.dataBinding?.ref ?? widget.targetRef)
  const [candidate, setCandidate] = useState<{resource: Resource; ref: string} | null>(null)
  const [result, setResult] = useState<'checking' | 'allowed' | 'forbidden' | 'unavailable' | 'incompatible' | null>(null)
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCandidate(null)
    if (resource !== expected) { setResult('incompatible'); return }
    const ref = refValue.trim()
    if (!ref || (resource === 'knowledge/wiki' && !CANVAS_WIKI_REF.test(ref)) ||
      (resource === 'project/board' && !/^inferops:\/\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/project\/board\/[A-Za-z0-9._~-]+$/.test(ref))) {
      setResult('unavailable'); return
    }
    setRefValue(ref)
    setCandidate({ resource, ref })
    setResult('checking')
  }
  const messages = {
    incompatible: 'This resource type cannot be bound to this widget.',
    unavailable: 'This resource is unavailable.',
    forbidden: 'You do not have read access to this resource.',
  }
  return <section className="space-y-2" aria-label="Read data binding">
    <h5 className="font-medium text-kumo-default">Read data source</h5>
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <Select label="Resource type" value={resource} onValueChange={value => { setResource(value as Resource); setCandidate(null); setResult(null) }} disabled={busy}>
        <Select.Option value="project/board">{RESOURCE_LABEL['project/board']}</Select.Option>
        <Select.Option value="knowledge/wiki">{RESOURCE_LABEL['knowledge/wiki']}</Select.Option>
      </Select>
      <Input label="Resource reference" value={refValue} onChange={event => { setRefValue(event.currentTarget.value); setCandidate(null); setResult(null) }} required maxLength={512} disabled={busy} className="min-w-0 flex-1" />
      <Button type="submit" disabled={busy}>Check read access</Button>
    </form>
    {candidate && result === 'checking' && <BindingProbe overseer={overseer} widget={widget} resource={candidate.resource} refValue={candidate.ref} onResult={setResult} />}
    {result && result !== 'checking' && <p role="status" className="text-sm text-kumo-subtle">{result === 'allowed' ? 'Read access confirmed.' : messages[result]}</p>}
    {candidate && result === 'allowed' && <Button size="sm" disabled={busy} onClick={() => onSave({ ...widget, targetRef: candidate.ref, dataBinding: { resource: candidate.resource, ref: candidate.ref, schemaVersion: 1 } })}>Use this read binding</Button>}
    <p className="text-xs text-kumo-subtle">A read binding identifies data. It does not grant write or workflow capabilities.</p>
  </section>
}
