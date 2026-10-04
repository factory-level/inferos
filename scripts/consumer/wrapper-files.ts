// What InferOS writes into a wrapper, and who owns each file afterwards.
//
// Bootstrap records every file it writes in `.inferos/files.json` with one of three classes and the
// sha256 of the bytes it wrote. `upgrade` and `recover config` read that record to tell an untouched
// InferOS file (safe to refresh) from one the customer edited (never overwritten). The submodule
// itself is the fourth, `shared`, class: its gitlink is moved only by `upgrade --apply`.
//
// - `generated`: InferOS-owned and rewritten on every upgrade. Only `package.json` (just the keys
//   InferOS manages: `packageManager`, `engines` and its own `scripts` entries) and `.inferos/bootstrap.json`.
// - `copied-template`: InferOS files the customer may edit (the `.inferos/` helpers, the wrapper's
//   coding-agent skills, `README.md`, `.gitignore`). Refreshed only while unedited.
// - `customer-owned`: starters the customer is expected to edit (configuration, blueprints, skill
//   packs, fixtures, views, workers). Never rewritten after bootstrap; `source` names the upstream
//   file a starter was copied from, so an upgrade can report that upstream changed.
//
// The recorded hashes are also the merge base a later three-way template merge (#75) needs.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout this module belongs to; templates are rendered from it. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where bootstrap records the files it wrote. */
export const FILES_MANIFEST = ".inferos/files.json";

/** Version of the `.inferos/files.json` format. */
export const FILES_SCHEMA_VERSION = 1;

/** Ownership of one wrapper file; see the module comment. */
export type FileClass = "generated" | "copied-template" | "customer-owned";

/** One recorded file. */
export interface FileEntry {
  class: FileClass;
  /** sha256 of what InferOS last wrote, or null when that is unknown (a wrapper that predates the record). */
  sha256: string | null;
  /** The upstream path (relative to an InferOS checkout) the content came from, when it was copied. */
  source?: string;
}

/** The parsed `.inferos/files.json`. */
export interface FilesManifest {
  schemaVersion: typeof FILES_SCHEMA_VERSION;
  /** The InferOS revision the record describes. */
  revision: string;
  /** The submodule path, shared by InferOS and the wrapper: its gitlink is the pin. */
  shared: string[];
  files: Record<string, FileEntry>;
}

/** sha256 of file content, hex encoded. */
export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The coding-agent skills every wrapper carries in `.agents/skills/<name>/SKILL.md`. */
export const WRAPPER_SKILLS = ["bootstrap-inferos", "skill-upload", "local-coding", "verify-inferos", "upgrade-inferos", "recover-inferos"] as const;

/** The `.inferos/` helpers copied from `scripts/consumer/`, so a wrapper can drive an older pin. */
export const WRAPPER_HELPERS = ["config.ts", "runtime.ts", "maintenance.ts"] as const;

/** The package.json scripts InferOS manages; any other script is the customer's. */
export const WRAPPER_SCRIPTS: Record<string, string> = {
  inferos: "node .inferos/runtime.ts", "inferos:check": "node .inferos/runtime.ts check", "profile:init": "node .inferos/runtime.ts profile",
  local: "node .inferos/runtime.ts local", "extensions:check": "node .inferos/runtime.ts extensions", "gatekeepers:check": "node .inferos/runtime.ts gatekeepers",
  "gatekeepers:generate": "node .inferos/runtime.ts gatekeepers --write", "views:check": "node .inferos/runtime.ts views", canvas: "node .inferos/runtime.ts canvas",
  "fixtures:check": "node .inferos/runtime.ts fixtures", "blueprints:check": "node .inferos/runtime.ts blueprints", "skills:check": "node .inferos/runtime.ts skills",
  "skills:install": "node .inferos/runtime.ts skills-install", "skills:upload": "node .inferos/runtime.ts skills-upload", doctor: "node .inferos/runtime.ts doctor",
  setup: "node .inferos/runtime.ts setup", dev: "node .inferos/runtime.ts dev",
};

const GITIGNORE = "node_modules/\n.wrangler/\n.env*\n.dev.vars*\n.inferos/state/\nwrangler.consumer.jsonc\nwrangler.dev.jsonc\n";

const README = `# InferOS consumer\n\nPinned InferOS with a synthetic project/board fixture and explicit feature/profile configuration.\n\nRun \`pnpm inferos:check\`, then \`pnpm run setup\` and \`pnpm run doctor\`. Doctor checks local prerequisites and reports pending adapters; a passing preflight is not runtime health verification. \`pnpm dev\` runs the native Workshop baseline on the configured port. On a supporting pin, \`pnpm local status|start|stop|seed|verify|reset|logs\` drives the same stack through the pinned lifecycle operator: \`start\` runs the dev checks and then serves this wrapper, \`seed\` prepares a local account, mock model, InferOps account and the first screen template in inferos.canvas.json, and \`verify\` reads the board as an agent would. Older pins without the operator fail explicitly. Use Node 22.18+ and the packageManager version in package.json.\n\nUnless bootstrapped with \`--profile personal\`, wrappers materialize the inferops-operations profile: composable and durable views enabled, custom Workers disabled, compact listing density and system theme. These explicit settings survive later profile changes; inspect effective settings and per-field provenance with \`pnpm inferos:check\`. On supporting pins, omit individual features/styling fields to inherit the selected profile. To disable composition in the operations profile, explicitly disable both view flags. A wrapper bootstrapped with \`--capability\` options is schema version 2: all eight capabilities are written explicitly, and INFEROPS_ENABLED or INFEROPS_AUTH also select the InferOps gatekeeper in inferos.canvas.json (INFEROPS_ENABLED adds the starter board as its first screen template). Capabilities are deployer choices; no profile switches one on.\n\nRun \`pnpm fixtures:check\` after editing fixtures/project-board.json. It validates the pinned canonical board schema, identifiers and state/workflow relationships without printing records. Doctor and dev enforce this validation too. The selected project identifier must match inferops.targetRef. The fixture follows InferOps board wire fields; it is not a copied production database. InferOps data is mocked (the InferOps gatekeeper serves synthetic boards) and check reports that status. Run \`pnpm canvas list\` to see the widget kinds, blueprint widgets, screen templates and custom gatekeepers this pin builds, and \`pnpm canvas enable|disable|add-screen\` to choose what canvases offer; the choices live in inferos.canvas.json. On a supported pin, \`pnpm profile:init\` initializes site name, profile instructions, fallback theme and listing density using an INFEROS_ADMIN_SESSION environment variable from a signed-in local deployment administrator. It preserves existing customizations and never reapplies after initialization; use the admin UI for later name/instruction changes and the admin API for fallback theme and density. Enabling an unavailable runtime feature fails startup rather than silently ignoring it.\n\nThe blueprints/ directory contains editable copies of the pinned standard formats. Run \`pnpm blueprints:check\` after edits, then restart development to install updates. The directory is the complete format set; it replaces upstream defaults. Restart after source edits to refresh installed templates; existing gadgets keep their own code. Bootstrap reruns preserve these files.\n\nCustom Workers are listed explicitly in inferos.extensions.json. On a supported pin, enable features.customCloudflareCode and run \`pnpm extensions:check\`; \`pnpm dev\` then serves the included public example at /extensions/hello. Disabled Workers are not loaded. Their routes are public; each Worker owns its authentication. Cloud extension deployment remains pending.\n\nWrapper-owned gatekeepers live in gatekeepers/gatekeeper-<name>/, each with a cloudflare.config.ts (whose Worker name is the directory name) and the wrangler.jsonc generated from it; a directory without either is a library and never runs. With features.customCloudflareCode on, \`pnpm gatekeepers:generate\` writes those wrangler.jsonc files, \`pnpm gatekeepers:check\` fails when one has drifted, and \`pnpm dev\` binds each to the backend as GATEKEEPER_<NAME> and serves it at /gatekeeper/<name> on the same origin as /api. A name the pinned InferOS already uses is rejected. Their dependencies must resolve from the wrapper. They are local-only: the release manifest does not package them yet.\n\nThe views/operations.json starter uses the guarded project-board contract and the configured InferOps target. On a supporting pin, \`pnpm views:check\` validates definitions, not data access or runtime readiness. On supporting pins, enable composableViews to edit temporary layouts on the workspace Canvas page; add durableViews to save compositions. Import the starter there. Board cards explicitly remain unconnected until the InferOps data adapter ships.\n\nSkills come in two kinds. Coding-agent skills live in .agents/skills/: bootstrap-inferos, skill-upload, local-coding, verify-inferos, upgrade-inferos and recover-inferos ship with the wrapper, and \`pnpm skills:install [source --skill name]\` adds more with the pinned skills.sh CLI (default: Anthropic's skill-creator), recording them in skills-lock.json. Runtime skills for the Workshop agent live in skills/<pack>/<skill>/SKILL.md; inferos.skills.json maps the starter packs operate, build and shared to one public Context Library collection each, and a pack's include list publishes installed coding-agent skills too (build includes skill-creator). Run \`pnpm skills:check\` after edits. With \`pnpm dev\` running, \`pnpm skills:upload [pack...] [--dry-run] [--prune]\` publishes the packs using the same INFEROS_ADMIN_SESSION as profile:init; uploaded skills appear as / commands in Workshop chat. Uploads are local-only and change nothing without the session; --prune deletes collection files that no longer exist locally.\n\nWith CODING_WORKBENCH_ENABLED and codingWorkbench.repos, \`pnpm local coding doctor\` checks and \`pnpm local runner start|status|stop\` runs the pinned InferOps coding runner in patch mode from INFEROPS_CLI, with its service key in .dev.vars and its state in .inferos/state/runner; follow .agents/skills/local-coding/SKILL.md.\n\nKeep custom code in workers/, gatekeepers/, blueprints/, profiles/ and skills/. Never edit generated wrangler.jsonc. Local state is currently managed by the pinned native runner under inferos/.wrangler. Cloud topology and lifecycle parity remain tracked work.\n\nMaintenance: \`pnpm inferos verify\` runs check, doctor and local status (and local verify while the stack runs) and prints one JSON report. \`pnpm inferos upgrade <full-sha>\` plans a pin change (the default, \`--plan\`) and \`--apply\` performs it on a clean tree: it moves the submodule, refreshes InferOS files you have not edited and reports edited ones as needs-review instead of overwriting them. \`pnpm inferos recover ports|config|fixtures|state\` describes a repair and changes nothing without \`--apply\`. .inferos/files.json records which files InferOS wrote and who owns them; follow the verify-inferos, upgrade-inferos and recover-inferos skills.\n\nClone this wrapper with \`git clone --recurse-submodules\`. Review and commit the generated files, including the gitlink and .gitmodules, to publish your own fork. Secrets belong in uncommitted .dev.vars, not inferos.config.json.\n\nTo configure a customer, keep its reviewed intake in this repository (for example intake/customer.json) and run \`pnpm inferos intake apply intake/customer.json\`. It derives the InferOps capabilities, profile, a starter view and screen template from the intake, writes intake-report.json and intake-report.md with a disposition for every requirement, and records the fields it manages in .inferos/intake-managed.json so reruns keep your edits and report conflicts instead of overwriting them. Add \`--file-issues OWNER/REPO\` to file the drafted gap issues with gh. It never deploys. \`pnpm inferos config migrate\` rewrites a version 1 inferos.config.json as version 2.\n`;

/** One InferOS-owned file as this checkout renders it. */
export interface ManagedFile {
  class: "generated" | "copied-template";
  content: string;
  source?: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** The managed package.json keys for a pin: its pnpm version, the Node floor and InferOS's scripts. */
function packageJsonKeys(pin: string) {
  const upstream = JSON.parse(readFileSync(join(pin, "package.json"), "utf8"));
  return { packageManager: upstream.packageManager as string, engines: { node: ">=22.18.0" }, scripts: WRAPPER_SCRIPTS };
}

/**
 * Merge the managed package.json keys into a wrapper's package.json, keeping every key and script the
 * customer added. With no existing file this is the package.json bootstrap writes.
 */
export function renderPackageJson(pin: string, existing?: string): string {
  const managed = packageJsonKeys(pin);
  if (existing === undefined) return json({ name: "inferos-consumer", private: true, type: "module", ...managed });
  const current = JSON.parse(existing);
  return json({ ...current, packageManager: managed.packageManager, engines: managed.engines, scripts: { ...current.scripts, ...managed.scripts } });
}

/**
 * Every generated and copied-template file this checkout writes into a wrapper pinned at `pin` (the
 * submodule checkout, which supplies the pnpm version). `.inferos/bootstrap.json` is written by its
 * callers, which know the repository and revision.
 */
export function managedFiles(pin: string): Map<string, ManagedFile> {
  const files = new Map<string, ManagedFile>();
  const copy = (path: string, source: string) => files.set(path, { class: "copied-template", source, content: readFileSync(join(REPO, source), "utf8") });
  for (const helper of WRAPPER_HELPERS) copy(`.inferos/${helper}`, `scripts/consumer/${helper}`);
  for (const skill of WRAPPER_SKILLS) copy(`.agents/skills/${skill}/SKILL.md`, `.agents/skills/${skill}/SKILL.md`);
  files.set("README.md", { class: "copied-template", content: README });
  files.set(".gitignore", { class: "copied-template", content: GITIGNORE });
  files.set("package.json", { class: "generated", content: renderPackageJson(pin) });
  return files;
}

/** Customer-owned starters bootstrap copies from an InferOS checkout: wrapper prefix → upstream prefix. */
const STARTER_SOURCES: readonly [string, string][] = [
  ["blueprints/", "packages/bundled-blueprints/blueprints/"],
  ["skills/", "scripts/consumer/skill-packs/"],
  ["fixtures/project-board.json", "scripts/consumer/project-board.json"],
];

/** The upstream source of a customer-owned starter, if it was copied from one. */
export function starterSource(path: string): string | undefined {
  for (const [prefix, upstream] of STARTER_SOURCES) {
    if (path === prefix) return upstream;
    if (prefix.endsWith("/") && path.startsWith(prefix)) return upstream + path.slice(prefix.length);
  }
  return undefined;
}

/** Every regular file under `root`, relative and `/`-separated, skipping `.git`, the submodule and the record itself. */
function wrapperFiles(root: string, directory = root): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const rel = relative(root, path).split(sep).join("/");
    if (rel === ".git" || rel === "inferos" || rel === FILES_MANIFEST || rel === ".inferos/state") continue;
    const stat = lstatSync(path);
    if (stat.isDirectory()) found.push(...wrapperFiles(root, path));
    else if (stat.isFile()) found.push(rel);
  }
  return found;
}

/** Classify and hash every file a freshly bootstrapped wrapper contains. */
export function describeWrapperFiles(root: string, revision: string, pin: string): FilesManifest {
  const managed = managedFiles(pin);
  const files: Record<string, FileEntry> = {};
  for (const path of wrapperFiles(root).toSorted()) {
    const content = readFileSync(join(root, path));
    const known = managed.get(path);
    const entry: FileEntry = path === ".inferos/bootstrap.json" ? { class: "generated", sha256: sha256(content) }
      : known ? { class: known.class, sha256: sha256(content), ...(known.source ? { source: known.source } : {}) }
      : { class: "customer-owned", sha256: sha256(content), ...(starterSource(path) ? { source: starterSource(path) } : {}) };
    files[path] = entry;
  }
  return { schemaVersion: FILES_SCHEMA_VERSION, revision, shared: ["inferos"], files };
}

/** Read `.inferos/files.json`, or null for a wrapper bootstrapped before it existed. */
export function readFilesManifest(root: string): FilesManifest | null {
  const path = join(root, FILES_MANIFEST);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.schemaVersion !== FILES_SCHEMA_VERSION || typeof manifest.files !== "object" || manifest.files === null) {
    throw new Error(`${FILES_MANIFEST} has an unsupported schemaVersion; use an InferOS revision that understands it`);
  }
  return manifest as FilesManifest;
}

/** Serialize a files record the way bootstrap and upgrade write it. */
export const renderFilesManifest = (manifest: FilesManifest) => json(manifest);
