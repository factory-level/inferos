import { useState } from 'react'
import { Popover, Radio } from '@cloudflare/kumo'
import { CaretDownIcon } from '@phosphor-icons/react'
import { WORKSPACE_KINDS, type WorkspaceKind } from '@gadgets/workshop-shared/api'
import { WORKSPACE_KIND_PRESENTATION } from './workspaceKinds'

type Props = {
  kind: WorkspaceKind
  onSetKind: (kind: WorkspaceKind) => Promise<void>
}

/**
 * The workspace kind, as a header button that opens a chooser. Choosing a kind only stages it: the
 * switch happens when the user confirms, after reading what it changes. The displayed kind is the
 * caller's (live metadata); this component never keeps its own copy of it.
 */
export const WorkspaceKindSwitch = ({ kind, onSetKind }: Props) => {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<WorkspaceKind>(kind)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = WORKSPACE_KIND_PRESENTATION[kind]
  const target = WORKSPACE_KIND_PRESENTATION[chosen]
  const changing = chosen !== kind

  const handleOpenChange = (nextOpen: boolean) => {
    if (saving) return
    if (nextOpen) {
      setChosen(kind)
      setError(null)
    }
    setOpen(nextOpen)
  }

  const handleConfirm = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSetKind(chosen)
      setOpen(false)
    } catch {
      setError(`Couldn't switch to ${target.label}. Try again.`)
    } finally {
      setSaving(false)
    }
  }

  const CurrentIcon = current.icon

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={`Workspace kind: ${current.label}. Change kind`}
            className="inline-flex h-7 flex-shrink-0 cursor-pointer items-center gap-1 rounded-md border border-kumo-line px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            <CurrentIcon size={14} aria-hidden="true" />
            <span className="hidden sm:inline">{current.label}</span>
            <CaretDownIcon size={10} aria-hidden="true" className="text-kumo-subtle" />
          </button>
        }
      />
      <Popover.Content
        align="start"
        side="bottom"
        sideOffset={8}
        positionMethod="fixed"
        className="themed-floating-shadow !z-[1100] !w-[min(380px,calc(100vw-24px))] !min-w-0 overflow-hidden rounded-xl border border-kumo-line bg-kumo-elevated !p-0 !outline-none [&>:first-child]:hidden"
      >
        <div className="px-3.5 pb-3 pt-3">
          <Popover.Title className="text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
            Workspace kind
          </Popover.Title>
          <Popover.Description className="mt-0.5 text-[11.5px] leading-4 tracking-[-0.15px] text-kumo-subtle">
            The kind decides exactly how this workspace runs and where it appears. It never
            changes on its own.
          </Popover.Description>
          <Radio.Group
            value={chosen}
            onValueChange={value => setChosen(value as WorkspaceKind)}
            appearance="card"
            disabled={saving}
            className="mt-3"
          >
            <Radio.Legend className="sr-only">Workspace kind</Radio.Legend>
            {WORKSPACE_KINDS.map(option => {
              const presentation = WORKSPACE_KIND_PRESENTATION[option]
              const OptionIcon = presentation.icon
              return (
                <Radio.Item
                  key={option}
                  value={option}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <OptionIcon size={14} aria-hidden="true" />
                      {presentation.label}
                    </span>
                  }
                  description={
                    <>
                      <span className="block">{presentation.description}</span>
                      <span className="mt-0.5 block text-kumo-inactive">
                        In Operate: {presentation.operate}
                      </span>
                    </>
                  }
                />
              )
            })}
          </Radio.Group>
          {changing && (
            <p className="mt-3 rounded-lg bg-kumo-warning-tint px-2.5 py-2 text-[11.5px] leading-4 tracking-[-0.15px] text-kumo-default">
              {target.switchConsequence}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[11.5px] leading-4 text-kumo-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-0.5 border-t border-kumo-line px-2 py-1.5">
          <button
            type="button"
            disabled={saving}
            onClick={() => handleOpenChange(false)}
            className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-inactive transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!changing || saving}
            onClick={handleConfirm}
            className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-default transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Switching…' : changing ? `Switch to ${target.label}` : 'Switch kind'}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  )
}
