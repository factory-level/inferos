// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and ships as `@gadgets/scripts/vitest-task`.
import {
  TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout,
} from '@gadgets/scripts/vitest-task'

/** The `test` task below, before its `cache.env` gains `BACKEND_TEST_WORKERS`. */
const unitTask = vitestTask([
  { command: 'vitest run', idleSeconds: 120 },
  { command: 'vitest run --config vitest.integration.config.ts', idleSeconds: 180 },
])

/**
 * Codegen steps stay separate commands rather than one `&&` string so each caches on its own.
 */
export default {
  run: {
    tasks: {
      /**
       * Its own task because it is the one step here that reads an env var: `BUNDLED_BLUEPRINTS_DIR`
       * points the generator at a blueprint set outside this workspace, and a cached `vp` run strips
       * undeclared vars, so a cached caller compiles the defaults in instead. Everything needing
       * `src/generated/bundled-blueprints.ts` depends on it -- `cache: false` is per-task, so running
       * the generator inside a cached task strips the override however its siblings are declared.
       *
       * `cache: false` rather than `cache: { env: ['BUNDLED_BLUEPRINTS_DIR'] }`: `env` fingerprints
       * the value, not the contents of the directory it names, so edits inside it would replay a
       * stale module.
       *
       * The generator itself, and the blueprints it bundles by default, are `@gadgets/bundled-blueprints`;
       * the script here is the command line around it, because the module it writes is this package's.
       */
      'build:bundled-blueprints': {
        command: 'node scripts/build-bundled-blueprints.ts',
        cache: false,
      },
      'build:browser-runtime': {
        command: withTestTimeout('node scripts/build-browser-runtime.ts'),
        cache: false,
      },
      /**
       * Builds the validated entrypoint shared by integration-test file workers.
       *
       * Cached with the `build:app` shape: the build writes `.wrangler/validate/` back into the
       * package automatic tracking treats as input, so without dropping that tree from `cache.input`
       * nothing ever caches. Workspace-wide, since tracking reaches past this package and any
       * sibling that ran `wrangler dev` would otherwise guarantee a miss. The explicit `cache.output`
       * matters as much: a cache hit has to leave the tree on disk, because
       * `@gadgets/integration-tests` reads it rather than rebuilding it.
       *
       * Its two codegen prerequisites stay uncached, which is what makes this safe: they always
       * run, so `src/generated/bundled-blueprints.ts` and the browser-runtime artifacts are current
       * when this task's fingerprint is taken. Fingerprinting those *generated* files rather than
       * `BUNDLED_BLUEPRINTS_DIR` sidesteps the "env fingerprints the value, not what it points at"
       * hazard one level down -- an external blueprint edit rewrites the generated module, which is
       * a tracked input here.
       *
       * Caching means this now runs with a stripped environment. `scripts/env-passthrough.test.ts`
       * is the guard: if capnweb-validate ever starts reading an ambient var, it fails there rather
       * than replaying a stale tree. The watchdog's own off switch is the one variable declared.
       */
      'build:integration-worker': {
        command: withTestTimeout('capnweb-validate build --out .wrangler/validate'),
        dependsOn: [
          '@gadgets/typed-storage#build', 'build:bundled-blueprints', 'build:browser-runtime',
        ],
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: '!**/.wrangler/**', base: 'workspace' }],
          output: ['.wrangler/validate/**'],
        },
      },
      /**
       * Two programs: this package's `src/` under its generated Workers types, and `browser/` under
       * the DOM lib. The bundled blueprints' TypeScript is type-checked by `@gadgets/bundled-blueprints`'s
       * own `build`, not here -- a gadget's Durable Object must not see this Worker's bindings.
       */
      build: {
        command: [
          'tsc',
          'tsc --project tsconfig.browser.json',
          'tsc --project tsconfig.operator.json',
        ],
        dependsOn: ['build:bundled-blueprints', 'build:browser-runtime'],
        cache: false,
      },
      /**
       * The unit suite needs a longer idle threshold than the watchdog's default. Evaluating the
       * backend dominates its runtime -- about 165-220 s of summed import+setup against 45 s of tests
       * on a 14-core machine, since the `backend` project evaluates it once per pool worker -- and
       * vitest prints only as files complete, so a worker's first file is a 15-25 s silence that
       * stretches past the default once the machine is contended. The wall-clock backstop still
       * bounds a real hang.
       *
       * `BACKEND_TEST_WORKERS` sets the `backend` project's worker count (see vitest.config.ts), so
       * it is declared here: a cached run strips undeclared variables.
       *
       * The integration config needs a longer one still. Its four `__integration__` files share one
       * cold start -- transforming and importing the backend, then booting workerd -- before any of
       * them reports. On CI, `RUN` to the first file took 61-107 s on passing runs; they stayed under
       * the default only because two incidental Vite sourcemap warnings (standardwebhooks,
       * @google/genai) land mid-silence and reset the timer, which a dependency or Vite upgrade can
       * remove. 180 s covers that; the wall-clock backstop still bounds a real hang.
       */
      test: {
        ...unitTask,
        cache: { ...unitTask.cache, env: [...unitTask.cache.env, 'BACKEND_TEST_WORKERS'] },
        dependsOn: [
          '@gadgets/typed-storage#build', 'build:bundled-blueprints', 'build:browser-runtime',
        ],
      },
    },
  },
}
