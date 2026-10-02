import { useState } from 'react'
import { Button, Checkbox, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { openDisownedPopup, uniquePopupName } from '../../connectHandoff'
import { useChatGptPlugin } from './useChatGptPlugin'
import { ChatGptFallbackSettings } from './ChatGptFallbackSettings'

export const ChatGptSettings = ({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) => {
  const { api, state, status, refresh, error: connectionError } = useChatGptPlugin(authenticatedApi)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const account = state?.accounts.find(value => value.id === state.activeAccountId)
  if (status === 'disabled') return null
  if (!api) return <section aria-label="ChatGPT plan usage" className="flex flex-col gap-3">
    <h2 className="text-sm font-semibold text-kumo-default">ChatGPT plan usage</h2>
    {connectionError ? <>
      <p role="alert" className="text-sm text-kumo-danger">{connectionError}</p>
      <Button onClick={() => void refresh()}>Retry connection</Button>
    </> : <p role="status" className="text-sm text-kumo-subtle">Loading ChatGPT connection…</p>}
  </section>

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await action() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'ChatGPT connection failed.') }
    finally { await refresh(); setBusy(false) }
  }
  const signIn = (id?: string, consent?: boolean) => run(async () => {
    const flow = await api.startSignIn(id, consent)
    openDisownedPopup(flow.url, uniquePopupName('inferos-chatgpt'), { kind: 'openai', nonce: flow.nonce })
  })
  const accountError = account?.error
  const failure = error ?? connectionError ?? accountError?.message ?? state?.error?.message
  const detail = accountError ?? state?.error

  return <section aria-label="ChatGPT plan usage" className="flex flex-col gap-3">
    <h2 className="text-sm font-semibold text-kumo-default">ChatGPT plan usage</h2>
    <div className="flex flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
      <p className="text-sm text-kumo-subtle">Use your connected ChatGPT allowance for models you explicitly select. You can choose an API-key fallback for when ChatGPT is disconnected.</p>
      <p className="text-sm text-kumo-subtle">Plus has a 5-hour limit shared across apps, including Codex. Pro has no 5-hour limit. Heavy agent runs consume the same allowance.</p>
      {state?.needsWelcome && <div role="status" className="flex flex-col gap-2">
        <p>ChatGPT is connected. Add a ChatGPT plan model to start using your allowance.</p>
        <Button disabled={busy} onClick={() => void run(() => api.acknowledgeWelcome())}>Got it</Button>
      </div>}
      {state && state.accounts.length > 0 && <Select label="Active ChatGPT account"
        renderValue={id => { const selected = state.accounts.find(value => value.id === id); return selected ? `${selected.label} · ${selected.status}` : String(id) }}
        value={state.activeAccountId} disabled={busy}
        onValueChange={value => void run(() => api.selectAccount(String(value)))}>
        {state.accounts.map(value => <Select.Option key={value.id} value={value.id}>
          {value.label} · {value.status}
        </Select.Option>)}
      </Select>}
      {failure && <p role="alert" className="text-sm text-kumo-danger">{failure}</p>}
      {detail?.requestId && <p className="text-xs text-kumo-subtle">Request: {detail.requestId} · {detail.code}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void signIn(account?.id)}>Continue with ChatGPT</Button>
        {account && <Button disabled={busy} onClick={() => void signIn()}>Add account</Button>}
        {(account?.status === 'plan-disabled' || accountError?.recovery === 'consent' || (!account && state?.error?.recovery === 'consent')) && <Button disabled={busy} onClick={() => void signIn(account?.id, true)}>Enable plan usage</Button>}
        {account?.status === 'usage-paused' && <Button disabled={busy} onClick={() => void run(() => api.retryPlanUsage(account.id))}>Retry plan usage</Button>}
        {account && account.status !== 'signed-out' && <Button disabled={busy} onClick={() => void run(() => api.signOut(account.id))}>Sign out of ChatGPT</Button>}
      </div>
      {account && <Checkbox label="Allow background and autonomous runs to use this ChatGPT plan"
        checked={account.allowBackground} disabled={busy}
        onCheckedChange={allowed => void run(() => api.setBackgroundUsage(account.id, allowed === true))} />}
      <a className="text-sm underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">ChatGPT Settings → Usage</a>
      <ChatGptFallbackSettings authenticatedApi={authenticatedApi} />
      <p className="text-xs text-kumo-subtle">Sign-out revokes the session and clears local tokens. To remove the app connection completely, disconnect InferOS in ChatGPT Settings.</p>
    </div>
  </section>
}
