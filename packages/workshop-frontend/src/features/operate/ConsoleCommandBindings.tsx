import { useEffect, useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import { canonicalHostBoardTarget, type ConsoleCommandBinding } from '@gadgets/workshop-shared/operate-console'
import type { WidgetCommandDeclaration } from '@gadgets/workshop-shared/widget-tools'

/** One of this workspace's own InferOps board connections, as `resolveBoard` found it. */
export type BoardConnection = { gatekeeperId: number; target: string }

/** Where a list the picker needs stands. A failure is never shown as an empty list. */
type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T }

const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : 'It could not be read.'

/**
 * The builder's bindings of one registered widget's declared commands (FAC-14), each to one of this
 * workspace's own InferOps board connections. The commands come from the widget's commit
 * (`loadCommands`). The boards are the console's host board targets plus any the builder enters,
 * each resolved through this workspace's own connections (`resolveBoard`), so another workspace's
 * connection can never be offered. A binding grants nothing until publication checks it, and a
 * refusal there is shown in the server's words by the publish dialog.
 */
export const ConsoleCommandBindings = ({ commitId, bindings, boardTargets, editable, disabled, loadCommands, resolveBoard, onChange }: {
  /** The commit the registered install runs now; null while the kernel hasn't said. */
  commitId: string | null
  bindings: ConsoleCommandBinding[]
  /** Board references the console already uses (its host boards). */
  boardTargets: string[]
  /** Whether this person may edit the console's settings. */
  editable: boolean
  disabled: boolean
  loadCommands: (commitId: string) => Promise<WidgetCommandDeclaration[]>
  resolveBoard: (target: string) => Promise<BoardConnection | null>
  onChange: (bindings: ConsoleCommandBinding[]) => void
}) => {
  const [commands, setCommands] = useState<Loaded<WidgetCommandDeclaration[]>>({ state: 'loading' })
  const [entered, setEntered] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [boards, setBoards] = useState<Loaded<BoardConnection[]>>({ state: 'loading' })
  const targets = [...new Set([...boardTargets, ...entered])]
  const targetsKey = targets.join('\n')

  useEffect(() => {
    if (!commitId) return
    let current = true
    setCommands({ state: 'loading' })
    loadCommands(commitId).then(
      value => { if (current) setCommands({ state: 'ready', value }) },
      error => { if (current) setCommands({ state: 'error', message: messageOf(error) }) })
    return () => { current = false }
  }, [commitId, loadCommands])

  useEffect(() => {
    let current = true
    setBoards({ state: 'loading' })
    Promise.all(targetsKey ? targetsKey.split('\n').map(resolveBoard) : []).then(
      found => { if (current) setBoards({ state: 'ready', value: found.filter((board): board is BoardConnection => board !== null) }) },
      error => { if (current) setBoards({ state: 'error', message: messageOf(error) }) })
    return () => { current = false }
  }, [targetsKey, resolveBoard])

  if (!commitId || commands.state === 'loading') {
    return <p role="status" className="text-xs text-kumo-subtle">Checking this widget's commands…</p>
  }
  if (commands.state === 'error') {
    return <p role="alert" className="text-xs text-kumo-danger">Could not read this widget's commands: {commands.message}</p>
  }
  if (commands.value.length === 0) return null

  const bind = (name: string, gatekeeperId: number | null) => onChange([
    ...bindings.filter(binding => binding.name !== name),
    ...(gatekeeperId === null ? [] : [{ name, gatekeeperId }]),
  ])
  const enter = () => {
    const target = canonicalHostBoardTarget(draft)
    if (!target) return
    setEntered([...entered, target]); setDraft('')
  }
  const usable = boards.state === 'ready' ? boards.value : []

  return <div className="mt-2 space-y-2 rounded-lg border border-kumo-line p-3">
    <p className="text-xs font-medium text-kumo-default">Commands the operate agent may request</p>
    <p className="text-xs text-kumo-subtle">Each runs only on the board you bind it to, and only when a person approves the request. An unbound command is offered to no one.</p>
    {!editable && <p role="status" className="text-xs text-kumo-subtle">Console owners and editors bind commands.</p>}
    {boards.state === 'loading' && <p role="status" className="text-xs text-kumo-subtle">Checking this workspace's board connections…</p>}
    {boards.state === 'error' && <p role="alert" className="text-xs text-kumo-danger">Could not check this workspace's board connections: {boards.message}</p>}
    {boards.state === 'ready' && usable.length === 0 && <p className="text-xs text-kumo-subtle">
      No InferOps board connection of this workspace was found{targets.length > 0 ? ' for these boards' : ''}. Enter a board this workspace is connected to.
    </p>}
    <ul aria-label="Declared commands" className="space-y-2">
      {commands.value.map(command => {
        const bound = bindings.find(binding => binding.name === command.name)
        return <li key={command.name} className="space-y-1">
          <Select label={`${command.name}: ${command.description}`} disabled={!editable || disabled || boards.state !== 'ready'}
            value={bound ? String(bound.gatekeeperId) : ''} placeholder="Not bound"
            renderValue={value => usable.find(board => String(board.gatekeeperId) === value)?.target
              ?? (value ? `Connection ${value} (checked when you publish)` : 'Not bound')}
            onValueChange={value => bind(command.name, value ? Number(value) : null)}>
            <Select.Option value="">Not bound</Select.Option>
            {usable.map(board => <Select.Option key={board.gatekeeperId} value={String(board.gatekeeperId)}>{board.target}</Select.Option>)}
          </Select>
        </li>
      })}
    </ul>
    {editable && <div className="flex flex-wrap items-end gap-2">
      <Input label="Another board" value={draft} placeholder="inferops://tenant.workspace/project/board/KEY"
        disabled={disabled} onChange={event => setDraft(event.target.value)} />
      <Button size="sm" variant="secondary" disabled={disabled || !canonicalHostBoardTarget(draft)} onClick={enter}>Check board</Button>
    </div>}
  </div>
}
