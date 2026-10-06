// Demo mode entry point (`pnpm views demo`, i.e. VITE_DEMO=true). main.tsx loads this instead of
// opening the backend WebSocket: the app talks Cap'n Web over a MessageChannel to fixture targets
// in the same page, so every screen renders with no Workers, login or setup.

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { newMessagePortRpcSession, type RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { demoTarget } from './registry'
import { getScenario, type DemoStep } from './scenarios'
import { world } from './world'
import { DEMO_TOKEN } from './areas/core'
import './areas'
import views from '../../views.json'
import DemoPicker from './DemoPicker'

const SCENARIO_KEY = 'demo-scenario'

/** The registry entry for a view id, as `pnpm views` reads it. */
export type DemoView = (typeof views.views)[number]

export function findView(id: string): DemoView | undefined {
  return views.views.find(view => view.id === id)
}

/** The path a view opens on by default: its route with the world's default params. */
export function defaultPath(view: DemoView): string {
  if (view.route === '*' || view.route === '__root') return '/'
  return view.route
    .split('/')
    .map(segment => {
      const bare = segment.replace(/_$/, '')
      return bare.startsWith('$') ? encodeURIComponent(world.defaultParams[bare.slice(1)] ?? 'demo') : bare
    })
    .join('/')
}

/** The selected scenario id: `?demo=<id>` selects one (and opens its path); it then persists for the tab. */
export function activeScenarioId(): string | null {
  return sessionStorage.getItem(SCENARIO_KEY)
}

/**
 * Applies the selected scenario and returns the RPC stub the app uses in place of the WebSocket.
 * Must run before the router is created, since it may rewrite the URL.
 */
export function connectDemo(): RpcStub<PublicApi> {
  const url = new URL(window.location.href)
  const requested = url.searchParams.get('demo')
  if (requested !== null) {
    if (requested) sessionStorage.setItem(SCENARIO_KEY, requested)
    else sessionStorage.removeItem(SCENARIO_KEY)
  }
  const id = activeScenarioId()
  const view = id ? findView(id) : undefined
  const entry = id ? getScenario(id) : undefined
  if (id && !view) console.warn(`[demo] no view "${id}" in views.json`)

  for (const [key, value] of Object.entries(entry?.localStorage ?? {})) localStorage.setItem(key, value)
  entry?.setup?.(world)
  if (world.signedIn) localStorage.setItem('authToken', DEMO_TOKEN)
  else localStorage.removeItem('authToken')

  if (requested !== null) {
    url.searchParams.delete('demo')
    const path = entry?.path ?? (view ? defaultPath(view) : `${url.pathname}${url.search}`)
    history.replaceState(null, '', new URL(path, url.origin))
    if (entry?.steps?.length) void runSteps(entry.steps)
  }

  mountPicker()
  const channel = new MessageChannel()
  newMessagePortRpcSession(channel.port2, demoTarget('PublicApi'))
  return newMessagePortRpcSession<PublicApi>(channel.port1)
}

/** `text=Label` matches a button, link, tab or menu item by its visible text or aria-label; anything else is CSS. */
function find(selector: string): HTMLElement | null {
  if (!selector.startsWith('text=')) return document.querySelector<HTMLElement>(selector)
  const label = selector.slice(5).trim()
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], label, summary',
  )
  for (const element of candidates) {
    if (element.getAttribute('aria-label')?.trim() === label || element.textContent?.trim() === label) return element
  }
  return null
}

async function waitFor(selector: string, timeoutMs = 10_000): Promise<HTMLElement> {
  const started = Date.now()
  for (;;) {
    const element = find(selector)
    if (element) return element
    if (Date.now() - started > timeoutMs) throw new Error(`[demo] step timed out waiting for ${selector}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function runSteps(steps: DemoStep[]) {
  try {
    for (const step of steps) {
      if ('click' in step) (await waitFor(step.click)).click()
      else if ('hover' in step) (await waitFor(step.hover)).dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      else if ('type' in step) {
        const input = await waitFor(step.into) as HTMLInputElement | HTMLTextAreaElement
        input.focus()
        // React tracks the native value setter, so set through it for onChange to fire.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
        setter?.call(input, step.type)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } else if ('press' in step) {
        const target = step.on ? await waitFor(step.on) : (document.activeElement as HTMLElement | null) ?? document.body
        target.dispatchEvent(new KeyboardEvent('keydown', { key: step.press, bubbles: true }))
      } else await waitFor(step.wait)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  } catch (error) {
    console.warn(error)
  }
}

function mountPicker() {
  const host = document.createElement('div')
  host.id = 'demo-picker'
  document.body.appendChild(host)
  createRoot(host).render(createElement(DemoPicker, { views: views.views, activeId: activeScenarioId() }))
}
