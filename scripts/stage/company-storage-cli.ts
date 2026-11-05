import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";
import { waitForMiniflareReady } from "./miniflare-readiness.ts";
import { GADGET_VALUE_RULES, type GadgetStateAllowList } from "./gadget-state.ts";
import { runInProcessGroup } from "./process-group.ts";
import {
  credentialResource, exportCompanyStorage, httpStatusReader, purgeLocalCompany, type CompanyStorageBindings,
  type KeyValueStore, type ObjectStore, type StorageResourceNames,
} from "./company-storage.ts";

interface LocalManifest {
  tenantId: string;
  resourcePrefix: string;
  inferopsBaseUrl: string;
  wrapperRoot: string;
  stateDirectory: string;
  workerConfig: string;
  outputDirectory: string;
  resources: {
    kv: { binding: string; name: string }[];
    r2: { binding: string; name: string }[];
    /** Missing means no KV resources are exported. */
    exportKv?: string[];
    /** Missing means no R2 resources are exported. */
    exportR2?: string[];
    /**
     * Per blueprint, the gadget storage keys that may be exported and each value's rule (see
     * gadget-state.ts). Missing means every gadget's keys are listed by name only.
     */
    exportGadgetState?: GadgetStateAllowList;
  };
}

const MINIFLARE_READY_TIMEOUT_MS = 30_000;
const MINIFLARE_DISPOSE_TIMEOUT_MS = 30_000;
const BUNDLE_TIMEOUT_MS = 120_000;
/** The whole export-local run, bundle and startup included; --timeout-ms overrides it. */
const EXPORT_TIMEOUT_MS = 300_000;
const CHILD_COMMAND = "__export-local-in-group";
/** The binding this export gives an Overseer the worker declares unbound (reached via ctx.exports). */
const OVERSEER_EXPORT_BINDING = "__INFEROS_STORAGE_EXPORT_OVERSEER";

const usage = `
Usage:
  pnpm stage:company-storage plan --manifest FILE
  pnpm stage:company-storage export-local --manifest FILE [--timeout-ms N]
  pnpm stage:company-storage purge-local --manifest FILE [--apply]

Each wrapper must contain exactly one company's data; never point purge at a shared state directory.
Only resources named in resources.exportKv/exportR2 are exported; omitted lists export nothing.
Gadget storage is exported only for keys resources.exportGadgetState allow-lists per blueprint;
every other key is listed by name. export-local runs in its own process group and is killed,
with everything it started, after --timeout-ms (default 300000).
Manifest contains only local wrapper paths and resource names. A real stage has no apply command.
Set INFEROPS_OFFBOARDING_TOKEN to an internal InferOps bearer only for purge-local --apply.
`;

function args(argv: string[]): { command: string; manifest?: string; apply: boolean; timeoutMs: number } {
  const [command, ...rest] = argv;
  if (!command || !["plan", "export-local", "purge-local", CHILD_COMMAND].includes(command)) throw new Error(usage);
  let manifest: string | undefined;
  let apply = false;
  let timeoutMs = EXPORT_TIMEOUT_MS;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--manifest") manifest = rest[++i];
    else if (rest[i] === "--apply") apply = true;
    else if (rest[i] === "--timeout-ms" && command === "export-local") {
      const value = rest[++i];
      if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error("--timeout-ms needs a positive whole number of milliseconds");
      timeoutMs = Number(value);
    } else throw new Error(`Unknown option ${rest[i]}\n${usage}`);
  }
  if (!manifest) throw new Error(`--manifest is required\n${usage}`);
  if (command !== "purge-local" && apply) throw new Error("--apply is only valid for purge-local");
  return { command, manifest: resolve(manifest), apply, timeoutMs };
}

function readManifest(path: string): LocalManifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as LocalManifest;
  if (!/^[0-9a-f-]{36}$/i.test(manifest.tenantId) || !manifest.resourcePrefix ||
      !/[/:_-]$/.test(manifest.resourcePrefix) ||
      !manifest.inferopsBaseUrl || !manifest.wrapperRoot || !manifest.stateDirectory ||
      !manifest.workerConfig || !manifest.outputDirectory || !manifest.resources ||
      !Array.isArray(manifest.resources.kv) || !Array.isArray(manifest.resources.r2)) {
    throw new Error("Malformed local company storage manifest");
  }
  const root = realpathSync(manifest.wrapperRoot);
  for (const candidate of [manifest.stateDirectory, manifest.workerConfig]) {
    const absolute = resolve(candidate);
    const rel = relative(root, absolute);
    if (!isAbsolute(candidate) || !rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Manifest state and worker config must be inside the local wrapper root");
    }
  }
  if ([...manifest.resources.kv, ...manifest.resources.r2].some(resource => !resource.binding || !resource.name)) {
    throw new Error("Every local resource needs a binding and a resource name");
  }
  for (const [kind, allowed, listed] of [
    ["KV", manifest.resources.exportKv, manifest.resources.kv.map(({ name }) => name)],
    ["R2", manifest.resources.exportR2, manifest.resources.r2.map(({ name }) => name)],
  ] as const) {
    if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some(name => typeof name !== "string"))) {
      throw new Error(`resources.export${kind} must be an array of resource names`);
    }
    if (allowed && (new Set(allowed).size !== allowed.length || allowed.some(name => !listed.includes(name)))) {
      throw new Error(`resources.export${kind} may contain only unique names listed in resources.${kind.toLowerCase()}`);
    }
  }
  const gadgetAllowList = manifest.resources.exportGadgetState;
  if (gadgetAllowList !== undefined) {
    if (!Array.isArray(gadgetAllowList)) throw new Error("resources.exportGadgetState must be an array of { blueprintId, keys }");
    const seen = new Set<string>();
    for (const entry of gadgetAllowList as unknown[]) {
      const { blueprintId, keys } = (entry ?? {}) as { blueprintId?: unknown; keys?: unknown };
      if (typeof blueprintId !== "string" || !blueprintId || seen.has(blueprintId)) {
        throw new Error("resources.exportGadgetState needs a unique blueprintId on every entry");
      }
      seen.add(blueprintId);
      if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length === 0 ||
          Object.values(keys).some(rule => !(GADGET_VALUE_RULES as readonly unknown[]).includes(rule))) {
        throw new Error(`resources.exportGadgetState for ${blueprintId} needs keys, each with one of: ${GADGET_VALUE_RULES.join(", ")}`);
      }
    }
  }
  return manifest;
}

/** Disposes Miniflare, failing rather than waiting when it doesn't stop within its bound. */
async function disposeBounded(mf: Miniflare): Promise<void> {
  await waitForMiniflareReady(mf.dispose(), MINIFLARE_DISPOSE_TIMEOUT_MS).catch(error => {
    throw new Error(`Miniflare did not stop: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function openLocalBindings(manifest: LocalManifest): Promise<{ mf: Miniflare; bindings: CompanyStorageBindings; cleanup: () => void }> {
  const bundleDirectory = mkdtempSync(join(tmpdir(), "inferos-company-storage-"));
  try {
    // Bounded on its own, for a clear error; the process group bounds anything it leaves behind.
    execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", bundleDirectory,
      "-c", manifest.workerConfig], { cwd: manifest.wrapperRoot, stdio: "inherit",
      timeout: BUNDLE_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch (error) {
    rmSync(bundleDirectory, { recursive: true, force: true });
    throw new Error(`Wrangler could not bundle the local wrapper without deploying: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const { workerOptions, externalWorkers } = unstable_getMiniflareWorkerOptions(manifest.workerConfig);
  const main = join(bundleDirectory, "index.js");
  try {
    readFileSync(main);
  } catch {
    rmSync(bundleDirectory, { recursive: true, force: true });
    throw new Error(`Wrangler dry-run did not emit the expected bundled worker at ${main}`);
  }
  const { modulesRules, ...declaredConfig } = workerOptions as typeof workerOptions & {
    durableObjects?: Record<string, string | { className: string; useSQLite?: boolean }>;
    additionalUnboundDurableObjects?: { className: string; useSQLite?: boolean }[];
  };
  // The InferOS backend declares its Durable Object classes unbound and reaches them through
  // ctx.exports, so give an unbound Overseer a binding of the export's own to open it by. Its
  // storage is keyed by worker and class, so it's the same state either way. The worker's name
  // comes from its config, as `wrangler dev` names it, so this reads the state that dev wrote.
  const workerName = declaredConfig.name ?? unstable_readConfig({ config: manifest.workerConfig }).name;
  const unbound = declaredConfig.additionalUnboundDurableObjects ?? [];
  const boundOverseer = Object.values(declaredConfig.durableObjects ?? {})
    .some(binding => (typeof binding === "string" ? binding : binding.className) === "OverseerDurableObject");
  const unboundOverseer = unbound.find(({ className }) => className === "OverseerDurableObject");
  const workerConfig = {
    ...declaredConfig,
    name: workerName,
    durableObjects: { ...declaredConfig.durableObjects,
      ...(!boundOverseer && unboundOverseer ? { [OVERSEER_EXPORT_BINDING]: unboundOverseer } : {}) },
    additionalUnboundDurableObjects: unbound.filter(entry => boundOverseer || entry !== unboundOverseer),
  };
  const defaultRules = [
    { type: "Text", include: ["**/*.txt", "**/*.html", "**/*.sql"] },
    { type: "Data", include: ["**/*.bin"] },
    { type: "CompiledWasm", include: ["**/*.wasm", "**/*.wasm?module"] },
  ];
  if (JSON.stringify(modulesRules ?? []) !== JSON.stringify(defaultRules)) {
    rmSync(bundleDirectory, { recursive: true, force: true });
    throw new Error("Custom Wrangler modulesRules need an explicit Miniflare v5 manifest mapping");
  }
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{ ...workerConfig, rootPath: bundleDirectory, scriptPath: main, modules: true }, ...externalWorkers,
      ...(workerName === "workshop-backend" ? [] : [{
      // The router config contains a production service binding, but storage export never routes
      // requests through it. Give Miniflare an inert local target instead of resolving a remote
      // service or requiring the full application stack.
      name: "workshop-backend",
      modules: true,
      script: "export default { fetch: () => new Response('Local storage export does not serve requests', { status: 503 }) }",
    }])],
    resourcePersistencePath: manifest.stateDirectory,
    remoteBindings: false,
  }));
  try {
    await waitForMiniflareReady(mf.ready, MINIFLARE_READY_TIMEOUT_MS);
  } catch (error) {
    try { await disposeBounded(mf); } catch { /* retain the startup failure as the actionable error */ }
    rmSync(bundleDirectory, { recursive: true, force: true });
    throw error;
  }
  try {
    const kv = new Map<string, KeyValueStore>();
    for (const { binding, name } of manifest.resources.kv) kv.set(name, await mf.getKVNamespace(binding) as unknown as KeyValueStore);
    const r2 = new Map<string, ObjectStore>();
    for (const { binding, name } of manifest.resources.r2) r2.set(name, await mf.getR2Bucket(binding) as unknown as ObjectStore);

    const workers = [workerConfig, ...externalWorkers] as unknown as {
      name?: string; durableObjects?: Record<string, string | { className: string }>;
    }[];
    const workspaces = new Map<string, { exportWorkspaceRecords(): Promise<unknown> }>();
    const gadgetDurableObjects: { namespace: string; ids: string[] }[] = [];
    let overseerWorker: string | undefined;
    for (const worker of workers) {
      for (const [bindingName, binding] of Object.entries(worker.durableObjects ?? {})) {
        const className = typeof binding === "string" ? binding : binding.className;
        // Miniflare lists each facet's database (`<id>.<n>`) beside its object; only objects are
        // opened here, and a workspace's facets are read from disk by exportGadgetState.
        const ids = (await mf.listDurableObjectIds(className, worker.name)).filter(id => /^[0-9a-f]{64}$/.test(id));
        if (className === "OverseerDurableObject") {
          if (overseerWorker !== undefined && overseerWorker !== worker.name) throw new Error("Two workers declare the Overseer");
          overseerWorker = worker.name;
          // A namespace is opened by its binding's name, not its class's.
          const namespace = await mf.getDurableObjectNamespace(bindingName, worker.name);
          for (const id of ids) {
            const stub = namespace.get(namespace.idFromString(id)) as unknown as { exportWorkspaceRecords?: () => Promise<unknown> };
            if (typeof stub.exportWorkspaceRecords !== "function") {
              throw new Error(`Workspace ${id} does not expose the merged kernel exportWorkspaceRecords method`);
            }
            // Copied out as plain data at once: an RPC result is a stub that dies with the runtime,
            // which stops before gadget state is read.
            workspaces.set(id, { exportWorkspaceRecords: async () => JSON.parse(JSON.stringify(await stub.exportWorkspaceRecords!())) });
          }
        } else if (ids.length) gadgetDurableObjects.push({ namespace: className, ids });
      }
    }
    let closed = false;
    const closeRuntime = async () => { if (!closed) { closed = true; await disposeBounded(mf); } };
    const gadgetState = overseerWorker === undefined ? undefined : {
      // Miniflare persists a class's objects at <state>/do/<worker>-<class>/.
      durableObjectDirectory: join(manifest.stateDirectory, "do", `${overseerWorker}-OverseerDurableObject`),
      allowList: manifest.resources.exportGadgetState ?? [],
      scratchDirectory: bundleDirectory,
    };
    return { mf, bindings: { kv, r2, workspaces, gadgetDurableObjects, gadgetState, closeRuntime },
      cleanup: () => rmSync(bundleDirectory, { recursive: true, force: true }) };
  } catch (error) {
    try { await disposeBounded(mf); } catch { /* retain the original failure */ }
    rmSync(bundleDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv: string[]): Promise<void> {
  const parsed = args(argv);
  const manifest = readManifest(parsed.manifest!);
  const resources: StorageResourceNames = {
    kv: manifest.resources.kv.map(x => x.name),
    r2: manifest.resources.r2.map(x => x.name),
    exportKv: manifest.resources.exportKv,
    exportR2: manifest.resources.exportR2,
  };
  if (parsed.command === "plan") {
    console.log(JSON.stringify({ mode: "plan-only", tenantId: manifest.tenantId,
      kv: resources.kv, r2: resources.r2,
      exportAllowList: { kv: resources.exportKv ?? [], r2: resources.exportR2 ?? [] },
      withheld: [
        ...resources.kv.filter(name => credentialResource(name) || !(resources.exportKv ?? []).includes(name))
          .map(name => ({ kind: "kv", name, reason: credentialResource(name) ? "credential store" : "not on export allow-list" })),
        ...resources.r2.filter(name => credentialResource(name) || !(resources.exportR2 ?? []).includes(name))
          .map(name => ({ kind: "r2", name, reason: credentialResource(name) ? "credential store" : "not on export allow-list" })),
      ],
      durableObjects: "workspace allow-list export; gadget storage through resources.exportGadgetState, other keys by name",
      exportGadgetState: manifest.resources.exportGadgetState ?? [],
      remoteDeletion: "not performed; real Cloudflare deletion is a person-run step",
    }, null, 2));
    return;
  }
  if (parsed.command === "export-local") {
    // Run the export in its own process group, so a hung bundle or runtime start, and everything
    // it started, is killed at the deadline instead of holding a heavy-run slot.
    const result = await runInProcessGroup(process.execPath,
      [fileURLToPath(import.meta.url), CHILD_COMMAND, "--manifest", parsed.manifest!],
      { timeoutMs: parsed.timeoutMs, label: "export-local" });
    if (result.timedOut) throw new Error(result.message);
    if (result.code !== 0) process.exitCode = result.code ?? 1;
    return;
  }
  if (parsed.command === CHILD_COMMAND) {
    const { bindings, cleanup } = await openLocalBindings(manifest);
    try {
      const result = await exportCompanyStorage({ tenantId: manifest.tenantId, prefix: manifest.resourcePrefix,
        resources, bindings, outputDirectory: manifest.outputDirectory });
      console.log(JSON.stringify({ exported: true, tenantId: manifest.tenantId,
        path: join(manifest.outputDirectory, `company-${manifest.tenantId}-export.json`),
        keyValues: (result.kv as unknown[]).length, objects: (result.r2 as unknown[]).length,
        workspaces: (result.workspaces as unknown[]).length,
        gadgets: ((result.gadgetState as { workspaces: { gadgets: unknown[] }[] } | null)?.workspaces ?? [])
          .reduce((total, workspace) => total + workspace.gadgets.length, 0),
        otherDurableObjectNamespaces: (result.gadgetDurableObjects as unknown[]).length,
        structureDigest: result.structureDigest }, null, 2));
    } finally {
      try { await bindings.closeRuntime?.(); }
      finally { cleanup(); }
    }
    return;
  }
  if (parsed.apply) {
    const devRecord = join(manifest.wrapperRoot, ".wrangler", "local", "dev-server.json");
    try { readFileSync(devRecord); throw new Error("Stop the local wrapper before purging its state"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const token = process.env.INFEROPS_OFFBOARDING_TOKEN ?? "";
  const result = await purgeLocalCompany({ tenantId: manifest.tenantId, stateDirectory: manifest.stateDirectory,
    wrapperRoot: manifest.wrapperRoot, apply: parsed.apply,
    readStatus: parsed.apply
      ? httpStatusReader(manifest.inferopsBaseUrl, token)
      : async () => { throw new Error("Offboarding status is read only during --apply"); } });
  console.log(JSON.stringify({ ...result, mode: result.applied ? "local-purge-applied" : "dry-run" }, null, 2));
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
