// Vite+ per-package settings: `build` is a pure type check, and `test` the shared vitest task over
// the workerd suite in `vitest.config.ts`. Tasks and scripts cannot share a name, so package.json
// declares neither.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      build: { command: "tsc" },
    },
  },
}, "vitest run");
