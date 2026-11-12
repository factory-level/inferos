// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-14: the builder's binding of a widget's declared commands. Commands come from the widget's
// commit; boards are only those this workspace's own connections resolve, so another workspace's
// connection is never offered. Each read has its loading and error states, an unbound command is
// said to be offered to no one, and a person who may not edit sees why the picker is closed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleCommandBinding } from '@gadgets/workshop-shared/operate-console'
import type { WidgetCommandDeclaration } from '@gadgets/workshop-shared/widget-tools'
import { ConsoleCommandBindings, type BoardConnection } from './ConsoleCommandBindings'

const MOVE: WidgetCommandDeclaration = { name: 'moveIssue', description: 'Ask to move an issue.', effect: 'write', command: 'inferops.issue.transition' }
const OURS = 'inferops://acme.operations/project/board/ENG'
const THEIRS = 'inferops://other.sales/project/board/SAL'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

async function show(options: {
  commands?: () => Promise<WidgetCommandDeclaration[]>
  resolve?: (target: string) => Promise<BoardConnection | null>
  bindings?: ConsoleCommandBinding[]
  editable?: boolean
  targets?: string[]
} = {}) {
  const onChange = vi.fn<(bindings: ConsoleCommandBinding[]) => void>()
  // Only this workspace's own board resolves; any other reference has no connection here.
  const resolveBoard = vi.fn<(target: string) => Promise<BoardConnection | null>>(options.resolve ?? (async (target: string) => target === OURS ? { gatekeeperId: 41, target } : null))
  act(() => {
    root.render(<ConsoleCommandBindings commitId="c0ffee" bindings={options.bindings ?? []} boardTargets={options.targets ?? [OURS, THEIRS]}
      editable={options.editable ?? true} disabled={false} loadCommands={options.commands ?? (async () => [MOVE])}
      resolveBoard={resolveBoard} onChange={onChange} />)
  })
  return { onChange, resolveBoard }
}

describe('binding a declared command (FAC-14)', () => {
  it('says it is checking while the commands load, and shows nothing for a widget that declares none', async () => {
    let finish!: (value: WidgetCommandDeclaration[]) => void
    await show({ commands: () => new Promise(resolve => { finish = resolve }) })
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/Checking this widget's commands/)
    await act(async () => { finish([]) })
    expect(container.textContent).toBe('')
  })

  it("shows a failed read in the server's words, never as no commands", async () => {
    await show({ commands: async () => { throw new Error('Commit c0ffee is unreadable.') } })
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not read this widget's commands: Commit c0ffee is unreadable.")
  })

  it("offers only boards this workspace's own connections resolve, never another workspace's", async () => {
    const { resolveBoard } = await show()
    await settle()
    expect(resolveBoard.mock.calls.map(([target]) => target)).toEqual([OURS, THEIRS])
    expect(container.textContent).toContain('moveIssue: Ask to move an issue.')
    expect(container.textContent).toContain('An unbound command is offered to no one.')
    // The other workspace's board resolved to nothing here, so no option names it.
    expect(container.innerHTML).not.toContain(THEIRS.replace('://', ''))
  })

  it("offers nothing for a board only another workspace is connected to: it says no connection was found", async () => {
    await show({ targets: [THEIRS] })
    await settle()
    expect(container.textContent).toMatch(/No InferOps board connection of this workspace was found for these boards/)
  })

  it('says when no board connection was found, and when checking the boards failed', async () => {
    await show({ resolve: async () => null })
    await settle()
    expect(container.textContent).toMatch(/No InferOps board connection of this workspace was found/)
    await show({ resolve: async () => { throw new Error('Connection lookup failed.') } })
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not check this workspace's board connections: Connection lookup failed.")
  })

  it('tells a person who may not edit that owners and editors bind commands, and offers them no board to enter', async () => {
    await show({ editable: false, bindings: [{ name: 'moveIssue', gatekeeperId: 41 }] })
    await settle()
    expect(container.textContent).toContain('Console owners and editors bind commands.')
    expect(container.textContent).not.toContain('Another board')
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Check board')).toBe(false)
  })
})
