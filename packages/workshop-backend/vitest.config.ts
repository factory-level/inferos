import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { COMPATIBILITY_DATE } from '@gadgets/scripts/worker-config'
import capnwebValidate from 'capnweb-validate/vite'

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

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    textModules,
    rpcValidation(),
    cloudflareTest({
      // The production Worker plus test-only entrypoints (see __tests__/test-worker.ts).
      main: './__tests__/test-worker.ts',
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        // `allow_irrevocable_stub_storage` as in cloudflare.config.ts: the user DO persists account stubs.
        compatibilityFlags: ['experimental', 'nodejs_compat', 'allow_irrevocable_stub_storage'],
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
  define: {
    __WORKSHOP_SOURCE_LENGTHS__: JSON.stringify(sourceLengths),
    __WORKSHOP_GUARDED_SOURCE_LENGTHS__: JSON.stringify(guardedSourceLengths),
  },
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['@gadgets/scripts/assert-workerd'],
  },
})
