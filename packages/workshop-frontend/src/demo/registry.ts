// The demo backend: RPC targets whose methods come from per-area fixture modules. Only loaded when
// the frontend runs with VITE_DEMO=true (`pnpm views demo`), never in a real build.
//
// Each interface the frontend reaches over RPC has a method table here. Area modules under
// `areas/` fill the tables with `provide()`; a call to a method no area provides rejects with a
// "not implemented in demo" error (and a console warning naming it), which is how a screen shows up
// as needing fixtures rather than silently hanging.

import { RpcTarget } from 'capnweb'
import type {
  AdminApi,
  AuthenticatedApi,
  LoginAttempt,
  ObserverConfigCallback,
  Overseer,
  PublicApi,
  WorkpieceClient,
} from '@gadgets/workshop-shared/api'

/**
 * The RPC interfaces the demo serves, by name. Add an entry when a screen reaches a new
 * interface (e.g. a session or subscription stub returned by a method).
 */
export interface DemoInterfaces {
  PublicApi: PublicApi
  AuthenticatedApi: AuthenticatedApi
  AdminApi: AdminApi
  Overseer: Overseer
  WorkpieceClient: WorkpieceClient
  LoginAttempt: LoginAttempt
  ObserverConfigCallback: ObserverConfigCallback
  /** Interfaces that are not exported RPC types (subscribers, sessions) can be served untyped. */
  [name: string]: object
}

type Method = (...args: never[]) => unknown

/**
 * Implementations may be plain or async and may return plain values where the interface promises
 * them; `this` is the target, so per-instance state is read with `demoContext(this)`.
 */
export type DemoMethods<T> = {
  [K in keyof T]?: T[K] extends (...args: infer A) => infer R
    ? (this: object, ...args: A) => Awaited<R> | Promise<Awaited<R>> | DemoStub
    : never
}

/** A target created with `demoTarget`, usable wherever the interface expects a stub. */
export type DemoStub = RpcTarget & { readonly __demoStub: true }

const tables = new Map<string, Record<string, Method>>()
const contexts = new WeakMap<object, unknown>()
const warned = new Set<string>()

/**
 * Adds method implementations for one interface. Each method has one owning area; replacing one
 * another area provided needs `{ override: true }`, so two areas cannot silently fight over it.
 */
export function provide<K extends keyof DemoInterfaces & string>(
  name: K,
  methods: DemoMethods<DemoInterfaces[K]>,
  options: { override?: boolean } = {},
): void {
  const table = tables.get(name) ?? {}
  for (const key of Object.keys(methods)) {
    if (key in table && !options.override) console.warn(`[demo] ${name}.${key} is provided twice; pass { override: true } if intended`)
  }
  tables.set(name, { ...table, ...(methods as Record<string, Method>) })
}

// Property names capnweb or the runtime probe on any object; answering them would make the
// target look like a promise or leak internals.
const RESERVED = new Set(['then', 'constructor', 'toJSON', 'valueOf', 'toString'])

/**
 * A new RPC target serving `name`'s method table, carrying `context` for its methods (e.g. which
 * workspace an Overseer is for). Cast the result to the interface where a typed stub is expected.
 */
export function demoTarget<T = DemoStub>(name: string, context?: unknown): T {
  const target = new RpcTarget()
  const proxy = new Proxy(target, {
    get(raw, prop, receiver) {
      if (typeof prop !== 'string' || RESERVED.has(prop) || prop in Object.prototype) {
        return Reflect.get(raw, prop, receiver)
      }
      const method = tables.get(name)?.[prop]
      if (method) return method
      return () => {
        const key = `${name}.${prop}`
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(`[demo] ${key}() is not implemented; add it to src/demo/areas/`)
        }
        return Promise.reject(new Error(`Demo: ${key}() is not implemented`))
      }
    },
  })
  contexts.set(proxy, context)
  return proxy as T
}

/** The context a target was created with. */
export function demoContext<C>(target: object): C {
  return contexts.get(target) as C
}

/** Resolves after `ms`, for fixtures that should visibly load. */
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A promise that never settles, for showing a loading state indefinitely. */
export const forever = <T,>() => new Promise<T>(() => {})
