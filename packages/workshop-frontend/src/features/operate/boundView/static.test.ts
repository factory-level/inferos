import { describe, expect, it } from 'vitest'

// Source-level guarantees the runtime tests cannot see: what bound-view code and the reused
// host-board hooks may call, and which code can put a frame or a shadow root in the page.

const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/routeTree.gen.ts'], { query: '?raw', import: 'default', eager: true })
const sharedUi = import.meta.glob<string>(['../../../../../ui/src/**/*.{ts,tsx}', '!../../../../../ui/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
const kumo = import.meta.glob<string>('/node_modules/@cloudflare/kumo/dist/**/*.js', { query: '?raw', import: 'default', eager: true })

/** Source with comments removed (roughly: enough to tell a call from a mention in a comment). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const file = (path: string) => {
  const text = sources[path]
  if (text === undefined) throw new Error(`no source ${path}`)
  return text
}

const BOUND_VIEW_FILES = Object.keys(sources).filter(path => path.startsWith('/src/features/operate/boundView/')
  || ['/src/features/operate/ConsoleBoundView.tsx', '/src/features/operate/ConsoleBoundViewRegistry.tsx'].includes(path))
const HOOKS = ['/src/features/operate/useHostBoard.ts', '/src/features/operate/useHostBoardSelection.ts', '/src/features/operate/useHostBoardAccounts.ts',
  '/src/features/operate/hostBoardState.ts']

describe('bound-view code reports nothing', () => {
  it('covers every bound-view file', () => {
    expect(BOUND_VIEW_FILES).toEqual(expect.arrayContaining(['/src/features/operate/boundView/evaluate.ts', '/src/features/operate/boundView/contain.ts',
      '/src/features/operate/boundView/frameGate.ts', '/src/features/operate/boundView/BoundViewRenderer.tsx', '/src/features/operate/boundView/useBoundViewCohort.ts',
      '/src/features/operate/ConsoleBoundView.tsx']))
  })

  it.each([...BOUND_VIEW_FILES, ...HOOKS])('%s has no console call, logRpcFailure, reportIssue, or reporting import', path => {
    const source = code(file(path))
    // The global `console`, not a property named console (`target.console.revision`).
    expect(source).not.toMatch(/(?<![.\w$])console\s*\./)
    expect(source).not.toMatch(/\blogRpcFailure\b/)
    expect(source).not.toMatch(/\breportIssue\b/)
    expect(source).not.toMatch(/from\s+['"][^'"]*(rpcErrors|errorReporting)['"]/)
    expect(source).not.toMatch(/dangerouslySetInnerHTML/)
  })
})

describe('bound-view code reaches no network, storage or history sink', () => {
  // The global or `window.` form of each, not a method of the same name on an RPC stub.
  const SINKS: [string, RegExp][] = [
    ['fetch', /(?<![.\w$])(?:window\s*\.\s*)?fetch\s*\(/],
    ['sendBeacon', /\bsendBeacon\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bWebSocket\b/],
    ['EventSource', /\bEventSource\b/],
    // `window.open` itself, or `open` destructured from the window (`const { open } = window`), so a
    // local function or prop named `open` is not taken for it.
    ['window.open', /\b(?:window|globalThis|self)\s*\.\s*open\b/],
    ['destructured open', /\{[^}]*\bopen\b[^}]*\}\s*=\s*(?:window|globalThis|self)\b/],
    ['new Image', /\bnew\s+Image\b/],
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['indexedDB', /\bindexedDB\b/],
    ['document.cookie', /\bdocument\s*\.\s*cookie\b/],
    ['pushState', /\bpushState\b/],
    ['replaceState', /\breplaceState\b/],
  ]
  it.each([...BOUND_VIEW_FILES, ...HOOKS])('%s', path => {
    const source = code(file(path))
    expect(SINKS.filter(([, sink]) => sink.test(source)).map(([name]) => name)).toEqual([])
  })

  it('would catch each sink', () => {
    const samples: Record<string, string> = { 'window.open': 'window.open(url)', 'destructured open': 'const { open, close } = window',
      'new Image': 'new Image()', fetch: 'fetch(url)', 'document.cookie': 'document.cookie' }
    const missed = SINKS.filter(([name, sink]) => !sink.test(samples[name] ?? `${name}.x`)).map(([name]) => name)
    expect(missed).toEqual([])
    // A local `open` is not a sink.
    const local = 'const open = () => {}; open(); onOpenChange={open => { if (!open) onClose() }}; dialog.open(x)'
    expect(SINKS.filter(([, sink]) => sink.test(local)).map(([name]) => name)).toEqual([])
  })
})

describe('frames and shadow roots', () => {
  const FRAME = /(?:^|[\s({,>])<(?:iframe|frame|object|embed|fencedframe)[\s/>]|createElement\(\s*['"`](?:iframe|frame|object|embed|fencedframe)['"`]/
  it('has exactly the three known frame producers in the frontend and shared UI', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100)
    expect(Object.keys(sharedUi).length).toBeGreaterThan(0)
    const producers = Object.entries({ ...sources, ...sharedUi }).filter(([, text]) => FRAME.test(code(text))).map(([path]) => path).toSorted()
    expect(producers).toEqual(['/src/GadgetUI.tsx', '/src/SandboxedGatekeeperApp.tsx', '/src/SandboxedResourceConfigurator.tsx'])
  })

  it('creates no shadow root anywhere in the frontend, shared UI or Kumo, outside comments', () => {
    expect(Object.keys(kumo).length).toBeGreaterThan(10)
    const callers = Object.entries({ ...sources, ...sharedUi, ...kumo }).filter(([, text]) => /attachShadow/.test(code(text))).map(([path]) => path)
    expect(callers).toEqual([])
  })

  it('keeps the host\'s message listeners to the three audited ones, and bound views add none', () => {
    const listeners = Object.entries(sources).filter(([, text]) => /addEventListener\(\s*['"]message['"]/.test(code(text))).map(([path]) => path).toSorted()
    expect(listeners).toEqual(['/src/GadgetUI.tsx', '/src/SandboxedGatekeeperApp.tsx', '/src/SandboxedResourceConfigurator.tsx'])
  })
})
