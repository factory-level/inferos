import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { renderWorkerConfig } from "../generate-worker-configs.ts";
import { parseConsumerConfig } from "./config.ts";
import type { WranglerConfig } from "../release/manifest-lib.ts";

/** A deployer-owned Worker, explicitly listed rather than discovered by package name. */
export interface ConsumerWorker {
  /** Stable slug; also determines the /extensions/<id> route. */
  id: string;
  /** Absolute canonical Worker directory inside the wrapper's workers directory. */
  directory: string;
  /** Isolated router binding; never injected into an agent or gadget. */
  binding: string;
  /** Worker name, distinct from all native packages. */
  name: string;
}

/** Validate the manifest without importing or executing any custom configuration. */
export function readConsumerWorkers(root: string): ConsumerWorker[] {
  const config = parseConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
  // Disabled source is inert: even malformed or missing manifests must not activate code.
  if (!config.features.customCloudflareCode) return [];
  const manifest: unknown = JSON.parse(readFileSync(join(root, "inferos.extensions.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid extension manifest");
  const record = manifest as Record<string, unknown>;
  if (Object.keys(record).toSorted().join(",") !== "schemaVersion,workers" || record.schemaVersion !== 1 || !Array.isArray(record.workers) || record.workers.length > 32) {
    throw new Error("Extension manifest requires schemaVersion 1 and at most 32 workers");
  }
  const canonicalRoot = realpathSync(root);
  const names = new Set<string>();
  return record.workers.map((entry: unknown): ConsumerWorker => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid worker entry");
    const worker = entry as Record<string, unknown>;
    if (Object.keys(worker).toSorted().join(",") !== "directory,id" || typeof worker.id !== "string" ||
        worker.id.length > 40 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(worker.id) || typeof worker.directory !== "string") {
      throw new Error("Each worker requires a lowercase id and a relative directory");
    }
    if (names.has(worker.id)) throw new Error("Duplicate extension worker id");
    names.add(worker.id);
    if (isAbsolute(worker.directory) || worker.directory.includes("\\") || worker.directory.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("Worker directory must be a normalized relative path beneath workers/");
    }
    const directory = realpathSync(resolve(root, worker.directory));
    const rel = relative(canonicalRoot, directory);
    if (!rel.startsWith(`workers${sep}`) || rel.split(sep).includes("..") || !statSync(directory).isDirectory()) {
      throw new Error("Worker directory must remain inside the wrapper's workers directory");
    }
    // A connection package is a gatekeeper and belongs in gatekeepers/, where its contract is
    // checked; as an extension it would get a public route and no capability boundary at all.
    if (existsSync(join(directory, "connection.json"))) {
      throw new Error("A custom Worker holds a connection.json; connection packages belong in gatekeepers/, never workers/");
    }
        for (const filename of ["cloudflare.config.ts"]) {
      const source = realpathSync(join(directory, filename));
      if (!source.startsWith(directory + sep) || !statSync(source).isFile()) throw new Error("Worker config must remain inside its directory");
    }
    return { id: worker.id, directory, binding: `CONSUMER_${worker.id.replaceAll("-", "_").toUpperCase()}`, name: `consumer-${worker.id}` };
  });
}

const rejectsRemote = (value: unknown): boolean => !!value && typeof value === "object" &&
  Object.entries(value).some(([key, nested]) => (key === "remote" && nested === true) || rejectsRemote(nested));

/** Render canonical configs for local workerd without changing the pinned InferOS checkout. */
export async function prepareConsumerWorkers(root: string): Promise<(ConsumerWorker & { configPath: string })[]> {
  const workers = readConsumerWorkers(root);
  const names = new Set(workers.map(worker => worker.name));
  const directories = new Set(workers.map(worker => worker.directory));
  if (directories.size !== workers.length) throw new Error("Multiple extension entries cannot share a Worker directory");
  // Render and validate everything before writing any generated config.
  const rendered = await Promise.all(workers.map(async worker => {
    const config: WranglerConfig = parse(await renderWorkerConfig(worker.directory));
    if (config.name !== worker.name || !config.main) throw new Error("Worker config name must match consumer-<id> and declare an entrypoint");
    const main = realpathSync(resolve(worker.directory, config.main));
    if (!main.startsWith(worker.directory + sep) || !statSync(main).isFile()) throw new Error("Worker entrypoint must remain inside its directory");
    for (const service of config.services ?? []) {
      if (!names.has(service.service)) throw new Error("Custom Worker service bindings must name a listed consumer Worker");
    }
    // A local extension must not accidentally proxy a resource into a live Cloudflare account.
    if (rejectsRemote(config)) throw new Error("Remote bindings are not supported in consumer local development");
    try {
      if (lstatSync(join(worker.directory, "wrangler.consumer.jsonc")).isSymbolicLink()) throw new Error("Generated Worker config must not be a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (config.build) config.build = { ...config.build, cwd: worker.directory };
    return { worker, configPath: join(worker.directory, "wrangler.consumer.jsonc"), config };
  }));
  return rendered.map(({ worker, configPath, config }) => {
    writeFileSync(configPath, "// Generated from cloudflare.config.ts; do not edit.\n" + JSON.stringify(config, null, 2) + "\n");
    return { ...worker, configPath };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root || process.argv[3]) throw new Error("Usage: extensions.ts CONSUMER_ROOT");
  const workers = await prepareConsumerWorkers(resolve(root));
  console.log(JSON.stringify({ ok: true, workers: workers.map(({ id, name }) => ({ id, name, route: `/extensions/${id}` })) }));
}
