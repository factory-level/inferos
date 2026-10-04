import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { initialConsumerConfig, type InitialConsumerOptions } from "./config.ts";
import { checkConsumer } from "./runtime.ts";
import { defaultConsumerSkillsManifest, SKILLS_MANIFEST } from "./skills.ts";
import { describeWrapperFiles, FILES_MANIFEST, managedFiles, renderFilesManifest, renderWrapperLockfile, WRAPPER_LOCKFILE } from "./wrapper-files.ts";

const here = dirname(fileURLToPath(import.meta.url));
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** The custom gatekeeper that serves InferOps boards and InferLab sign-in (`INFEROPS_GATEKEEPER` in dev-server-config.ts). */
const INFEROPS_GATEKEEPER = "gatekeeper-inferops";

/** Run a pinned consumer script in the staged wrapper, surfacing its own message rather than Git's or Node's. */
function runPinned(staging: string, script: string, args: string[], unsupported: string) {
  const path = join(staging, "inferos", script);
  if (!existsSync(path)) throw new Error(unsupported);
  const result = spawnSync(process.execPath, [path, ...args], { cwd: join(staging, "inferos"), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${script} failed`);
}

/**
 * Select the InferOps gatekeeper in `inferos.canvas.json`, and with `INFEROPS_ENABLED` offer the
 * starter board as the first screen template (the one `pnpm local seed` opens). The pinned canvas
 * CLI writes the file, so it is validated against what the pin actually builds.
 */
function selectInferOps(staging: string, targetRef: string, boards: boolean) {
  const canvas = (...args: string[]) => runPinned(staging, "scripts/consumer/canvas.ts", [staging, ...args],
    "Pinned revision does not support canvas configuration; select a reviewed newer pin or omit the InferOps capabilities");
  canvas("gatekeeper", "enable", INFEROPS_GATEKEEPER);
  if (boards) canvas("add-screen", "operations", "Operations", targetRef);
}

/** Run the staged wrapper's `inferos:check`, which refuses a version 2 file the pin cannot honour. */
function runPinnedCheck(staging: string) {
  const result = spawnSync(process.execPath, [join(staging, ".inferos/runtime.ts"), "check"], { cwd: staging, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "inferos:check failed for the new wrapper");
}

/**
 * Create a new wrapper atomically; reruns validate its pin without rewriting customizations. Options
 * shape only a new wrapper: a rerun never rewrites its configuration, whatever options it is given.
 */
export function bootstrapConsumer(target: string, repository: string, revision: string, options: InitialConsumerOptions = {}) {
  const config = initialConsumerConfig(repository, revision, options);
  const destination = resolve(target);
  if (existsSync(destination)) {
    if (!existsSync(join(destination, ".inferos/bootstrap.json"))) throw new Error("Destination exists and is not a managed consumer; choose a new directory");
    const existing = checkConsumer(destination);
    if (existing.config.upstream.repository !== repository || existing.config.upstream.revision !== revision) {
      throw new Error("Existing consumer has a different upstream pin; bootstrap does not perform upgrades (run pnpm inferos upgrade <sha> in the wrapper)");
    }
    return { created: false, destination, revision };
  }
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), `.${basename(destination)}-bootstrap-`));
  const git = (...args: string[]) => execFileSync("git", ["-C", staging, ...args], { stdio: "pipe" });
  try {
    git("init", "--quiet");
    // Local sources are allowed only when explicitly supplied as an absolute path, never via Git URL rewrites.
    const transport = repository.includes("://") ? [] : ["-c", "protocol.file.allow=always"];
    git(...transport, "submodule", "add", "--", repository, "inferos");
    execFileSync("git", ["-C", join(staging, "inferos"), "checkout", "--detach", revision], { stdio: "pipe" });
    git("add", "--", "inferos");
    for (const directory of [".inferos", "fixtures", "gatekeepers", "blueprints", "profiles", "workers", "views"]) mkdirSync(join(staging, directory));
    const bundledBlueprints = join(staging, "inferos/packages/bundled-blueprints/blueprints");
    if (!existsSync(bundledBlueprints)) throw new Error("Pinned revision does not include bundled blueprint sources");
    cpSync(bundledBlueprints, join(staging, "blueprints"), { recursive: true });
    // InferOS-owned files: the .inferos helpers, coding-agent skills, README, .gitignore and package.json.
    for (const [path, file] of managedFiles(join(staging, "inferos"))) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      writeFileSync(join(staging, path), file.content);
    }
    // Starter runtime skill packs; the wrapper owns them from here on, like blueprints/.
    cpSync(join(here, "skill-packs"), join(staging, "skills"), { recursive: true });
    writeFileSync(join(staging, SKILLS_MANIFEST), json(defaultConsumerSkillsManifest()));
    writeFileSync(join(staging, "inferos.config.json"), json(config));
    // Committed with the rest, so pnpm's dependency check before each script finds nothing to write.
    writeFileSync(join(staging, WRAPPER_LOCKFILE), renderWrapperLockfile(join(staging, "inferos")));
    writeFileSync(join(staging, ".inferos/bootstrap.json"), json({ version: 1, repository, revision }));
    writeFileSync(join(staging, "views/operations.json"), json({
      schemaVersion: 1, id: "operations", revision: "0", title: "Operations",
      sections: [{ id: "project-section", title: "Project board", columns: 1, widgets: [{
        id: "project-board", kind: "inferops.project-board", version: 1, targetRef: config.inferops.targetRef,
        size: "full", params: { workflow: "software", showCompleted: false },
      }] }],
    }));
    writeFileSync(join(staging, "inferos.extensions.json"), json({ schemaVersion: 1, workers: [{ id: "hello", directory: "workers/hello" }] }));
    mkdirSync(join(staging, "workers/hello"));
    writeFileSync(join(staging, "workers/hello/cloudflare.config.ts"), `import { defineGadgetsWorker } from "../../inferos/scripts/worker-config.ts";\n\nexport default defineGadgetsWorker({ name: "consumer-hello", entrypoint: "src.ts" });\n`);
    writeFileSync(join(staging, "workers/hello/src.ts"), `// Public demonstration endpoint. Add application authentication before serving private data.\nexport default { fetch() { return Response.json({ message: "Hello from the consumer Worker" }); } };\n`);
    writeFileSync(join(staging, "fixtures/project-board.json"), readFileSync(join(here, "project-board.json")));
    for (const directory of ["gatekeepers", "profiles"]) writeFileSync(join(staging, directory, ".gitkeep"), "");
    if (config.schemaVersion === 2) {
      const { INFEROPS_ENABLED, INFEROPS_AUTH } = config.capabilities;
      if (INFEROPS_ENABLED || INFEROPS_AUTH) selectInferOps(staging, config.inferops.targetRef, INFEROPS_ENABLED);
      // The wrapper's own check: the pin must parse version 2 and contain every requested capability.
      runPinnedCheck(staging);
    }
    checkConsumer(staging);
    // Last, so it records exactly what bootstrap (and the pinned canvas CLI) wrote.
    writeFileSync(join(staging, FILES_MANIFEST), renderFilesManifest(describeWrapperFiles(staging, revision, join(staging, "inferos"))));
    renameSync(staging, destination);
    return { created: true, destination, revision };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const usage = "Usage: node scripts/consumer/bootstrap.ts TARGET REPOSITORY COMMIT_SHA [--profile personal|inferops-operations] [--capability NAME ...]";
    let parsed;
    try {
      parsed = parseArgs({ allowPositionals: true, options: { profile: { type: "string" }, capability: { type: "string", multiple: true } } });
    } catch { throw new Error(usage); }
    const [target, repository, revision, extra] = parsed.positionals;
    if (!target || !repository || !revision || extra) throw new Error(usage);
    const { profile, capability } = parsed.values;
    if (profile !== undefined && profile !== "personal" && profile !== "inferops-operations") throw new Error(usage);
    const capabilities = (capability ?? []).flatMap(value => value.split(",")).map(name => name.trim()).filter(Boolean);
    console.log(json(bootstrapConsumer(target, repository, revision, { profile, capabilities: capabilities as InitialConsumerOptions["capabilities"] })));
  } catch (error) {
    // Git errors may echo credential-bearing remotes from local Git configuration.
    console.error(error instanceof Error && "status" in error ? "Git operation failed; check the source repository and commit pin" : error instanceof Error ? error.message : "Bootstrap failed");
    process.exitCode = 1;
  }
}
