import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseConsumerConfig, resolveConsumerConfig } from "./config.ts";

/** Select the wrapper's complete format set, retaining upstream defaults for older empty wrappers. */
export function consumerBlueprintDirectory(root: string): string | undefined {
  const directory = resolve(root, "blueprints");
  let stat;
  try { stat = lstatSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("The consumer blueprints directory must not be a symbolic link");
  }
  if (!stat.isDirectory()) throw new Error("The consumer blueprints path must be a directory");
  const entries = readdirSync(directory).filter(name => !name.startsWith(".") && name !== "README.md");
  return entries.length ? directory : undefined;
}

/** Run the pinned archive/compiler validation without overwriting the backend's generated module. */
export function validateConsumerBlueprints(root: string, upstream: string): void {
  const directory = consumerBlueprintDirectory(root);
  const scratch = mkdtempSync(join(tmpdir(), "inferos-blueprints-"));
  try {
    const env = { ...process.env };
    // Consumer sources, including an empty directory's fallback, take precedence over ambient settings.
    if (directory) env.BUNDLED_BLUEPRINTS_DIR = directory;
    else delete env.BUNDLED_BLUEPRINTS_DIR;
    execFileSync(process.execPath, [join(upstream, "packages/workshop-backend/scripts/build-bundled-blueprints.ts"), "--out", join(scratch, "blueprints.ts")], {
      cwd: upstream, stdio: "inherit", env,
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Fail before building when another local service already owns the selected port. */
export async function assertLocalPortAvailable(port: number): Promise<void> {
  for (const host of ["127.0.0.1", "::1"]) {
    await new Promise<void>((available, reject) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code ?? "")) available();
        else reject(new Error(`Local port ${port} is unavailable (${error.code ?? "unknown"}); choose a different local.port`));
      });
      server.listen({ host, port, exclusive: true }, () => server.close(error => error ? reject(error) : available()));
    });
  }
}

const featureSources = {
  composableViews: "packages/workshop-frontend/src/features/canvas/CanvasDialog.tsx",
  durableViews: "packages/workshop-backend/src/canvas-store.ts",
  customCloudflareCode: "scripts/consumer/extensions.ts",
} as const;

const unavailableFeatures = (config: ReturnType<typeof parseConsumerConfig>, upstream: string) =>
  (Object.keys(featureSources) as (keyof typeof featureSources)[])
    .filter(name => config.features[name] && !existsSync(join(upstream, featureSources[name])));

/** Check the actual submodule pin; configuration alone is not proof of the running revision. */
export function checkConsumer(root: string) {
  const { config, provenance } = resolveConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
  const upstream = join(root, "inferos");
  const head = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== config.upstream.revision) throw new Error("Submodule HEAD differs from configured upstream.revision");
  const tree = execFileSync("git", ["-C", root, "ls-files", "--stage", "inferos"], { encoding: "utf8" }).trim();
  if (!tree.startsWith(`160000 ${head} `)) throw new Error("The wrapper Git index must pin inferos at the configured revision");
  const modifiedUpstream = execFileSync("git", ["-C", upstream, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  const packageJson = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8"));
  if (typeof packageJson.packageManager !== "string" || !packageJson.packageManager.startsWith("pnpm@")) {
    throw new Error("Upstream does not declare its pnpm version");
  }
  const pending = ["InferOps fixture/remote adapter", "profile initialization not checked"];
  pending.push(...unavailableFeatures(config, upstream));
  return { config, provenance, upstream, packageManager: packageJson.packageManager as string, pending, modifiedUpstream };
}

/** Load the pinned fixture validator without copying its canonical schema into wrapper helpers. */
export async function validateConsumerFixture(root: string, upstream: string) {
  const script = join(upstream, "scripts/consumer/fixtures.ts");
  if (!existsSync(script)) throw new Error("Pinned revision lacks fixture validation; select a reviewed supporting pin");
  const { checkConsumerFixture } = await import(pathToFileURL(script).href);
  return checkConsumerFixture(root);
}

/** Read-only preflight results; passing checks do not prove application or cloud health. */
export interface ConsumerDiagnostic {
  /** Stable check name for coding agents and terminal output. */
  name: string;
  /** Errors block local startup; warnings describe unimplemented or unverified behavior. */
  status: "pass" | "warning" | "error";
  /** Actionable explanation without credentials or subprocess output. */
  message: string;
}

/** Inspect local prerequisites without installing packages, starting Workers or contacting providers. */
export async function diagnoseConsumer(root: string) {
  const checks: ConsumerDiagnostic[] = [];
  const add = (name: string, status: ConsumerDiagnostic["status"], message: string) => checks.push({ name, status, message });
  const [major, minor] = process.versions.node.split(".").map(Number);
  add("node", major > 22 || (major === 22 && minor >= 18) ? "pass" : "error", `Node ${process.versions.node}; requires Node 22.18 or later`);
  let consumer: ReturnType<typeof checkConsumer>;
  try {
    consumer = checkConsumer(root);
    add("configuration", "pass", "Configuration, submodule HEAD and staged gitlink agree");
  } catch (error) {
    add("configuration", "error", error instanceof SyntaxError ? "Invalid JSON configuration"
      : error instanceof Error && !("status" in error) && !("code" in error) ? error.message
      : "Cannot read the consumer configuration or submodule; initialize the pinned submodule and run inferos:check");
    return { ok: false, checks, runtimeReady: false };
  }
  const { config, upstream, packageManager, modifiedUpstream, pending } = consumer;
  try {
    const directory = consumerBlueprintDirectory(root);
    add("blueprints", "pass", directory ? "Wrapper blueprint sources selected; run pnpm blueprints:check to compile and validate"
      : "Empty wrapper blueprint directory; using pinned upstream defaults");
  } catch (error) { add("blueprints", "error", (error as Error).message); }
  add("upstream", modifiedUpstream ? "warning" : "pass", modifiedUpstream
    ? "Submodule has local changes; this is not an exact-revision verification"
    : `Clean checkout at ${config.upstream.revision}`);
  const requiredScripts = ["run-local.ts", "pnpm-command.ts", "relay-termination.ts"];
  const missing = requiredScripts.filter(file => !existsSync(join(upstream, "scripts", file)));
  add("runner", missing.length ? "error" : "pass", missing.length
    ? `Pinned revision lacks required native scripts: ${missing.join(", ")}` : "Native local runner is available");
  if (!missing.includes("pnpm-command.ts")) {
    try {
      const { pnpmCommand } = await import(pathToFileURL(join(upstream, "scripts/pnpm-command.ts")).href);
      const [binary, args] = pnpmCommand(["--version"]);
      const version = execFileSync(binary, args, { cwd: upstream, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
      const expected = packageManager.slice("pnpm@".length).split("+")[0];
      add("pnpm", version === expected ? "pass" : "error", version === expected
        ? `pnpm ${expected}` : `Package manager does not match ${packageManager}; use the wrapper's pinned pnpm`);
    } catch {
      add("pnpm", "error", "Cannot run pinned pnpm; install the packageManager version declared in package.json");
    }
  }
  const require = createRequire(join(upstream, "package.json"));
  const unresolved = ["wrangler", "vite", "vite-plus"].filter(name => {
    if (!existsSync(join(upstream, "node_modules", name, "package.json"))) return true;
    try { require.resolve(name); return false; } catch { return true; }
  });
  add("dependencies", unresolved.length ? "error" : "pass", unresolved.length
    ? `Run pnpm run setup; missing local tools: ${unresolved.join(", ")}`
    : "Local build tools resolve; frozen-lockfile installation and builds still validate the full dependency graph");
  try {
    await assertLocalPortAvailable(config.local.port);
    add("port", "pass", `Port ${config.local.port} is available now; this check does not reserve it`);
  } catch (error) { add("port", "error", (error as Error).message); }
  if (config.inferops.mode === "fixture") {
    try {
      await validateConsumerFixture(root, upstream);
      add("fixture", "pass", "Synthetic board matches the pinned schema and configured project; data loading remains pending");
    } catch { add("fixture", "error", "Run pnpm fixtures:check after setup; check the fixture schema, project reference and supporting pin"); }
  }
  const unsupported: string[] = unavailableFeatures(config, upstream);
  if (config.features.customCloudflareCode) {
    const extensionScript = join(upstream, "scripts/consumer/extensions.ts");
    try {
      if (!existsSync(extensionScript)) throw new Error("Pinned revision does not support custom Workers");
      const { readConsumerWorkers } = await import(pathToFileURL(extensionScript).href);
      const workers = readConsumerWorkers(root);
      add("extensions", "pass", `${workers.length} explicit custom Workers; run pnpm extensions:check to validate canonical configs`);
    } catch { add("extensions", "error", "Cannot validate custom Workers; check the manifest, contained paths and supported pin"); }
  }
  if (config.inferops.mode === "remote") unsupported.push("remote InferOps");
  add("runtime", unsupported.length ? "error" : "warning", unsupported.length
    ? `Startup is blocked by unavailable adapters: ${unsupported.join(", ")}`
    : "InferOps board data is mocked by the InferOps gatekeeper (no real InferOps adapter yet); profile:init separately initializes branding/instructions on a supported pin");
  return { ok: !checks.some(check => check.status === "error"), checks, runtimeReady: false, pending };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  if (!["check", "doctor", "blueprints", "extensions", "fixtures", "views", "canvas", "profile", "setup", "dev"].includes(command ?? "")) throw new Error("Usage: node .inferos/runtime.ts check|doctor|blueprints|extensions|fixtures|views|canvas|profile|setup|dev");
  if (command === "doctor") {
    const report = await diagnoseConsumer(root);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const { config, provenance, upstream, packageManager, pending, modifiedUpstream } = checkConsumer(root);
  if (command === "fixtures") {
    const result = await validateConsumerFixture(root, upstream);
    console.log(JSON.stringify({ ok: true, operation: "fixtures", ...result, runtimeReady: false }));
    return;
  }
  if (command === "views") {
    const script = join(upstream, "scripts/consumer/views.ts");
    if (!existsSync(script)) throw new Error("Pinned revision does not support starter view validation");
    execFileSync(process.execPath, [script, root], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "canvas") {
    const script = join(upstream, "scripts/consumer/canvas.ts");
    if (!existsSync(script)) throw new Error("Pinned revision does not support canvas configuration");
    execFileSync(process.execPath, [script, root, ...process.argv.slice(3)], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "extensions") {
    const script = join(upstream, "scripts/consumer/extensions.ts");
    if (!existsSync(script)) throw new Error("Pinned revision does not support custom Workers");
    execFileSync(process.execPath, [script, root], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "profile") {
    const script = join(upstream, "packages/workshop-backend/scripts/initialize-consumer-profile.ts");
    if (!existsSync(script)) throw new Error("Pinned InferOS revision does not support profile initialization; use a reviewed newer pin");
    execFileSync(process.execPath, [script, root], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "blueprints") {
    validateConsumerBlueprints(root, upstream);
    console.log(JSON.stringify({ ok: true, operation: "blueprints", source: consumerBlueprintDirectory(root) ? "wrapper" : "upstream" }));
    return;
  }
  if (command === "check") {
    console.log(JSON.stringify({ ok: true, revision: config.upstream.revision, modifiedUpstream, packageManager, profile: config.profile, features: config.features, styling: config.styling, provenance, pending }, null, 2));
    return;
  }
  const { pnpmCommand } = await import(pathToFileURL(join(upstream, "scripts/pnpm-command.ts")).href);
  if (command === "setup") {
    const [binary, args] = pnpmCommand(["install", "--frozen-lockfile"]);
    execFileSync(binary, args, { cwd: upstream, stdio: "inherit" });
    console.log(JSON.stringify({ ok: true, operation: "setup", pending }));
    return;
  }
  const requested = unavailableFeatures(config, upstream);
  if (requested.length || config.inferops.mode === "remote") {
    throw new Error("Requested consumer runtime adapters are not implemented; use check for details. No server was started.");
  }
  if (config.features.customCloudflareCode && !existsSync(join(upstream, "scripts/consumer/extensions.ts"))) {
    throw new Error("Pinned revision does not support custom Workers");
  }
  await validateConsumerFixture(root, upstream);
  await assertLocalPortAvailable(config.local.port);
  if (modifiedUpstream) console.error("The pinned InferOS checkout has local modifications; this run is not an exact-revision proof.");
  console.error("Starting the native Workshop baseline. InferOps board data is mocked by the InferOps gatekeeper; profile:init is a separate administrator operation.");
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_BACKEND_HOST: `localhost:${config.local.port}` };
  const blueprints = consumerBlueprintDirectory(root);
  if (blueprints) env.BUNDLED_BLUEPRINTS_DIR = blueprints;
  else delete env.BUNDLED_BLUEPRINTS_DIR;
  const child = spawn(process.execPath, [join(upstream, "scripts/run-local.ts"), "--port", String(config.local.port), ...(Object.values(config.features).some(Boolean) ? ["--consumer-root", root] : [])], {
    cwd: upstream, stdio: "inherit", env,
  });
  const { relayTermination } = await import(pathToFileURL(join(upstream, "scripts/relay-termination.ts")).href);
  relayTermination(child);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof SyntaxError ? "Invalid JSON configuration" : error.message);
    process.exitCode = 1;
  });
}
