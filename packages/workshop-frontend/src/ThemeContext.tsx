import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  applyThemeMode,
  readThemePreference,
  getSystemThemeMode,
  writeThemeMode,
  type ResolvedThemeMode,
  type ThemeMode,
} from './theme'

interface ThemeContextValue {
  themeMode: ThemeMode
  resolvedThemeMode: ResolvedThemeMode
  setThemeMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const subscribeSystemTheme = (onChange: () => void) => {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const ThemeProvider = ({ children, defaultMode = 'system' }: { children: ReactNode; defaultMode?: ThemeMode }) => {
  const [preference, setPreference] = useState(readThemePreference)
  const systemMode = useSyncExternalStore(subscribeSystemTheme, getSystemThemeMode)
  const themeMode = preference ?? defaultMode
  const resolvedThemeMode = themeMode === 'system' ? systemMode : themeMode

  useEffect(() => {
    applyThemeMode(resolvedThemeMode)
  }, [resolvedThemeMode])

  const value = useMemo<ThemeContextValue>(() => ({
    themeMode,
    resolvedThemeMode,
    setThemeMode: (mode) => {
      writeThemeMode(mode)
      setPreference(mode)
    },
  }), [themeMode, resolvedThemeMode])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
