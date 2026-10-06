import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button, Textarea } from '@cloudflare/kumo'
import { publicationErrorMessage } from './publicationText'

type Props = {
  /** The confirming button's label, e.g. "Withdraw" or "Refuse". */
  actionLabel: string
  onWithdraw: (reason: string) => Promise<void>
  onCancel: () => void
}

/**
 * Asks for the reason a publication is withdrawn (or a request refused) and states what withdrawal
 * cannot undo. Takes focus when it opens; Escape cancels.
 */
export const WithdrawPublicationForm = ({ actionLabel, onWithdraw, onCancel }: Props) => {
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { reasonRef.current?.focus() }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onWithdraw(reason.trim())
    } catch (err) {
      setError(publicationErrorMessage(err, `${actionLabel} failed.`))
      setPending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !pending) {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <form onSubmit={submit} onKeyDown={onKeyDown} className="mt-3 space-y-2">
      <Textarea
        ref={reasonRef}
        label="Reason"
        value={reason}
        onValueChange={setReason}
        rows={2}
        maxLength={1000}
        disabled={pending}
        description="Stops new reach at once. Copies people already made, and archives already downloaded, are not affected."
      />
      {error && <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" size="sm" disabled={pending}>
          {pending ? `${actionLabel}…` : actionLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
