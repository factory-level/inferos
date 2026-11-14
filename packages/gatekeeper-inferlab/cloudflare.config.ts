import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * InferLab sign-in only (FAC-214). No `vars`: INFERLAB_AUTH_ORIGIN and INFEROPS_COMPANY are set per
 * deployment, and without both the vendor offers no sign-in at all.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-inferlab",
  entrypoint: ".wrangler/validate/src/worker.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

/** One short-lived attempt per sign-in; nothing else is stored. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["SignInAttempt"] },
];
