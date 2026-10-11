import { readdirSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { COMPATIBILITY_DATE } from '@gadgets/scripts/worker-config'
import capnwebValidate from 'capnweb-validate/vite'
import { BACKEND, UNIT_NODE, WORKERD_LIGHT } from './__tests__/test-projects.ts'

// Wrangler ships `*.txt` imports as Text modules (its default module rules; see
// src/text-modules.d.ts), but this config drives the pool from inline miniflare settings, and
// vite's own fallback would resolve them as asset URLs. Mirror the Text-module behavior so code
// under test (e.g. describeBinding's worktree-binding.txt) sees the real content. Like wrangler,
// match on the *import path*: resolving here keeps vite from realpathing the id, which for a
// symlinked .txt (the binding .txts are symlinks to their .d.ts) would dodge the load hook
// below and fall through to the TypeScript pipeline.
const textModules: Plugin = {
  name: 'text-modules',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.endsWith('.txt') && importer !== undefined) {
      return path.resolve(path.dirname(importer), source)
    }
  },
  load(id) {
    if (id.endsWith('.txt')) {
      return `export default ${JSON.stringify(readFileSync(id, 'utf-8'))};`
    }
  },
}

// capnweb-validate decides what to transform by the id with its query stripped, so it also takes
// `foo.ts?raw` (and `?url`, `?inline`), whose code is vite's `export default "<source>"`. It then
// applies edits whose offsets come from the file's TypeScript source (the validator prelude at 0,
// and `__cw.__validateRpcClass(...)` over each `@validateRpc()`) to that string module, splicing
// them into the middle of the string. The guard tests read `src/` through `?raw` to scan what is
// on disk, so those ids are left untransformed; every module id without such a query is
// validated as before.
const STRING_QUERY = /[?&](?:raw|url|inline)(?:[&=]|$)/
function rpcValidation(): Plugin {
  let plugin = capnwebValidate() as Plugin
  // A function today; the object-hook form (`{handler, filter}`) keeps its filter around the wrap.
  let hook = plugin.transform
  let transform = typeof hook === 'function' ? hook : hook?.handler
  if (!transform) throw new Error('capnweb-validate has no transform hook to wrap')
  let wrapped: typeof transform = function (code, id, options) {
    return STRING_QUERY.test(id) ? null : transform.call(this, code, id, options)
  }
  return { ...plugin, transform: typeof hook === 'function' ? wrapped : { ...hook, handler: wrapped } }
}

// The UTF-16 length of every `src/**/*.ts` file as it is on disk, keyed as the guard tests'
// `import.meta.glob("../src/**/*.ts")` keys it, so a test in workerd (which cannot read the disk)
// can check that a `?raw` import is the file itself (see rpcValidation). Computed once, when this
// config loads: under `--watch`, restart after editing `src/` or the lengths are stale.
const sourceLengths = Object.fromEntries(
  readdirSync(path.resolve(import.meta.dirname, 'src'), { recursive: true, encoding: 'utf-8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => [`../src/${file.split(path.sep).join('/')}`,
      readFileSync(path.resolve(import.meta.dirname, 'src', file), 'utf-8').length]),
)
// The same for the sources outside `src/` that a guard reads through `?raw` (chat-taint-guard's
// agent APIs), keyed by their path from `__tests__/`.
const guardedSourceLengths = Object.fromEntries([
  '../../gatekeeper-context/src/library-gatekeeper.ts',
  '../../gatekeeper-scheduler/src/types.d.ts',
  '../../../custom-gatekeepers/gatekeeper-inferops/src/types.d.ts',
].map(file => [file, readFileSync(path.resolve(import.meta.dirname, '__tests__', file), 'utf-8').length]))

// Records the agent spans (see src/agent-tracing.ts) this Worker emits, as a streaming tail
// worker receives them, so tests can read them back through the SPAN_RECORDER binding.
const spanRecorder = `
import { WorkerEntrypoint } from "cloudflare:workers";
const AGENT_SPAN = /^(invoke_agent|chat|execute_tool|tool_approval)( |$)/;
const spans = new Map();
export class SpanRecorder extends WorkerEntrypoint {
  spans() { return [...spans.values()]; }
}
export default {
  tailStream() {
    return ({ event, spanContext }) => {
      if (event.type === "spanOpen" && AGENT_SPAN.test(event.name)) {
        spans.set(event.spanId, {
          name: event.name, spanId: event.spanId, parentSpanId: spanContext.spanId,
          attributes: {}, closed: false,
        });
      }
      let span = spans.get(spanContext.spanId);
      if (span === undefined) return;
      if (event.type === "attributes") {
        for (let { name, value } of event.info) span.attributes[name] = value;
      } else if (event.type === "spanClose") {
        span.closed = true;
      }
    };
  },
};
`

const here = import.meta.dirname
const tests = (files: readonly string[]) => files.map(file => `__tests__/${file}`)

/** What every project shares: the module transforms, the source-length defines, and resolution. */
const shared = {
  resolve: {
    // `@gadgets/typed-storage`'s `exports` point at its emitted `dist/`, which only its `build`
    // writes. Resolve it from source instead, as `tsconfig.json`'s `paths` already does, so a bare
    // `vitest run <file>` works in a fresh checkout before anything is built.
    alias: [{
      find: /^@gadgets\/typed-storage$/,
      replacement: path.resolve(here, '../typed-storage/src/index.ts'),
    }],
  },
  define: {
    __WORKSHOP_SOURCE_LENGTHS__: JSON.stringify(sourceLengths),
    __WORKSHOP_GUARDED_SOURCE_LENGTHS__: JSON.stringify(guardedSourceLengths),
  },
}
const plugins = () => [textModules, rpcValidation()]

// `allow_irrevocable_stub_storage` as in cloudflare.config.ts: the user DO persists account stubs.
const compatibilityFlags = ['experimental', 'nodejs_compat', 'allow_irrevocable_stub_storage']

/**
 * The `backend` project's pool workers: `BACKEND_TEST_WORKERS` when set (a positive integer, or the
 * config refuses to load), otherwise four, or one fewer than the cores when there are fewer.
 */
function backendWorkers(): number {
  let value = process.env.BACKEND_TEST_WORKERS
  if (value === undefined || value === '') return Math.max(1, Math.min(4, availableParallelism() - 1))
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`BACKEND_TEST_WORKERS must be a positive integer, not ${JSON.stringify(value)}`)
  }
  return Number(value)
}

/**
 * Three projects, cheapest first; `__tests__/test-projects.ts` says which file runs where, and
 * `vitest run` runs all three (`--project <name>` picks one).
 *
 * - `unit-node`: pure logic under Node. No workerd start, so a file costs milliseconds.
 * - `workerd-light`: needs workerd's runtime APIs but not the backend, so the pool's `main` is a
 *   few-line Worker with the one Durable Object it addresses.
 * - `backend`: drives the production Worker (`__tests__/test-worker.ts`) through `cloudflare:test`.
 *   Importing `cloudflare:test` evaluates that whole module graph -- about 1,700 modules, 10-15 s
 *   under load -- so these run with `isolate: false`: each pool worker keeps one Miniflare and one
 *   module graph for every file it runs, rather than a fresh one per file. The price is that a file
 *   must not leave state another can see: its Durable Object names carry its own prefix, a stubbed
 *   global or a patched prototype is put back when the test or file ends, module-level state in
 *   `test-worker.ts` is keyed by names the file mints itself, and an overseer's alarm runs only for
 *   the file that made it (`__tests__/workerd/backend-file-boundary.ts`).
 *
 * The two workerd projects load `@gadgets/scripts/assert-workerd`, which fails the run unless the
 * pool actually started, rather than trusting a green run to mean workerd.
 */
export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        plugins: plugins(),
        resolve: {
          alias: [
            ...shared.resolve.alias,
            {
              find: /^cloudflare:workers$/,
              replacement: path.resolve(here, '__tests__/stubs/cloudflare-workers.ts'),
            },
          ],
        },
        test: { name: 'unit-node', include: tests(UNIT_NODE), environment: 'node' },
      },
      {
        ...shared,
        plugins: [
          ...plugins(),
          cloudflareTest({
            main: './__tests__/workerd/light-worker.ts',
            miniflare: {
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags,
              durableObjects: {
                TEST_USER_DIRECTORY: { className: 'UserDirectoryDurableObject', useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: 'workerd-light',
          include: tests(WORKERD_LIGHT),
          setupFiles: ['@gadgets/scripts/assert-workerd'],
        },
      },
      {
        ...shared,
        plugins: [
          ...plugins(),
          cloudflareTest({
            // The production Worker plus test-only entrypoints (see __tests__/test-worker.ts).
            main: './__tests__/test-worker.ts',
            miniflare: {
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags,
              streamingTails: ['span-recorder'],
              serviceBindings: { SPAN_RECORDER: { name: 'span-recorder', entrypoint: 'SpanRecorder' } },
              workers: [{
                name: 'span-recorder',
                modules: true,
                script: spanRecorder,
                compatibilityDate: COMPATIBILITY_DATE,
                compatibilityFlags: ['experimental', 'streaming_tail_worker'],
              }],
              bindings: { PUBLIC_BASE_URL: 'https://workshop.example/' },
              // The overseer loads gadget code through this, so a test can run a real gadget facet.
              workerLoaders: { LOADER: {} },
              durableObjects: {
                TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
                TEST_USER: { className: 'UserDurableObject', useSQLite: true },
                TEST_PENDING_LOGIN: { className: 'PendingLogin', useSQLite: true },
                // Never addressed by name: a binding is what puts the class in `ctx.exports`, from
                // which the overseer instantiates it (with props) as one of its own facets.
                TEST_AGENT_SPAWNER: { className: 'AgentSpawnerGatekeeper', useSQLite: true },
                TEST_USER_DIRECTORY: { className: 'UserDirectoryDurableObject', useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: 'backend',
          include: tests(BACKEND),
          isolate: false,
          // Each worker evaluates the backend once, so a few cover the 30-odd files; more only adds
          // evaluations competing for the same cores. A project's own `maxWorkers` needs its own
          // `groupOrder`, so these run after the other two projects. The CLI's `--maxWorkers` does
          // not reach a project's own value, so `BACKEND_TEST_WORKERS` is the override.
          maxWorkers: backendWorkers(),
          sequence: { groupOrder: 1 },
          // Module state outlives a file here, so undo what a test stubs as soon as it ends.
          unstubGlobals: true,
          restoreMocks: true,
          setupFiles: ['@gadgets/scripts/assert-workerd', './__tests__/workerd/backend-file-boundary.ts'],
        },
      },
    ],
  },
})
