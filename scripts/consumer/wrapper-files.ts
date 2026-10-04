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
//   coding-agent skills, `README.md`, `.gitignore`). Refreshed while unedited, reconciled three-way
//   once edited (`reconcile.ts`).
// - `customer-owned`: starters the customer is expected to edit (configuration, blueprints, skill
//   packs, fixtures, views, workers). `source` names the upstream file a starter was copied from;
//   only those are reconciled by an upgrade, and files without a source are never rewritten.
//
// Every copy records its `source`, and the recorded hash identifies which upstream revision of that
// source was written, so an upgrade can rebuild the merge base from the submodule's history instead
// of keeping a second copy of every file in the wrapper.

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

/** Templates without another upstream home: the wrapper README and `.gitignore`. */
const TEMPLATES = "scripts/consumer/wrapper-templates";

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
  copy("README.md", `${TEMPLATES}/README.md`);
  copy(".gitignore", `${TEMPLATES}/gitignore`);
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
