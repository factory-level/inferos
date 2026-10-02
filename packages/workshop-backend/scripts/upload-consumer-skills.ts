import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import type { ContextApi } from "../../gatekeeper-context/src/context-types.ts";
import { parseConsumerConfig } from "../../../scripts/consumer/config.ts";
import { checkConsumerSkills, type CollectedSkillPack } from "../../../scripts/consumer/skills.ts";

// Publishes the wrapper's skill packs (inferos.skills.json) into the local Context Library: one
// public collection per pack, found again by title. Usage: upload-consumer-skills.ts ROOT [PACK...]
// [--dry-run] [--prune]. Public collections are visible to every user, which is why this needs an
// administrator session; the Context Library itself enforces that on every write.

// Local problems (arguments, configuration, invalid skills) describe wrapper files only, so their
// messages are safe to print; this keeps them free of a Node stack trace.
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [rootArgument = ".", ...rest] = process.argv.slice(2);
const root = resolve(rootArgument);
const dryRun = rest.includes("--dry-run");
const prune = rest.includes("--prune");
const unknownFlags = rest.filter(arg => arg.startsWith("--") && arg !== "--dry-run" && arg !== "--prune");
if (unknownFlags.length) fail(`Unknown option ${unknownFlags[0]}; use --dry-run or --prune`);
let config: ReturnType<typeof parseConsumerConfig>;
let checked: ReturnType<typeof checkConsumerSkills>;
try {
  config = parseConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
  // Validate everything locally first, so a bad SKILL.md fails with its own message and nothing is
  // half-uploaded.
  checked = checkConsumerSkills(root);
} catch (error) {
  fail(error instanceof SyntaxError ? "Invalid JSON in the wrapper configuration" : (error as Error).message);
}
const requested = rest.filter(arg => !arg.startsWith("--"));
const unknownPacks = requested.filter(id => !checked.packs.some(pack => pack.id === id));
if (unknownPacks.length) fail(`Unknown skill pack ${unknownPacks[0]}; choose from ${checked.packs.map(pack => pack.id).join(", ")}`);
const packs = requested.length ? checked.packs.filter(pack => requested.includes(pack.id)) : checked.packs;
for (const warning of checked.warnings) console.error(`warning: ${warning}`);

const token = process.env.INFEROS_ADMIN_SESSION;
if (!token) fail("Set INFEROS_ADMIN_SESSION to a local Workshop administrator session token");

async function eachConcurrently<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

async function syncPack(context: RpcStub<ContextApi>, pack: CollectedSkillPack) {
  const collections = await context.listEnabledContextCollections();
  const existing = collections.find(collection => collection.source === "public" && collection.title === pack.title);
  if (!existing && dryRun) {
    return { pack: pack.id, collection: "new", created: pack.files.map(file => file.path), updated: [], deleted: [], unchanged: 0 };
  }
  const collectionId = existing?.id ?? (await context.createContextCollection(pack.title, pack.description, "public")).id;
  const remote = new Map((await context.listContextDocuments(collectionId)).map(doc => [doc.path, doc]));
  const created: string[] = [], updated: string[] = [];
  let unchanged = 0;
  await eachConcurrently(pack.files, 6, async file => {
    if (remote.has(file.path)) {
      const current = await context.getContextDocument(collectionId, file.path);
      if (current?.body === file.body && current.contentType === file.contentType) { unchanged++; return; }
      updated.push(file.path);
    } else created.push(file.path);
    if (!dryRun) await context.putContextDocument(collectionId, file.path, { description: file.description, body: file.body, contentType: file.contentType });
  });
  const local = new Set(pack.files.map(file => file.path));
  const stale = [...remote.keys()].filter(path => !local.has(path));
  if (prune && !dryRun) await eachConcurrently(stale, 6, path => context.deleteContextDocument(collectionId, path));
  if (!dryRun) {
    // The library skips an invalid SKILL.md silently; confirm each one was indexed under its name.
    const indexed = new Map((await context.listContextDocuments(collectionId)).map(doc => [doc.path, doc.skillName]));
    const missing = pack.skills.filter(skill => indexed.get(skill.path) !== skill.name);
    if (missing.length) throw new Error(`The Context Library did not index ${missing.map(skill => skill.path).join(", ")}`);
  }
  return {
    pack: pack.id, collection: collectionId, created: created.toSorted(), updated: updated.toSorted(), unchanged,
    // Without --prune, stale remote files are reported rather than deleted: they may be UI edits.
    ...(prune ? { deleted: stale } : { stale }),
  };
}

// Deliberately local-only, like profile:init: a wrapper command must not send an administrator
// session anywhere but the configured local Workshop.
const socket = new WebSocket(`ws://localhost:${config.local.port}/api`);
const api = newWebSocketRpcSession<PublicApi>(socket);
const timeout = setTimeout(() => socket.close(), 120_000);
let context: RpcStub<ContextApi> | undefined;
try {
  const authenticated = await api.authenticate(token);
  let frame = await authenticated.getGatekeeperApp("context");
  // The Context Library is opt-in by default ("optional"), so a fresh deployment's administrator
  // may not have its account yet. Opting in is what the Connectors page would do; a dry run only
  // reports it.
  let provisionContextAccount = false;
  if (!frame && (await authenticated.listAddableGatekeepers()).some(vendor => vendor.id === "context")) {
    provisionContextAccount = true;
    if (!dryRun) {
      await authenticated.provisionAmbientAccount("context");
      frame = await authenticated.getGatekeeperApp("context");
    }
  }
  let results;
  if (provisionContextAccount && dryRun) {
    results = packs.map(pack => ({ pack: pack.id, collection: "new", created: pack.files.map(file => file.path), updated: [], unchanged: 0 }));
  } else {
    if (!frame) throw new Error("context-unavailable");
    // The frame's `ui` is typed as a generic target; for the Context Library it is a ContextApi.
    context = frame.ui as unknown as RpcStub<ContextApi>;
    if (!(await context.getViewerInfo()).isAdmin) throw new Error("not-admin");
    results = [];
    for (const pack of packs) results.push(await syncPack(context, pack));
  }
  console.log(JSON.stringify({ ok: true, operation: "skills:upload", dryRun, provisionContextAccount, results, warnings: checked.warnings }, null, 2));
} catch (error) {
  // RPC and provider errors can include user-supplied values; never echo the session or remote text.
  const reason = error instanceof Error && error.message === "context-unavailable"
    ? "The Context Library is not available to this account; check the deployment's Context Library mode in the admin Gatekeepers panel."
    : error instanceof Error && error.message === "not-admin"
    ? "This local account is not a deployment administrator; public skill collections need one."
    : error instanceof Error && error.message.startsWith("The Context Library did not index")
    ? error.message
    : "Skill upload failed. Check the local server, administrator session and supported InferOS revision.";
  console.error(reason);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  context?.[Symbol.dispose]();
  api[Symbol.dispose]();
  socket.close();
}
