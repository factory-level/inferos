// Demo fixtures and scenarios for the "auth" views: sign-in, signup, the OAuth popup handoff,
// onboarding, workspace-open errors and the billing modals. See ../registry.ts and ../scenarios.ts.
//
// Scenarios that need a method another area owns to fail or hang replace it in `setup` with
// `{ override: true }`. Setup runs after every area has registered, so the replacement only lasts
// for that page load.

import type { AuthVendorInfo, OpenGadgetErrorCode } from '@gadgets/workshop-shared/api'
import { OPEN_GADGET_ERROR_CODES, createOpenGadgetError } from '@gadgets/workshop-shared/api'
import { demoContext, demoTarget, delay, forever, provide } from '../registry'
import { scenario, type DemoScenario } from '../scenarios'
import { world, type DemoWorld } from '../world'
import { DEMO_TOKEN } from './core'
import { models, usage } from './settings'

const logo = (fill: string, glyph: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${fill}"/>` +
    `<text x="12" y="16.5" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text></svg>`,
  )}`

/** Sign-in providers offered by the OAuth scenarios. */
export const authVendors: AuthVendorInfo[] = [
  { vendorId: 'github', displayName: 'GitHub', logo: { url: logo('#24292f', 'GH') }, color: '#24292f' },
  { vendorId: 'google', displayName: 'Google Workspace', logo: { url: logo('#4285f4', 'G') }, color: '#4285f4' },
  { vendorId: 'cloudflare', displayName: 'Cloudflare', logo: { url: logo('#f38020', 'CF') }, color: '#f38020' },
]

/** How the sign-in fixtures behave this page load; scenarios adjust it in `setup`. */
export const authState = {
  /** `confirmLogin` outcome on the handoff page. */
  confirm: 'ok' as 'ok' | 'fail' | 'hang',
  /** Password sign-in rejects every credential (the error-banner scenario). */
  rejectPasswords: false,
  /** Milliseconds before a started OAuth sign-in "completes" in the opener tab. */
  oauthCompletesAfterMs: 4000,
}

// The local dev auto-login (.env.development.local) signs in with this account at boot. Signed-out
// scenarios refuse it so the sign-in screens stay up; credentials typed into the form still work.
const DEV_USERNAME = import.meta.env.VITE_DEV_USERNAME ?? 'dev'

const ticket = 'a3f1c9e07b5d4e2f8c6a1b9d0e7f3c5a2b8d4e6f1a3c5e7b9d0f2a4c6e8b1d3f'

provide('PublicApi', {
  startGatekeeperLogin(vendorId) {
    if (!authVendors.some(v => v.vendorId === vendorId)) throw new Error(`Sign-in with "${vendorId}" is not enabled`)
    const nonce = crypto.randomUUID()
    return {
      url: `/connect/handoff#${ticket}`,
      nonce,
      attempt: demoTarget('LoginAttempt', { startedAt: Date.now() }),
    }
  },
  async confirmLogin() {
    if (authState.confirm === 'hang') return forever<void>()
    await delay(400)
    if (authState.confirm === 'fail') throw new Error('This sign-in link has expired. Start the sign-in again from the Workshop.')
  },
})

provide('LoginAttempt', {
  receive() {
    const { startedAt } = demoContext<{ startedAt: number }>(this)
    if (Date.now() - startedAt < authState.oauthCompletesAfterMs) return null
    world.signedIn = true
    return DEMO_TOKEN
  },
})

/** Signs the visitor out and makes password sign-in/signup behave like a real deployment's. */
function signedOut(w: DemoWorld) {
  w.signedIn = false
  provide('PublicApi', {
    login(username) {
      if (username === DEV_USERNAME || authState.rejectPasswords) return null
      w.signedIn = true
      return DEMO_TOKEN
    },
    createAccount(username) {
      if (username === DEV_USERNAME) throw new Error('Demo: dev auto-signup disabled')
      if (!w.serverConfig.signupsEnabled) throw new Error('Signups are closed on this deployment')
      if (username === 'dana') return null
      w.signedIn = true
      return DEMO_TOKEN
    },
  }, { override: true })
}

const configLoading = () => provide('PublicApi', { getServerConfig: () => forever() }, { override: true })
const configFails = () => provide('PublicApi', {
  getServerConfig() { throw new Error('Admin settings are unavailable') },
}, { override: true })

/** A handoff popup: the nonce the opener wrote into its sessionStorage, and the ticket fragment. */
function handoff(kind: 'connect' | 'login' | 'openai' | null, withTicket = true): Pick<DemoScenario, 'path'> & { prepare: () => void } {
  return {
    path: `/connect/handoff${withTicket ? `#${ticket}` : ''}`,
    prepare() {
      if (kind) sessionStorage.setItem('gadgets.handoff', JSON.stringify({ kind, nonce: 'demo-nonce-7c41' }))
      // A page the script did not open may still close itself in headless browsers; keep it up.
      window.close = () => {}
    },
  }
}

const openFailure = (code: OpenGadgetErrorCode | null): DemoScenario => ({
  path: '/workspace/ws-archived-q3-retro',
  setup() {
    provide('AuthenticatedApi', {
      openGadget() {
        throw code ? createOpenGadgetError(code) : new Error('Durable Object storage operation exceeded timeout')
      },
    }, { override: true })
  },
})

const onboarding = (setup?: (w: DemoWorld) => void, steps: DemoScenario['steps'] = []): DemoScenario => ({
  setup(w) {
    w.onboardingCompleted = false
    w.user = { ...w.user, name: 'Dana Okonkwo-Fairweather' }
    setup?.(w)
  },
  steps: [{ wait: '#onboarding-display-name' }, ...steps],
})
const next = { click: 'text=Next' }

const limits = (w: DemoWorld) => { w.serverConfig = { ...w.serverConfig, cloudflareLimitsEnabled: true } }
const resetAt = () => new Date(Date.now() + (3 * 3600 + 17 * 60) * 1000).toISOString()

const login = (setup?: (w: DemoWorld) => void, steps?: DemoScenario['steps']): DemoScenario => ({
  path: '/',
  setup(w) { signedOut(w); setup?.(w) },
  steps,
})
const oauthOnly = (w: DemoWorld) => { w.serverConfig = { ...w.serverConfig, authVendors, passwordAuthEnabled: false } }
const withOAuth = (w: DemoWorld) => { w.serverConfig = { ...w.serverConfig, authVendors } }

const OUT_OF_CREDITS_PATH = '/workspace/ws-ops?chat=8'

scenario({
  // ── sign-in ──
  'auth.login': login(),
  'auth.login.password': login(),
  'auth.login.oauth': login(withOAuth),
  'auth.login.oauth-only': login(oauthOnly),
  'auth.login.loading': login(configLoading),
  'auth.login.config-error': login(configFails),
  'auth.login.error': login(() => { authState.rejectPasswords = true }, [
    { type: 'dana.okonkwo', into: 'input[autocomplete="username"]' },
    { type: 'not-my-password', into: 'input[type="password"]' },
    { click: 'text=Sign in' },
    { wait: '[role="alert"], .text-kumo-danger' },
  ]),

  // ── signup ──
  'auth.signup': login(),
  'auth.signup.form': login(undefined, [
    { type: 'dana okonkwo', into: 'input[autocomplete="username"]' },
  ]),
  'auth.signup.oauth': login(withOAuth),
  'auth.signup.closed': login(w => { w.serverConfig = { ...w.serverConfig, authVendors, signupsEnabled: false } }),
  'auth.signup.loading': login(configLoading),
  'auth.signup.config-error': login(configFails),

  // ── workspace open errors ──
  'auth.workspace-open-error': openFailure(OPEN_GADGET_ERROR_CODES.workspaceNotFound),
  'auth.workspace-open-error.not-found': openFailure(OPEN_GADGET_ERROR_CODES.workspaceNotFound),
  'auth.workspace-open-error.access-denied': openFailure(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
  'auth.workspace-open-error.share-links-disabled': openFailure(OPEN_GADGET_ERROR_CODES.shareLinksDisabled),
  'auth.workspace-open-error.unexpected': openFailure(null),

  // ── onboarding ──
  onboarding: onboarding(),
  'onboarding.header': onboarding(),
  'onboarding.footer': onboarding(undefined, [next]),
  'onboarding.step.profile': onboarding(),
  'onboarding.step.models': onboarding(undefined, [next]),
  'onboarding.step.models.empty': onboarding(() => { models.entries = []; models.managed = [] }, [next]),
  'onboarding.step.models.add-model': onboarding(undefined, [next, { click: 'text=Add new model...' }]),
  'onboarding.step.connections': onboarding(undefined, [next, next]),
  'onboarding.step.showcase': onboarding(undefined, [next, next, next, { wait: "text=Let's build" }]),
  'onboarding.checking': {
    setup(w) {
      w.onboardingCompleted = false
      provide('AuthenticatedApi', { isOnboardingCompleted: () => forever() }, { override: true })
    },
  },
  'onboarding.toast': onboarding(() => {
    // Drop a non-image file on the avatar: "Please select an image file".
    const drop = () => {
      const target = document.querySelector('#onboarding-display-name')?.closest('div.flex')?.querySelector('button')
      if (!target) return void setTimeout(drop, 200)
      const data = new DataTransfer()
      data.items.add(new File(['Q3 planning notes'], 'q3-planning-notes.txt', { type: 'text/plain' }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    }
    setTimeout(drop, 800)
  }),

  // ── connect / sign-in handoff popup ──
  handoff: (() => { const h = handoff('login'); return { path: h.path, setup: h.prepare } })(),
  'handoff.success': (() => { const h = handoff('login'); return { path: h.path, setup: h.prepare } })(),
  'handoff.finishing': (() => {
    const h = handoff('login')
    return { path: h.path, setup() { h.prepare(); authState.confirm = 'hang' } }
  })(),
  'handoff.failed': (() => {
    const h = handoff('login')
    return { path: h.path, setup() { h.prepare(); authState.confirm = 'fail' } }
  })(),
  'handoff.invalid': (() => { const h = handoff(null, false); return { path: h.path, setup: h.prepare } })(),
  'handoff.signed-out': (() => {
    const h = handoff('connect')
    return { path: h.path, setup(w) { h.prepare(); signedOut(w) } }
  })(),

  // ── billing ──
  'billing.account-selection': {
    path: '/',
    setup(w) {
      limits(w)
      usage.info = { ...usage.info, connected: true, needsAccountSelection: true, accountId: undefined, accountName: undefined }
    },
  },
  'billing.account-selection.loading': {
    path: '/',
    setup(w) {
      limits(w)
      usage.info = { ...usage.info, connected: true, needsAccountSelection: true }
      provide('AuthenticatedApi', { listCloudflareAccounts: () => forever() }, { override: true })
    },
  },
  'billing.account-selection.empty': {
    path: '/',
    setup(w) {
      limits(w)
      usage.info = { ...usage.info, connected: true, needsAccountSelection: true }
      usage.accounts = []
    },
  },
  // The out-of-credits modal opens from a workspace chat whose last message is a `usage_limit`
  // error: chat 8 in the chat area's fixtures. These open it and set the modal's data.
  'billing.out-of-credits': {
    path: OUT_OF_CREDITS_PATH,
    setup(w) {
      limits(w)
      usage.info = { ...usage.info, dailyUsed: 50, remaining: 0, connected: false, balance: null, resetAt: resetAt() }
    },
  },
  'billing.out-of-credits.not-connected': {
    path: OUT_OF_CREDITS_PATH,
    setup(w) {
      limits(w)
      usage.info = { ...usage.info, dailyUsed: 50, remaining: 0, connected: false, balance: null, resetAt: resetAt() }
    },
  },
  'billing.out-of-credits.loading': {
    path: OUT_OF_CREDITS_PATH,
    setup(w) {
      limits(w)
      provide('AuthenticatedApi', { getCloudflareUsage: () => forever() }, { override: true })
    },
  },
  'billing.out-of-credits.low-balance': {
    path: OUT_OF_CREDITS_PATH,
    setup(w) {
      limits(w)
      usage.info = { ...usage.info, dailyUsed: 50, remaining: 0, connected: true, balance: 0.37, resetAt: resetAt() }
    },
  },
  'billing.out-of-credits.select-account': {
    path: OUT_OF_CREDITS_PATH,
    setup(w) {
      limits(w)
      usage.info = { ...usage.info, dailyUsed: 50, remaining: 0, connected: true, needsAccountSelection: true, resetAt: resetAt() }
    },
  },
})
