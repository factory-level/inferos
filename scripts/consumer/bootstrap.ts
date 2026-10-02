import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialConsumerConfig } from "./config.ts";
import { checkConsumer } from "./runtime.ts";
import { defaultConsumerSkillsManifest, SKILLS_MANIFEST } from "./skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Create a new wrapper atomically; reruns validate its pin without rewriting customizations. */
export function bootstrapConsumer(target: string, repository: string, revision: string) {
  const config = initialConsumerConfig(repository, revision);
  const destination = resolve(target);
  if (existsSync(destination)) {
    if (!existsSync(join(destination, ".inferos/bootstrap.json"))) throw new Error("Destination exists and is not a managed consumer; choose a new directory");
    const existing = checkConsumer(destination);
    if (existing.config.upstream.repository !== repository || existing.config.upstream.revision !== revision) {
      throw new Error("Existing consumer has a different upstream pin; bootstrap does not perform upgrades");
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
    for (const file of ["config.ts", "runtime.ts"]) writeFileSync(join(staging, ".inferos", file), readFileSync(join(here, file)));
    for (const skill of ["bootstrap-inferos", "skill-upload"]) {
      const skillDirectory = join(staging, ".agents/skills", skill);
      mkdirSync(skillDirectory, { recursive: true });
      writeFileSync(join(skillDirectory, "SKILL.md"), readFileSync(join(here, "../../.agents/skills", skill, "SKILL.md")));
    }
    // Starter runtime skill packs; the wrapper owns them from here on, like blueprints/.
    cpSync(join(here, "skill-packs"), join(staging, "skills"), { recursive: true });
    writeFileSync(join(staging, SKILLS_MANIFEST), json(defaultConsumerSkillsManifest()));
    writeFileSync(join(staging, "inferos.config.json"), json(config));
    writeFileSync(join(staging, ".inferos/bootstrap.json"), json({ version: 1, repository, revision }));
    const upstreamPackage = JSON.parse(readFileSync(join(staging, "inferos/package.json"), "utf8"));
    writeFileSync(join(staging, "package.json"), json({
      name: "inferos-consumer", private: true, type: "module", packageManager: upstreamPackage.packageManager,
      engines: { node: ">=22.18.0" },
      scripts: { "inferos:check": "node .inferos/runtime.ts check", "profile:init": "node .inferos/runtime.ts profile", "extensions:check": "node .inferos/runtime.ts extensions", "views:check": "node .inferos/runtime.ts views", canvas: "node .inferos/runtime.ts canvas", "fixtures:check": "node .inferos/runtime.ts fixtures", "blueprints:check": "node .inferos/runtime.ts blueprints", "skills:check": "node .inferos/runtime.ts skills", "skills:install": "node .inferos/runtime.ts skills-install", "skills:upload": "node .inferos/runtime.ts skills-upload", doctor: "node .inferos/runtime.ts doctor", setup: "node .inferos/runtime.ts setup", dev: "node .inferos/runtime.ts dev" },
    }));
    writeFileSync(join(staging, ".gitignore"), "node_modules/\n.wrangler/\n.env*\n.dev.vars*\n.inferos/state/\nwrangler.consumer.jsonc\n");
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
    writeFileSync(join(staging, "README.md"), `# InferOS consumer\n\nPinned InferOS with a synthetic project/board fixture and explicit feature/profile configuration.\n\nRun \`pnpm inferos:check\`, then \`pnpm run setup\` and \`pnpm run doctor\`. Doctor checks local prerequisites and reports pending adapters; a passing preflight is not runtime health verification. \`pnpm dev\` runs the native Workshop baseline on the configured port. Use Node 22.18+ and the packageManager version in package.json.\n\nNew wrappers materialize the inferops-operations profile: composable and durable views enabled, custom Workers disabled, compact listing density and system theme. These explicit settings survive later profile changes; inspect effective settings and per-field provenance with \`pnpm inferos:check\`. On supporting pins, omit individual features/styling fields to inherit the selected profile. To disable composition in the operations profile, explicitly disable both view flags.\n\nRun \`pnpm fixtures:check\` after editing fixtures/project-board.json. It validates the pinned canonical board schema, identifiers and state/workflow relationships without printing records. Doctor and dev enforce this validation too. The selected project identifier must match inferops.targetRef. The fixture follows InferOps board wire fields; it is not a copied production database. InferOps data is mocked (the InferOps gatekeeper serves synthetic boards) and check reports that status. Run \`pnpm canvas list\` to see the widget kinds, blueprint widgets, screen templates and custom gatekeepers this pin builds, and \`pnpm canvas enable|disable|add-screen\` to choose what canvases offer; the choices live in inferos.canvas.json. On a supported pin, \`pnpm profile:init\` initializes site name, profile instructions, fallback theme and listing density using an INFEROS_ADMIN_SESSION environment variable from a signed-in local deployment administrator. It preserves existing customizations and never reapplies after initialization; use the admin UI for later name/instruction changes and the admin API for fallback theme and density. Enabling an unavailable runtime feature fails startup rather than silently ignoring it.\n\nThe blueprints/ directory contains editable copies of the pinned standard formats. Run \`pnpm blueprints:check\` after edits, then restart development to install updates. The directory is the complete format set; it replaces upstream defaults. Restart after source edits to refresh installed templates; existing gadgets keep their own code. Bootstrap reruns preserve these files.\n\nCustom Workers are listed explicitly in inferos.extensions.json. On a supported pin, enable features.customCloudflareCode and run \`pnpm extensions:check\`; \`pnpm dev\` then serves the included public example at /extensions/hello. Disabled Workers are not loaded. Their routes are public; each Worker owns its authentication. Cloud extension deployment remains pending.\n\nThe views/operations.json starter uses the guarded project-board contract and the configured InferOps target. On a supporting pin, \`pnpm views:check\` validates definitions, not data access or runtime readiness. On supporting pins, enable composableViews to edit temporary layouts on the workspace Canvas page; add durableViews to save compositions. Import the starter there. Board cards explicitly remain unconnected until the InferOps data adapter ships.\n\nSkills come in two kinds. Coding-agent skills live in .agents/skills/: bootstrap-inferos and skill-upload ship with the wrapper, and \`pnpm skills:install [source --skill name]\` adds more with the pinned skills.sh CLI (default: Anthropic's skill-creator), recording them in skills-lock.json. Runtime skills for the Workshop agent live in skills/<pack>/<skill>/SKILL.md; inferos.skills.json maps the starter packs operate, build and shared to one public Context Library collection each, and a pack's include list publishes installed coding-agent skills too (build includes skill-creator). Run \`pnpm skills:check\` after edits. With \`pnpm dev\` running, \`pnpm skills:upload [pack...] [--dry-run] [--prune]\` publishes the packs using the same INFEROS_ADMIN_SESSION as profile:init; uploaded skills appear as / commands in Workshop chat. Uploads are local-only and change nothing without the session; --prune deletes collection files that no longer exist locally.\n\nKeep custom code in workers/, gatekeepers/, blueprints/, profiles/ and skills/. Never edit generated wrangler.jsonc. Local state is currently managed by the pinned native runner under inferos/.wrangler. Cloud topology and lifecycle parity remain tracked work.\n\nClone this wrapper with \`git clone --recurse-submodules\`. Review and commit the generated files, including the gitlink and .gitmodules, to publish your own fork. Secrets belong in uncommitted .dev.vars, not inferos.config.json.\n`);
    checkConsumer(staging);
    renameSync(staging, destination);
    return { created: true, destination, revision };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [target, repository, revision, extra] = process.argv.slice(2);
    if (!target || !repository || !revision || extra) throw new Error("Usage: node scripts/consumer/bootstrap.ts TARGET REPOSITORY COMMIT_SHA");
    console.log(json(bootstrapConsumer(target, repository, revision)));
  } catch (error) {
    // Git errors may echo credential-bearing remotes from local Git configuration.
    console.error(error instanceof Error && "status" in error ? "Git operation failed; check the source repository and commit pin" : error instanceof Error ? error.message : "Bootstrap failed");
    process.exitCode = 1;
  }
}
