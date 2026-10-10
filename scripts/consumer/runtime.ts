import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAPABILITY_NAMES, migrateConsumerConfig, parseConsumerConfig, resolveConsumerConfig } from "./config.ts";
import type { CapabilityName, ConsumerConfig, SettingSource } from "./config.ts";

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

/** The skills.sh CLI version `skills:install` runs, pinned so installs are reproducible. */
export const SKILLS_CLI = "skills@1.7.0";

/** The pinned source that makes an installation honour each `features` flag. */
export const featureSources = {
  // The composition contract, not a UI file: UI files are renamed as the page evolves.
  composableViews: "packages/workshop-shared/src/canvas.ts",
  durableViews: "packages/workshop-backend/src/canvas-store.ts",
  customCloudflareCode: "scripts/consumer/extensions.ts",
  inferlabLogin: "custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts",
} as const;

const unavailableFeatures = (config: ReturnType<typeof parseConsumerConfig>, upstream: string) =>
  (Object.keys(featureSources) as (keyof typeof featureSources)[])
    .filter(name => config.features[name] && !existsSync(join(upstream, featureSources[name])));

/**
 * The pinned source that makes an installation honour each capability, or null while no revision
 * ships one. The change that implements a capability registers its path here; until then switching
 * it on is an error. A mock or unflagged implementation does not count: nothing reads the flag.
 */
export const capabilitySources: Record<CapabilityName, string | null> = {
  // The gatekeeper's switch: off refuses new bindings and every call on existing ones (DISABLED).
  INFEROPS_ENABLED: "custom-gatekeepers/gatekeeper-inferops/src/enablement.ts",
  INFEROPS_CANVAS_STATE_MACHINE: null,
  HARNESS_HG_ENABLED: null,
  // The InferLab sign-in and per-person connect flows; `features.inferlabLogin` is its v1 spelling.
  INFEROPS_AUTH: "custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts",
  // The backend's publication records (#68): off refuses every publication operation and suspends
  // the publications of that kind; an admin approves each one, and nothing publishes by flag alone.
  PUBLISH_CLOUDFLAREOS_WIDGET: "packages/workshop-backend/src/publication.ts",
  PUBLISH_CLOUDFLAREOS_APP: "packages/workshop-backend/src/publication.ts",
  AGENT_DEPLOYMENTS: null,
  // The gatekeeper's coding-dispatch switch and repository allowlist (#69, #70): off refuses new
  // dispatch bindings and every call on existing ones (DISABLED).
  CODING_WORKBENCH_ENABLED: "custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts",
  // The gatekeeper's custom-table switch (MVP-20): off withholds the resource kind and refuses new
  // table bindings and every call on existing ones (DISABLED).
  INFEROPS_TABLES_ENABLED: "custom-gatekeepers/gatekeeper-inferops/src/table.ts",
  // The kernel's host-board switch (proposed): off refuses host-board registration and
  // publication, selection, acquisition and every read; the gatekeeper's facet checks it too.
  INFEROPS_HOST_BOARDS: "packages/workshop-backend/src/host-boards.ts",
  // The kernel's bound-view switch (proposed): off refuses bound-view registration, first
  // publication and every delivery.
  INFEROPS_BOUND_VIEWS: "packages/workshop-backend/src/console-store.ts",
};

const installed = (upstream: string, source: string | null) => source !== null && existsSync(join(upstream, source));

/** Capabilities switched on that the installation cannot honour. Callers fail on these; they never no-op. */
export function unsupportedCapabilities(config: ConsumerConfig, upstream: string, sources = capabilitySources): CapabilityName[] {
  return CAPABILITY_NAMES.filter(name => config.schemaVersion === 2 && config.capabilities[name] && !installed(upstream, sources[name]));
}

/** One capability's availability in this installation. It describes configuration, never a grant or activation. */
export interface CapabilityStatus {
  /** `enabled`: switched on and installed. `supported`: installed, switched off. `unsupported`: code absent. */
  state: "enabled" | "supported" | "unsupported";
  /** Whether the configuration switches it on; with `unsupported` that is an error. */
  requested: boolean;
  /** Where the requested value came from. Version 1 files cannot declare capabilities, so theirs are defaults. */
  source: SettingSource;
}

/** Report every capability truthfully against the pinned source, whatever the configuration asks for. */
export function reportCapabilities(resolved: ReturnType<typeof resolveConsumerConfig>, upstream: string, sources = capabilitySources) {
  const { config, provenance } = resolved;
  return Object.fromEntries(CAPABILITY_NAMES.map(name => {
    const requested = config.schemaVersion === 2 && config.capabilities[name];
    const state = !installed(upstream, sources[name]) ? "unsupported" : requested ? "enabled" : "supported";
    return [name, { state, requested, source: provenance.capabilities?.[name] ?? "default" }];
  })) as Record<CapabilityName, CapabilityStatus>;
}

/**
 * Whether the wrapper runs the InferOps gatekeeper today. With no `inferos.canvas.json` the launcher binds
 * every custom gatekeeper the pin builds; otherwise `customGatekeepers` decides ("all" or a list).
 */
export function inferOpsGatekeeperSelected(root: string, upstream: string): boolean {
  const built = existsSync(join(upstream, "custom-gatekeepers/gatekeeper-inferops/wrangler.jsonc"));
  const path = join(root, "inferos.canvas.json");
  if (!existsSync(path)) return built;
  let selected: unknown;
  try { selected = JSON.parse(readFileSync(path, "utf8"))?.customGatekeepers; } catch { throw new Error("inferos.canvas.json is not valid JSON"); }
  return selected === "all" ? built : Array.isArray(selected) && selected.includes("gatekeeper-inferops") && built;
}

/**
 * Rewrite a version 1 `inferos.config.json` as version 2 in place (`pnpm inferos config migrate`), carrying
 * over whether the gatekeeper runs. Refuses, writing nothing, when the pin could not honour the result.
 * A version 2 file is left untouched.
 */
export async function migrateWrapperConfig(root: string, upstream: string) {
  const path = join(root, "inferos.config.json");
  const input = JSON.parse(readFileSync(path, "utf8"));
  if (parseConsumerConfig(input).schemaVersion === 2) return { ok: true, operation: "config-migrate", migrated: false, schemaVersion: 2 };
  const migrated = migrateConsumerConfig(input, { inferOpsGatekeeperSelected: inferOpsGatekeeperSelected(root, upstream) });
  const config = parseConsumerConfig(migrated);
  const blocked = unsupportedCapabilities(config, upstream);
  if (blocked.length) throw new Error(`Migration would enable capabilities this installation does not support: ${blocked.join(", ")}. Nothing was written.`);
  const script = join(upstream, "scripts/consumer/config.ts");
  let readable = existsSync(script);
  if (readable) {
    try { (await import(pathToFileURL(script).href)).parseConsumerConfig(migrated); } catch { readable = false; }
  }
  if (!readable) throw new Error(`Pinned revision does not support ${unsupportedSchema}. Nothing was written.`);
  writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
  return { ok: true, operation: "config-migrate", migrated: true, schemaVersion: 2, capabilities: config.schemaVersion === 2 ? config.capabilities : null };
}

/** The pinned launcher parses the same file, so a version 2 file needs a pin whose parser accepts it. */
export async function pinnedSchemaSupported(root: string, upstream: string, config: ConsumerConfig): Promise<boolean> {
  if (config.schemaVersion === 1) return true;
  const script = join(upstream, "scripts/consumer/config.ts");
  if (!existsSync(script)) return false;
  try {
    const pinned = await import(pathToFileURL(script).href);
    pinned.parseConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
    return true;
  } catch { return false; }
}

const unsupportedSchema = "configuration schemaVersion 2 (keep version 1 or select a reviewed supporting pin)";

/** Check the actual submodule pin; configuration alone is not proof of the running revision. */
export function checkConsumer(root: string) {
  const resolved = resolveConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
  const { config, provenance } = resolved;
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
  const capabilities = reportCapabilities(resolved, upstream);
  const blocked = unsupportedCapabilities(config, upstream);
  return { config, provenance, upstream, packageManager: packageJson.packageManager as string, pending, modifiedUpstream, capabilities, blocked };
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
  const unsupported: string[] = [...unavailableFeatures(config, upstream), ...consumer.blocked];
  if (!await pinnedSchemaSupported(root, upstream, config)) unsupported.push(unsupportedSchema);
  if (config.features.customCloudflareCode) {
    const extensionScript = join(upstream, "scripts/consumer/extensions.ts");
    try {
      if (!existsSync(extensionScript)) throw new Error("Pinned revision does not support custom Workers");
      const { readConsumerWorkers } = await import(pathToFileURL(extensionScript).href);
      const workers = readConsumerWorkers(root);
      add("extensions", "pass", `${workers.length} explicit custom Workers; run pnpm extensions:check to validate canonical configs`);
    } catch { add("extensions", "error", "Cannot validate custom Workers; check the manifest, contained paths and supported pin"); }
    const gatekeeperScript = join(upstream, "scripts/consumer/gatekeepers.ts");
    if (existsSync(gatekeeperScript)) {
      try {
        const module = await import(pathToFileURL(gatekeeperScript).href);
        // A pin that predates manifest-gated wrapper gatekeepers binds by directory alone.
        if (typeof module.readConsumerGatekeepers !== "function") {
          add("gatekeepers", "warning", "Pinned revision binds wrapper gatekeepers by directory, without a listing or connection.json");
        } else {
          const { accepted, refused } = module.readConsumerGatekeepers(root, upstream) as {
            accepted: { directory: string; status: string }[];
            refused: { name: string; severity: "error" | "notice"; reason: string }[];
          };
          const loaded = accepted.map(({ directory, status }) => `${basename(directory)} (${status})`);
          const errors = refused.filter(entry => entry.severity === "error");
          const summary = [
            `${accepted.length} wrapper gatekeepers load${loaded.length ? `: ${loaded.join(", ")}` : ""}`,
            ...refused.map(({ name, reason }) => `${name} is not loaded: ${reason}`),
          ].join("; ");
          add("gatekeepers", errors.length ? "error" : refused.length ? "warning" : "pass", summary);
        }
      } catch (error) {
        add("gatekeepers", "error", `Cannot validate wrapper gatekeepers: ${(error as Error).message}`);
      }
    }
  }
  const skillScript = join(upstream, "scripts/consumer/skills.ts");
  if (existsSync(join(root, "inferos.skills.json")) && existsSync(skillScript)) {
    try {
      const { checkConsumerSkills } = await import(pathToFileURL(skillScript).href);
      const { packs, warnings } = checkConsumerSkills(root);
      const skills = packs.reduce((total: number, pack: { skills: unknown[] }) => total + pack.skills.length, 0);
      add("skills", warnings.length ? "warning" : "pass", warnings.length ? warnings.join("; ")
        : `${skills} skills in ${packs.length} packs validate; run pnpm skills:upload against a running Workshop to publish them`);
    } catch (error) {
      add("skills", "error", error instanceof Error && error.message.includes("Cannot find package")
        ? "Run pnpm run setup before validating skill packs" : `Skill packs are invalid: ${(error as Error).message}`);
    }
  }
  if (config.inferops.mode === "remote") unsupported.push("remote InferOps");
  add("runtime", unsupported.length ? "error" : "warning", unsupported.length
    ? `Startup is blocked by unavailable adapters: ${unsupported.join(", ")}`
    : "InferOps board data is mocked by the InferOps gatekeeper (no real InferOps adapter yet); profile:init separately initializes branding/instructions on a supported pin");
  const settings = await diagnoseSettings(root, upstream, config, process.env);
  checks.push(settings.check);
  return { ok: !checks.some(check => check.status === "error"), checks, runtimeReady: false, pending, settings: settings.report };
}

/**
 * The `settings` doctor check: the pinned settings table validated against the wrapper's resolved
 * configuration and the shell. Every message is redacted (names and problems, never values); a pin
 * without the table is a warning, not an error.
 */
export async function diagnoseSettings(root: string, upstream: string, config: ConsumerConfig, env: NodeJS.ProcessEnv) {
  const script = join(upstream, "scripts/consumer/settings.ts");
  if (!existsSync(script)) {
    return { check: { name: "settings", status: "warning", message: "Pinned revision has no settings table; required settings are not validated" } as ConsumerDiagnostic, report: null };
  }
  try {
    const { validateSettings, settingsDiagnostic } = await import(pathToFileURL(script).href);
    const result = validateSettings(config, env, { inferOpsGatekeeperSelected: inferOpsGatekeeperSelected(root, upstream) });
    return { check: settingsDiagnostic(result) as ConsumerDiagnostic, report: { findings: result.findings, settings: result.settings } };
  } catch {
    return { check: { name: "settings", status: "error", message: "Cannot validate settings; run pnpm run setup and check inferos.canvas.json" } as ConsumerDiagnostic, report: null };
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  if (!["check", "doctor", "blueprints", "extensions", "fixtures", "views", "canvas", "profile", "local", "gatekeepers", "scaffold", "skills", "skills-upload", "skills-install", "setup", "dev", "intake", "config", "verify", "recover", "upgrade"].includes(command ?? "")) throw new Error("Usage: node .inferos/runtime.ts check|doctor|blueprints|extensions|fixtures|views|canvas|profile|local|gatekeepers|scaffold|skills|skills-upload|skills-install|setup|dev|intake|config|verify|recover|upgrade");
  if (command === "verify" || command === "recover" || command === "upgrade") {
    // Before the configuration check: these commands must answer for a broken wrapper too.
    const { runMaintenance } = await import("./maintenance.ts");
    process.exitCode = await runMaintenance(root, command, process.argv.slice(3));
    return;
  }
  if (command === "doctor") {
    const report = await diagnoseConsumer(root);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const { config, provenance, upstream, packageManager, pending, modifiedUpstream, capabilities, blocked } = checkConsumer(root);
  if (command === "config") {
    if (process.argv[3] !== "migrate" || process.argv.length !== 4) throw new Error("Usage: pnpm inferos config migrate");
    console.log(JSON.stringify(await migrateWrapperConfig(root, upstream), null, 2));
    return;
  }
  if (command === "intake") {
    const script = join(upstream, "scripts/consumer/intake.ts");
    if (!existsSync(script)) throw new Error("Pinned revision does not support customer intake; select a reviewed newer pin");
    const [action, file, ...rest] = process.argv.slice(3);
    if (action !== "apply" || !file) throw new Error("Usage: pnpm inferos intake apply <file> [--file-issues OWNER/REPO] [--inferops]");
    // The pinned script prints its own result or error; relay only its exit status.
    const result = spawnSync(process.execPath, [script, "apply", root, resolve(file), ...rest], { cwd: upstream, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
    return;
  }
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
  if (command === "gatekeepers") {
    const script = join(upstream, "scripts/consumer/gatekeepers.ts");
    if (!existsSync(script)) throw new Error("Pinned revision does not support wrapper gatekeepers; use a reviewed newer pin");
    execFileSync(process.execPath, [script, root, ...process.argv.slice(3)], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "scaffold") {
    const script = join(upstream, "scripts/scaffold-gatekeeper.ts");
    if (!existsSync(script)) throw new Error("Pinned revision has no connector scaffolder; use a reviewed newer pin");
    execFileSync(process.execPath, [script, ...process.argv.slice(3), "--consumer-root", root], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "profile") {
    const script = join(upstream, "packages/workshop-backend/scripts/initialize-consumer-profile.ts");
    if (!existsSync(script)) throw new Error("Pinned InferOS revision does not support profile initialization; use a reviewed newer pin");
    execFileSync(process.execPath, [script, root], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "local") {
    const script = join(upstream, "scripts/local/lifecycle.ts");
    if (!existsSync(script)) throw new Error("Pinned InferOS revision does not support the local lifecycle (pnpm local); use a reviewed newer pin, or pnpm dev");
    const args = process.argv.slice(3);
    if (args[0] === "start") await assertStartable(root, { config, upstream, blocked, modifiedUpstream });
    await relayPinned(upstream, [script, ...localLifecycleArgs(root, args)], launchEnv(root, config));
    return;
  }
  if (command === "skills" || command === "skills-upload") {
    const script = join(upstream, command === "skills" ? "scripts/consumer/skills.ts" : "packages/workshop-backend/scripts/upload-consumer-skills.ts");
    if (!existsSync(script)) throw new Error("Pinned InferOS revision does not support skill packs; use a reviewed newer pin");
    execFileSync(process.execPath, [script, root, ...(command === "skills" ? [] : process.argv.slice(3))], { cwd: upstream, stdio: "inherit" });
    return;
  }
  if (command === "blueprints") {
    validateConsumerBlueprints(root, upstream);
    console.log(JSON.stringify({ ok: true, operation: "blueprints", source: consumerBlueprintDirectory(root) ? "wrapper" : "upstream" }));
    return;
  }
  if (command === "check") {
    const schemaSupported = await pinnedSchemaSupported(root, upstream, config);
    const ok = schemaSupported && !blocked.length;
    console.log(JSON.stringify({ ok, schemaVersion: config.schemaVersion, revision: config.upstream.revision, modifiedUpstream, packageManager, profile: config.profile, features: config.features, styling: config.styling, capabilities, provenance, pending }, null, 2));
    if (!schemaSupported) throw new Error(`Pinned revision does not support ${unsupportedSchema}`);
    if (!ok) throw new Error(`Enabled capabilities are not supported by this installation: ${blocked.join(", ")}`);
    return;
  }
  const { pnpmCommand } = await import(pathToFileURL(join(upstream, "scripts/pnpm-command.ts")).href);
  if (command === "skills-install") {
    // The skills.sh CLI, pinned, writes .agents/skills/<name>, agent links and skills-lock.json in the
    // wrapper. Packs publish those copies through their `include` lists; nothing is vendored twice.
    const source = process.argv.length > 3 ? process.argv.slice(3) : ["anthropics/skills", "--skill", "skill-creator"];
    const [binary, args] = pnpmCommand(["dlx", SKILLS_CLI, "add", ...source, "--yes"]);
    execFileSync(binary, args, { cwd: root, stdio: "inherit" });
    return;
  }
  if (command === "setup") {
    const [binary, args] = pnpmCommand(["install", "--frozen-lockfile"]);
    execFileSync(binary, args, { cwd: upstream, stdio: "inherit" });
    console.log(JSON.stringify({ ok: true, operation: "setup", pending }));
    return;
  }
  await assertStartable(root, { config, upstream, blocked, modifiedUpstream });
  await assertLocalPortAvailable(config.local.port);
  await relayPinned(upstream, [join(upstream, "scripts/run-local.ts"), ...devLaunchArgs(root, config)], launchEnv(root, config));
}

/**
 * The pinned `run-local.ts` arguments `dev` passes: the wrapper's own `local.port`, so two wrappers
 * listen apart, and `--consumer-root` whenever the wrapper has anything for the launcher to read
 * (a version 2 file's capabilities, or any feature flag, `customCloudflareCode` included).
 */
export function devLaunchArgs(root: string, config: ConsumerConfig): string[] {
  const consumerRoot = config.schemaVersion === 2 || Object.values(config.features).some(Boolean) ? ["--consumer-root", root] : [];
  return ["--port", String(config.local.port), ...consumerRoot];
}

/** Everything `dev` and `local start` refuse to start without; the port is checked by each launcher itself. */
async function assertStartable(root: string, { config, upstream, blocked, modifiedUpstream }: Pick<ReturnType<typeof checkConsumer>, "config" | "upstream" | "blocked" | "modifiedUpstream">) {
  if (blocked.length) throw new Error(`Enabled capabilities are not supported by this installation: ${blocked.join(", ")}. No server was started.`);
  if (!await pinnedSchemaSupported(root, upstream, config)) throw new Error(`Pinned revision does not support ${unsupportedSchema}. No server was started.`);
  if (unavailableFeatures(config, upstream).length || config.inferops.mode === "remote") {
    throw new Error("Requested consumer runtime adapters are not implemented; use check for details. No server was started.");
  }
  if (config.features.customCloudflareCode && !existsSync(join(upstream, "scripts/consumer/extensions.ts"))) {
    throw new Error("Pinned revision does not support custom Workers");
  }
  await validateConsumerFixture(root, upstream);
  if (modifiedUpstream) console.error("The pinned InferOS checkout has local modifications; this run is not an exact-revision proof.");
  console.error("Starting the native Workshop baseline. InferOps board data is mocked by the InferOps gatekeeper; profile:init is a separate administrator operation.");
}

/** The wrapper's port and blueprint directory, which take precedence over the shell's. */
function launchEnv(root: string, config: ConsumerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_BACKEND_HOST: `localhost:${config.local.port}` };
  const blueprints = consumerBlueprintDirectory(root);
  if (blueprints) env.BUNDLED_BLUEPRINTS_DIR = blueprints;
  else delete env.BUNDLED_BLUEPRINTS_DIR;
  return env;
}

/**
 * Point the pinned lifecycle operator at this wrapper. It runs from the pinned checkout, whose own
 * `inferos.canvas.json` is not the wrapper's, so `start` serves the wrapper (`--consumer-root`, after
 * any run-local flags), `seed` opens the wrapper's first screen template unless one is named, and
 * `runner`/`coding` read the wrapper's coding configuration (`--consumer-root`).
 */
export function localLifecycleArgs(root: string, args: readonly string[]): string[] {
  const separator = args.indexOf("--");
  const own = separator === -1 ? [...args] : args.slice(0, separator);
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  if (own[0] === "start") passthrough.push("--consumer-root", root);
  // The coding runner reads this wrapper's codingWorkbench.repos and keeps its state in .inferos/state.
  if ((own[0] === "runner" || own[0] === "coding") && !own.some(arg => arg === "--consumer-root" || arg.startsWith("--consumer-root="))) {
    own.push("--consumer-root", root);
  }
  if (own[0] === "seed" && !own.some(arg => arg === "--screen" || arg.startsWith("--screen="))) {
    const screen = firstScreenTemplate(root);
    if (screen) own.push("--screen", screen);
  }
  return passthrough.length ? [...own, "--", ...passthrough] : own;
}

/** The first screen template id in the wrapper's `inferos.canvas.json`; the dev server validates the file itself. */
function firstScreenTemplate(root: string): string | undefined {
  try {
    const id = JSON.parse(readFileSync(join(root, "inferos.canvas.json"), "utf8"))?.screens?.[0]?.id;
    return typeof id === "string" ? id : undefined;
  } catch { return undefined; }
}

/** Run a pinned script in the foreground; this process exits the way it does. */
async function relayPinned(upstream: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: upstream, stdio: "inherit", env });
  const { relayTermination } = await import(pathToFileURL(join(upstream, "scripts/relay-termination.ts")).href);
  relayTermination(child);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof SyntaxError ? "Invalid JSON configuration" : error.message);
    process.exitCode = 1;
  });
}
