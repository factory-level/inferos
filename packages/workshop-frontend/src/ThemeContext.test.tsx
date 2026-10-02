// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from './ThemeContext'
import type { ThemeMode } from './theme'

let root: Root
let container: HTMLDivElement
let dark: boolean
const listeners = new Set<() => void>()
const storageKey = 'gadgets:theme-mode'

const Probe = () => {
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme()
  return <button onClick={() => setThemeMode('dark')}>{themeMode}:{resolvedThemeMode}</button>
}

const render = async (defaultMode?: ThemeMode) => {
  await act(async () => root.render(<StrictMode><ThemeProvider defaultMode={defaultMode}><Probe /></ThemeProvider></StrictMode>))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dark = false
  listeners.clear()
  vi.stubGlobal('matchMedia', () => ({
    matches: dark,
    addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
  }))
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('applies a deployment default arriving after boot without saving it as a user preference', async () => {
  await render()
  expect(document.documentElement.dataset.mode).toBe('light')
  await render('dark')
  expect(container.textContent).toBe('dark:dark')
  expect(document.documentElement.dataset.mode).toBe('dark')
  expect(document.documentElement.style.colorScheme).toBe('dark')
  expect(localStorage.getItem(storageKey)).toBeNull()
  await render('light')
  expect(document.documentElement.dataset.mode).toBe('light')
})

it('honors an explicit system preference over the deployment and follows OS changes', async () => {
  localStorage.setItem(storageKey, 'system')
  await render('dark')
  expect(container.textContent).toBe('system:light')
  await act(async () => { dark = true; listeners.forEach(listener => listener()) })
  expect(container.textContent).toBe('system:dark')
  expect(document.documentElement.dataset.mode).toBe('dark')
  await render('light')
  expect(container.textContent).toBe('system:dark')
})

it('preserves saved and session-only choices when deployment configuration changes', async () => {
  localStorage.setItem(storageKey, 'light')
  await render('dark')
  expect(container.textContent).toBe('light:light')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable') })
  await act(async () => container.querySelector('button')!.click())
  await render('light')
  expect(container.textContent).toBe('dark:dark')
  expect(document.documentElement.dataset.mode).toBe('dark')
})

it('uses the deployment default when stored preference data is invalid or unavailable', async () => {
  localStorage.setItem(storageKey, 'invalid')
  await render('dark')
  expect(container.textContent).toBe('dark:dark')
  await act(async () => root.unmount())
  root = createRoot(container)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Unavailable') })
  await render('light')
  expect(container.textContent).toBe('light:light')
})
