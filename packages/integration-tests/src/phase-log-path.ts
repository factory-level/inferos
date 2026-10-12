import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The integration-tests package directory. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where `phase-log.ts` appends and `scripts/vp/last-run-report.ts` reads. Under `node_modules/.vite`
 * because the task's fingerprint and archived outputs already exclude that tree
 * (`VITEST_TOOL_SCRATCH_EXCLUSIONS`), so writing it neither invalidates nor bloats the cache.
 */
export const PHASE_LOG = join(PACKAGE_DIR, "node_modules", ".vite", "integration-phases.jsonl");
