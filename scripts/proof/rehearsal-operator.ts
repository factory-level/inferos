// The recovery rehearsal's hands on a running local Workshop (scripts/proof/recovery-rehearsal.ts):
// sign in as the local dev account `pnpm local seed` prepares, open its InferOps demo workspace and
// read or decide its approval queue over the same authenticated RPC a person's browser uses.
//
//   node scripts/proof/rehearsal-operator.ts pending|approve|all --url http://localhost:<port>
//
// `pending` lists the pending actions; `approve` approves the oldest pending one and reports
// whether InferOps applied it (`applied`, from the action's resulting state); `all` lists the recent
// actions with their states. Prints one JSON object; exit 1 when it can't sign in or find the
// workspace. Local stacks only: it refuses a URL whose host isn't localhost.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  connectWorkshop, DEMO_WORKSPACE_TITLE, findWorkspace, localWorkshopUrl, passwordHash,
} from "../../packages/workshop-backend/scripts/dev-workshop.ts";

/** One action as the rehearsal reads it. */
export type RehearsalAction = { id: number; state: string; type: string; failure?: string };

/** Whether `url` names a local stack; the operator signs in nowhere else. */
export function isLocalStackUrl(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The fields the rehearsal reports of an action log entry: its id, type, state and failure code, never its content. */
export function summarize(entry: { id: number; state: string; type: string; lastAttempt?: { outcome: string; code?: string } }): RehearsalAction {
  let failure = entry.lastAttempt ? entry.lastAttempt.code ?? entry.lastAttempt.outcome : undefined;
  return { id: entry.id, state: entry.state, type: entry.type, ...(failure ? { failure } : {}) };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: "string" }, user: { type: "string", default: "dev" }, password: { type: "string", default: "devpassword" },
  } });
  const verb = positionals[0];
  if (!values.url || !isLocalStackUrl(values.url) || !["pending", "approve", "all"].includes(verb ?? "")) {
    console.error("usage: rehearsal-operator.ts pending|approve|all --url http://localhost:<port>");
    return 2;
  }
  const { api, close } = connectWorkshop(localWorkshopUrl(values.url), 60_000);
  try {
    const token = await api.login(values.user!, passwordHash(values.user!, values.password!));
    if (!token) throw new Error(`no local account ${values.user}`);
    using user = await api.authenticate(token);
    const workspace = await findWorkspace(user, DEMO_WORKSPACE_TITLE);
    if (!workspace) throw new Error(`no "${DEMO_WORKSPACE_TITLE}" workspace`);
    using overseer = user.openGadget(workspace.id);
    const pending = (await overseer.listActions({ filter: "pending" })).entries.map(summarize);
    if (verb === "pending") {
      console.log(JSON.stringify({ pending }));
      return 0;
    }
    if (verb === "all") {
      const all = (await overseer.listActions({ filter: "all" })).entries.map(summarize);
      console.log(JSON.stringify({ pending, actions: all.slice(0, 20) }));
      return 0;
    }
    const oldest = pending.filter(entry => entry.type === "action").toSorted((a, b) => a.id - b.id)[0];
    if (!oldest) throw new Error("nothing pending to approve");
    let error: string | undefined;
    try {
      await overseer.approveAction(oldest.id);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const after = (await overseer.listActions({ filter: "all" })).entries.map(summarize).find(entry => entry.id === oldest.id);
    console.log(JSON.stringify({ id: oldest.id, applied: after?.state === "approved", state: after?.state ?? null,
      ...(after?.failure ? { failure: after.failure } : {}), ...(error ? { error } : {}) }));
    return 0;
  } catch (thrown) {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  } finally {
    close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
