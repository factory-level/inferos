import { useEffect, useState } from 'react'
import { Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

export const ChatGptFallbackSettings = ({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) => {
  const [value, setValue] = useState<Awaited<ReturnType<AuthenticatedApi['getChatGptFallback']>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void authenticatedApi.getChatGptFallback().then(result => {
      if (!cancelled) setValue(result)
    }, () => { if (!cancelled) setError('Could not load API-key fallback settings.') })
    return () => { cancelled = true }
  }, [authenticatedApi])
  const select = async (modelId: string) => {
    setBusy(true)
    setError(null)
    try {
      await authenticatedApi.setChatGptFallback(modelId || null)
      setValue(await authenticatedApi.getChatGptFallback())
    } catch { setError('Could not save API-key fallback settings.') }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-2">
    <Select label="API-key fallback when ChatGPT is disconnected" value={value?.modelId ?? ''}
      placeholder="No fallback" renderValue={id => value?.models.find(model => model.id === id)?.name ?? 'No fallback'}
      disabled={busy || !value} onValueChange={id => void select(String(id))}>
      <Select.Option value="">No fallback</Select.Option>
      {value?.models.map(model => <Select.Option key={model.id} value={model.id}>{model.name}</Select.Option>)}
    </Select>
    <p className="text-sm text-kumo-subtle">The selected model charges its API key only when ChatGPT is disconnected. Usage limits and permission errors stay on ChatGPT. Add an API-key model in AI Models if none are listed.</p>
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
  </div>
}
