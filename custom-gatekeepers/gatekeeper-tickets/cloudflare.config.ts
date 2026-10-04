import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-tickets",
  entrypoint: ".wrangler/validate/src/tickets.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

/** DO classes are reached via ctx.exports; no durable_objects binding needed. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["TicketsFakeProvider", "TicketsQueueGatekeeper"] },
];
