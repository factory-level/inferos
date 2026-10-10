// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { FileAtCommit, Overseer } from '@gadgets/workshop-shared/api'

// The real evaluator, which a test can make throw.
const evaluator = vi.hoisted(() => ({ throws: false }))
vi.mock('./evaluate', async importOriginal => {
  const actual = await importOriginal<typeof import('./evaluate')>()
  return { ...actual, evaluateBoundView: (...args: Parameters<typeof actual.evaluateBoundView>) => {
    if (evaluator.throws) throw new RangeError(`echo ${args[0].title}`)
    return actual.evaluateBoundView(...args)
  } }
})

import { BoundViewBuildPreview, useBoundViewSource } from './BoundViewBuildPreview'

const SPEC = JSON.stringify({ version: 1, title: 'Due soon', requirements: ['board-1', 'board-2'], root: { type: 'stack', children: [
  { type: 'count', label: 'Blocked', of: { requirement: 'board-1', collection: 'issues', where: [{ field: 'blocked', equals: true }] } },
  { type: 'list', of: { requirement: 'board-2', collection: 'issues', sort: [{ field: 'priority', dir: 'asc' }], limit: 2 }, item: [{ type: 'field', value: { field: 'title' } }], empty: 'None' },
] } })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); evaluator.throws = false })

const preview = () => container.querySelector('[aria-label="View preview"]')!

describe('BoundViewBuildPreview', () => {
  it('renders a valid view.json over the labelled sample board, in its own root', async () => {
    await act(async () => root.render(<BoundViewBuildPreview text={SPEC} />))
    await act(async () => {})
    expect(preview().textContent).toContain('Preview over a made-up sample board, not your InferOps data.')
    expect(preview().textContent).toContain('Due soon')
    expect(preview().textContent).toContain('Blocked 2')
    expect(preview().textContent).toContain('Sample: replace the staging certificate')
  })

  it('shows problem codes and paths, never values, for a view.json that does not parse', async () => {
    const text = JSON.stringify({ version: 1, title: 'Secret title', requirements: ['board-1'], root: { type: 'list', of: { requirement: 'board-9', collection: 'issues' }, item: [], empty: 'x' } })
    await act(async () => root.render(<BoundViewBuildPreview text={text} />))
    expect(preview().querySelector('[role="alert"]')?.textContent).toMatch(/unknownRequirement at \$\.root\.of\.requirement/)
    expect(preview().textContent).not.toContain('Secret title')
  })

  it('contains a throwing evaluation: the fixed failed state, nothing rendered, nothing reported', async () => {
    evaluator.throws = true
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => { errors.push(event.message) }
    window.addEventListener('error', onError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await act(async () => root.render(<BoundViewBuildPreview text={SPEC} />))
      await act(async () => {})
      expect(preview().textContent).toContain('This preview could not be shown.')
      expect(preview().textContent).not.toContain('echo')
      expect(container.querySelector<HTMLElement>('[aria-label="View preview"] > div:last-child')!.style.display).toBe('none')
      expect(errors).toEqual([])
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('error', onError)
      consoleError.mockRestore()
    }
  })

  it('replaces the preview when the text changes, and hides it when the text stops parsing', async () => {
    await act(async () => root.render(<BoundViewBuildPreview text={SPEC} />))
    await act(async () => root.render(<BoundViewBuildPreview text={SPEC.replace('Blocked', 'Stuck')} />))
    await act(async () => {})
    expect(preview().textContent).toContain('Stuck 2')
    await act(async () => root.render(<BoundViewBuildPreview text="{" />))
    expect(container.querySelector<HTMLElement>('[aria-label="View preview"] > div:last-child')!.style.display).toBe('none')
  })
})

const overseer = (file: FileAtCommit) => ({ readFilesAtCommit: vi.fn<(commitId: string, paths: string[]) => Promise<[string, FileAtCommit][]>>(
  async (_, paths) => paths.map(path => [path, file])) }) as unknown as RpcStub<Overseer>

describe('useBoundViewSource', () => {
  let found: string | null
  const Probe = ({ overseer, commitId }: { overseer: RpcStub<Overseer> | null; commitId?: string }) => { found = useBoundViewSource(overseer, commitId); return null }

  it('reads view.json at the commit, and nothing without an overseer or a commit', async () => {
    const reader = overseer({ kind: 'text', text: SPEC })
    await act(async () => root.render(<Probe overseer={reader} commitId="c1" />))
    expect(found).toBe(SPEC)
    expect(reader.readFilesAtCommit).toHaveBeenCalledWith('c1', ['view.json'])
    await act(async () => root.render(<Probe overseer={null} commitId="c1" />))
    await act(async () => root.render(<Probe overseer={reader} />))
    expect(found).toBeNull()
  })

  it('finds nothing when the commit has no view.json or it cannot be read', async () => {
    await act(async () => root.render(<Probe overseer={overseer({ kind: 'absent' })} commitId="c1" />))
    expect(found).toBeNull()
    const failing = { readFilesAtCommit: async () => { throw new Error('gone') } } as unknown as RpcStub<Overseer>
    await act(async () => root.render(<Probe overseer={failing} commitId="c2" />))
    expect(found).toBeNull()
  })
})
