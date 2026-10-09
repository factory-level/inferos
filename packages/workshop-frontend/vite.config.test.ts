import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>()
  return {
    ...actual,
    loadEnv: () => ({
      VITE_BACKEND_HOST: 'backend.from-env.test:9999',
      VITE_FRONTEND_ERROR_REPORTING: 'true',
    }),
  }
})

import config from './vite.config'

async function resolveConfig(value: UserConfigExport): Promise<UserConfig> {
  if (typeof value !== 'function') return value
  const env: ConfigEnv = { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false }
  return await value(env)
}

describe('Vite development proxy', () => {
  it('uses loaded environment values for the proxy and source maps', async () => {
    const resolved = await resolveConfig(config)
    expect(resolved.server?.proxy).toMatchObject({
      '/api/client-errors': 'http://backend.from-env.test:9999',
      '/api/site-logo': 'http://backend.from-env.test:9999',
    })
    expect(resolved.build?.sourcemap).toBe('hidden')
  })
})

describe('Cross-Origin-Opener-Policy on Workshop documents', () => {
  it('is set by the dev and preview servers', async () => {
    const resolved = await resolveConfig(config)
    expect(resolved.server?.headers).toEqual({ 'Cross-Origin-Opener-Policy': 'same-origin' })
    expect(resolved.preview?.headers).toEqual({ 'Cross-Origin-Opener-Policy': 'same-origin' })
  })

  it('is set for every path by the _headers file Vite copies into the asset build', () => {
    const rules = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8')
      .split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#'))
    expect(rules).toEqual(['/*', '  Cross-Origin-Opener-Policy: same-origin'])
  })
})
