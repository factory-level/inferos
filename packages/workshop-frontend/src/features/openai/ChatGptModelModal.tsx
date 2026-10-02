import { useEffect, useState } from 'react'
import { Button, Dialog, Input, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { OpenAiPlanModel } from '@gadgets/workshop-shared/openai-plugin'
import type { ModelModalMode } from '../../AddModelModal'
import { useChatGptPlugin } from './useChatGptPlugin'

export const ChatGptModelModal = ({ authenticatedApi, visible, mode, onCancel, onSuccess }: {
  authenticatedApi: RpcStub<AuthenticatedApi>; visible: boolean; mode: ModelModalMode
  onCancel: () => void; onSuccess: () => void
}) => {
  const source = mode.type === 'add' ? null : mode.source
  const config = source?.config.billing === 'chatgpt-plan' ? source.config : null
  const editing = mode.type === 'edit'
  const { api, state, status, error: connectionError } = useChatGptPlugin(authenticatedApi)
  const [accountId, setAccountId] = useState(config?.registrationId ?? '')
  const selectedAccount = accountId || state?.activeAccountId || ''
  const [catalog, setCatalog] = useState<{ accountId: string; models: OpenAiPlanModel[] } | null>(null)
  const [model, setModel] = useState(config?.model ?? '')
  const [name, setName] = useState(source?.profile.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const accountReady = state?.accounts.some(account => account.id === selectedAccount && account.status === 'ready') ?? false
  const models = status === 'ready' && accountReady && catalog?.accountId === selectedAccount ? catalog.models : []
  useEffect(() => {
    if (!api || !selectedAccount || !accountReady || !visible) return
    let cancelled = false
    setCatalog(null)
    void api.listModels(selectedAccount).then(value => {
      if (!cancelled) { setCatalog({ accountId: selectedAccount, models: value }); setError(null) }
    }, () => { if (!cancelled) setError('Connect this account and enable plan usage in Settings.') })
    return () => { cancelled = true }
  }, [api, selectedAccount, accountReady, visible])
  const save = async () => {
    setBusy(true); setError(null)
    try {
      const selected = models.find(value => value.slug === model)
      if (!selected) throw new Error('Choose an available ChatGPT model.')
      const profile = { type: 'agent' as const, id: editing ? source!.profile.id : 'chatgpt:' + crypto.randomUUID(),
        name: name.trim() || selected.displayName }
      const next = { billing: 'chatgpt-plan' as const, provider: 'openai' as const, model,
        registrationId: selectedAccount, ...(config ? { contextWindow: config.contextWindow, outputLimit: config.outputLimit } : {}) }
      if (editing) await authenticatedApi.updateModel(profile, next)
      else await authenticatedApi.addModel(profile, next)
      onSuccess()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the model.') }
    finally { setBusy(false) }
  }
  return <Dialog.Root open={visible} onOpenChange={open => { if (!open) onCancel() }}>
    <Dialog className="responsive-dialog space-y-4 p-6" size="lg">
      <Dialog.Title>ChatGPT plan model</Dialog.Title>
      <p className="text-sm text-kumo-subtle">Inference uses this account’s ChatGPT allowance. Background runs require a separate opt-in in Settings.</p>
      {status === 'loading' && <p role="status">Loading ChatGPT connection…</p>}
      {status === 'ready' && !state?.accounts.some(account => account.status === 'ready') && <p>Connect ChatGPT in Settings first, or cancel and configure an API-key model.</p>}
      {editing && models.length > 0 && !models.some(value => value.slug === model) && <p role="alert">This model is unavailable for the selected account. Choose another account or add a different model.</p>}
      <Select label="ChatGPT account" value={selectedAccount || null} disabled={busy}
        renderValue={id => state?.accounts.find(account => account.id === id)?.label ?? String(id)}
        onValueChange={value => { setAccountId(String(value)); if (!editing) setModel('') }}>
        {state?.accounts.filter(account => account.status === 'ready').map(account =>
          <Select.Option key={account.id} value={account.id}>{account.label}</Select.Option>)}
      </Select>
      <Select label="ChatGPT model" value={model || null} disabled={busy || editing}
        renderValue={id => models.find(value => value.slug === id)?.displayName ?? String(id)}
        onValueChange={value => setModel(String(value))}>
        {models.map(value => <Select.Option key={value.slug} value={value.slug}>{value.displayName}</Select.Option>)}
      </Select>
      <Input label="Display name" value={name} onChange={event => setName(event.target.value)} />
      {(error || connectionError) && <p role="alert" className="text-sm text-kumo-danger">{error || connectionError}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button disabled={busy || !models.some(value => value.slug === model)} onClick={() => void save()}>{editing ? 'Save Changes' : 'Add Model'}</Button>
      </div>
    </Dialog>
  </Dialog.Root>
}
