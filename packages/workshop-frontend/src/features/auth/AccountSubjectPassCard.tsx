import { useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { Banner, Button, Loader } from '@cloudflare/kumo'
import type { AccountSubjectPass, AdminApi } from '@gadgets/workshop-shared/api'

type Props = { admin: RpcStub<AdminApi> }

type PassState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'running' }
  | { kind: 'done'; pass: AccountSubjectPass }
  | { kind: 'error'; message: string }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The one-off subject pass (ADR 0019, FAC-165) for a deployment admin: it binds each email-keyed
 * account whose own InferOps connection vouches its address to the InferOps person behind it, so an
 * email change later keeps the account. Binding can't be undone here, so it takes a second, explicit
 * step. The server decides everything (which accounts bind, and which are left as they are); this
 * shows its counts.
 */
export const AccountSubjectPassCard = ({ admin }: Props) => {
  const [state, setState] = useState<PassState>({ kind: 'idle' })
  const startRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const confirm = () => {
    setState({ kind: 'confirming' })
    // The confirm button replaces nothing the person was on, so focus moves to it explicitly.
    requestAnimationFrame(() => confirmRef.current?.focus())
  }

  const cancel = () => {
    setState({ kind: 'idle' })
    requestAnimationFrame(() => startRef.current?.focus())
  }

  const run = async () => {
    setState({ kind: 'running' })
    try {
      setState({ kind: 'done', pass: await admin.bindAccountSubjects() })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error && err.message ? err.message : 'The pass did not finish.' })
    }
  }

  return (
    <section aria-labelledby="account-subject-pass-title" className="rounded-xl bg-kumo-elevated p-6">
      <h2 id="account-subject-pass-title" className="mb-1 text-[16px] leading-6 font-semibold text-kumo-default">
        Keep accounts across email changes
      </h2>
      <p className="mb-5 text-[14px] leading-5 text-kumo-subtle">
        Binds each account made with an email address to the InferOps person whose own connection
        vouches for that address, so the person keeps the account if their email changes. It
        creates no account, and running it again binds nothing new. A bound account signs in only
        through InferOps from then on.
      </p>

      {state.kind === 'confirming' ? (
        <div className="space-y-3">
          <p className="text-[14px] leading-5 text-kumo-default">
            Binding can't be undone here. Each account it binds stops accepting email sign-in and is
            reached only through its InferOps person.
          </p>
          <div className="flex gap-2">
            <Button ref={confirmRef} variant="primary" onClick={run}>Bind accounts</Button>
            <Button variant="secondary" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button ref={startRef} variant="secondary" onClick={confirm} disabled={state.kind === 'running'}>
          {state.kind === 'done' || state.kind === 'error' ? 'Run the pass again…' : 'Bind accounts…'}
        </Button>
      )}

      <div role="status" aria-live="polite" className="mt-4 text-[14px] leading-5">
        {state.kind === 'running' && (
          <span className="flex items-center gap-2 text-kumo-subtle"><Loader size="sm" /> Binding accounts…</span>
        )}
        {state.kind === 'done' && <PassResult pass={state.pass} />}
      </div>
      {state.kind === 'error' && (
        <Banner className="mt-4" variant="error" title="The pass did not finish" description={state.message} />
      )}
    </section>
  )
}

/** What one pass did, in counts; nothing names an account. */
const PassResult = ({ pass }: { pass: AccountSubjectPass }) => {
  if (pass.checked === 0) {
    return <p className="text-kumo-default">No account made with an email address was found, so nothing was bound.</p>
  }
  return (
    <div className="space-y-1 text-kumo-default">
      <p>
        Checked {plural(pass.checked, 'account', 'accounts')}: bound {pass.bound}, already bound {pass.alreadyBound}.
      </p>
      {pass.bound + pass.alreadyBound + pass.conflicts === 0 && (
        <p className="text-kumo-subtle">None holds an InferOps connection that vouches for its own address.</p>
      )}
      {pass.conflicts > 0 && (
        <p className="text-kumo-subtle">
          {plural(pass.conflicts, 'account was', 'accounts were')} left unbound: the InferOps person
          already signs in to another account here. They still sign in by email address.
        </p>
      )}
    </div>
  )
}
