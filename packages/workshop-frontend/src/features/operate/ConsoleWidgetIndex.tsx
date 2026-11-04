import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { Banner, Select } from '@cloudflare/kumo'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { WidgetIndexOutcome, WidgetIndexWorkspace } from '@gadgets/workshop-shared/gatekeeper'
import type { ConsoleWidgetIndexReport } from '@gadgets/workshop-shared/operate-console'

/** What one widget's last answer from InferOps means for the builder, in their words. */
export const widgetIndexStatus = (outcome: WidgetIndexOutcome): string =>
  outcome.status === 'applied' ? 'Listed for your company'
    : outcome.status === 'proposed' ? `Waiting in InferOps: ${outcome.reason}`
    : `Not listed: ${outcome.reason}`

/**
 * Where a console's widgets stand in the company widget index (FAC-11): the InferOps workspace they
 * are listed in, what InferOps answered for each, and any withdrawal still owed. A builder with
 * several qualifying workspaces chooses one here; the next publication writes there. Shown only
 * when the deployment has an index (the kernel answers with a report, or offers workspaces).
 */
export const ConsoleWidgetIndex = ({ overseer, consoleId, hasWidgets, editable }: {
  overseer: RpcStub<Overseer>
  consoleId: string
  /** Whether the console registers any widget: what publishing would list. */
  hasWidgets: boolean
  editable: boolean
}) => {
  const [read, setRead] = useState<{ consoleId: string; report: ConsoleWidgetIndexReport | null; workspaces: WidgetIndexWorkspace[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    Promise.all([overseer.getConsoleWidgetIndex(consoleId), overseer.listConsoleWidgetIndexWorkspaces()]).then(
      ([report, workspaces]) => { if (current) { setRead({ consoleId, report, workspaces }); setFailed(false) } },
      () => { if (current) setFailed(true) })
    return () => { current = false }
  }, [overseer, consoleId])

  const shown = read?.consoleId === consoleId ? read : null
  if (failed) return <p role="status" className="text-sm text-kumo-subtle">Couldn&apos;t read where this console&apos;s widgets are listed. Reopen settings to try again.</p>
  if (!shown || (shown.report === null && shown.workspaces.length === 0)) return null
  const { report, workspaces } = shown
  const choose = async (workspaceId: string) => {
    setSaving(true); setError(null)
    try {
      const next = await overseer.setConsoleWidgetIndexTarget(consoleId, workspaceId)
      setRead({ consoleId, report: next, workspaces })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not choose that workspace.')
    } finally { setSaving(false) }
  }
  return <section aria-labelledby="console-widget-index-heading" className="space-y-3">
    <div>
      <h2 id="console-widget-index-heading" className="text-sm font-medium text-kumo-default">Listed for your company</h2>
      <p className="mt-1 text-sm text-kumo-subtle">When you publish, each widget&apos;s name and a short purpose are listed for your company in InferOps, so people can find it. Nothing else is shared, and InferOps still decides who sees what.</p>
    </div>
    {report?.blocked && <Banner variant="alert" title={report.blocked} />}
    {workspaces.length > 1 && editable && <Select label="InferOps workspace" value={report?.target?.workspaceId ?? ''} disabled={saving}
      placeholder="Choose a workspace" renderValue={value => workspaces.find(w => w.workspaceId === value)?.name ?? 'Choose a workspace'}
      onValueChange={value => { if (value) void choose(String(value)) }}>
      {workspaces.map(w => <Select.Option key={w.workspaceId} value={w.workspaceId}>{w.name}</Select.Option>)}
    </Select>}
    {report?.target && !(workspaces.length > 1 && editable) && <p className="text-sm text-kumo-default">Listed in {report.target.name}.</p>}
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    {report && report.widgets.length > 0 && <ul className="space-y-1 text-sm">
      {report.widgets.map(widget => <li key={widget.versionId}>
        <span className="text-kumo-default">{widget.label}</span>
        <span className="text-kumo-subtle">: {widgetIndexStatus(widget.outcome)}</span>
      </li>)}
    </ul>}
    {report === null && hasWidgets && <p className="text-sm text-kumo-subtle">Not listed yet. Publishing lists this console&apos;s widgets.</p>}
    {report && report.pendingWithdraws.length > 0 && <div className="space-y-1 text-sm">
      <p className="text-kumo-default">Still to remove from the company listing (tried again when you next publish):</p>
      <ul>{report.pendingWithdraws.map(item => <li key={item.versionId} className="text-kumo-subtle">{item.versionId}: {item.reason}</li>)}</ul>
    </div>}
  </section>
}
