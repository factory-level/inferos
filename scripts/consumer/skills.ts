import { Buffer } from "node:buffer";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { contentTypeFromPath, isTextContentType, MAX_DOCUMENT_BODY_BYTES } from "../../packages/gatekeeper-context/src/context-types.ts";
import { parseConsumerSkillManifest } from "./skill-manifest.ts";

/** Wrapper file that maps runtime skill packs to directories; one pack becomes one public Context collection. */
export const SKILLS_MANIFEST = "inferos.skills.json";

/** The packs every new wrapper starts with; their starter sources live in `skill-packs/`. */
export const STARTER_SKILL_PACKS = ["operate", "build", "shared"] as const;

/** One runtime skill pack as written in inferos.skills.json. */
export interface SkillPackEntry {
  /** Context collection title; the uploader finds the collection again by this exact title. */
  title: string;
  /** Collection description, which agents read to decide relevance. */
  description: string;
  /** Wrapper-relative directory whose children are the pack's skills and shared files. */
  directory: string;
  /**
   * Wrapper-relative skill directories published under their own name, such as a skill installed
   * into `.agents/skills/` by the skills CLI. A missing one is reported, not fatal, so a wrapper
   * that has not run `pnpm skills:install` yet still checks.
   */
  include: string[];
}

/** Parsed inferos.skills.json. */
export interface ConsumerSkillsManifest {
  schemaVersion: 1;
  packs: Record<string, SkillPackEntry>;
  /** Globs (`*`, `**`) over collection paths that are never uploaded, such as skill-creator's eval output. */
  exclude: string[];
}

/** One file ready for `putContextDocument`. */
export interface SkillPackFile {
  /** Collection-relative document path. */
  path: string;
  contentType: string;
  /** Literal text for text types, canonical base64 otherwise, as the Context Library stores it. */
  body: string;
  /** The skill description for SKILL.md files; empty otherwise. */
  description: string;
}

/** A pack's files plus the skills among them, after validation. */
export interface CollectedSkillPack {
  id: string;
  title: string;
  description: string;
  files: SkillPackFile[];
  /** Skill name and the collection path of its SKILL.md. */
  skills: { name: string; path: string }[];
  /** Non-blocking problems, such as an `include` that is not installed yet. */
  warnings: string[];
}

/** The manifest a new wrapper starts with. */
export function defaultConsumerSkillsManifest(): ConsumerSkillsManifest {
  return {
    schemaVersion: 1,
    packs: {
      operate: { title: "InferOS · Operate", description: "Skills for operating InferOps projects, boards and approvals from the Workshop.", directory: "skills/operate", include: [] },
      build: { title: "InferOS · Build", description: "Skills for building gadgets, views, blueprints and new skills.", directory: "skills/build", include: [".agents/skills/skill-creator"] },
      shared: { title: "InferOS · Shared", description: "Conventions shared by every InferOS skill and agent.", directory: "skills/shared", include: [] },
    },
    exclude: ["**/evals/**", "**/*-workspace/**", "**/.DS_Store", "**/node_modules/**", "**/__pycache__/**"],
  };
}

const MAX_PATH_LENGTH = 1024;
const MAX_PACK_FILES = 500;
// The agent catalog advertises at most this many skills across every collection (agent-skill.ts).
const MAX_CATALOG_SKILLS = 150;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isWrapperPath = (path: string) => !isAbsolute(path) && !path.includes("\\") && path.split("/").every(part => part && part !== "." && part !== "..");

/** Read and validate inferos.skills.json without touching the skill sources. */
export function readConsumerSkillsManifest(root: string): ConsumerSkillsManifest {
  const raw: unknown = JSON.parse(readFileSync(join(root, SKILLS_MANIFEST), "utf8"));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.packs) || !Array.isArray(raw.exclude) || !raw.exclude.every(item => typeof item === "string")) {
    throw new Error(`${SKILLS_MANIFEST} requires schemaVersion 1, a packs object and an exclude list`);
  }
  const titles = new Set<string>();
  const packs: Record<string, SkillPackEntry> = {};
  for (const [id, entry] of Object.entries(raw.packs)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 40) throw new Error(`Skill pack id "${id}" must be a lowercase slug`);
    if (!isRecord(entry) || typeof entry.title !== "string" || !entry.title.trim() || typeof entry.directory !== "string" || !isWrapperPath(entry.directory)) {
      throw new Error(`Skill pack "${id}" requires a title and a normalized wrapper-relative directory`);
    }
    const include = entry.include ?? [];
    if (!Array.isArray(include) || !include.every(item => typeof item === "string" && isWrapperPath(item))) {
      throw new Error(`Skill pack "${id}" include must list normalized wrapper-relative directories`);
    }
    if (entry.description !== undefined && typeof entry.description !== "string") throw new Error(`Skill pack "${id}" description must be a string`);
    if (titles.has(entry.title)) throw new Error(`Skill pack titles must be unique; "${entry.title}" repeats`);
    titles.add(entry.title);
    packs[id] = { title: entry.title, description: entry.description ?? "", directory: entry.directory, include };
  }
  return { schemaVersion: 1, packs, exclude: raw.exclude };
}

function globPattern(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (glob.startsWith("**/", index)) { source += "(?:.*/)?"; index += 2; }
    else if (glob.startsWith("**", index)) { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// Real directory under the wrapper, refusing links so a pack cannot publish files from outside it.
function containedDirectory(root: string, path: string): string | undefined {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return undefined;
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) throw new Error(`${path} must be a directory, not a link or file`);
  const real = realpathSync(absolute);
  if (!real.startsWith(realpathSync(root) + sep)) throw new Error(`${path} must stay inside the wrapper`);
  return real;
}

function* walk(directory: string, prefix: string): Generator<{ source: string; path: string }> {
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const source = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`${path} is a symbolic link; skill packs publish regular files only`);
    if (entry.isDirectory()) yield* walk(source, path);
    else if (entry.isFile()) yield { source, path };
  }
}

/** Collect and validate one pack exactly as the uploader will publish it. */
export function collectSkillPack(root: string, manifest: ConsumerSkillsManifest, id: string): CollectedSkillPack {
  const entry = manifest.packs[id];
  if (!entry) throw new Error(`Unknown skill pack "${id}"; choose one of ${Object.keys(manifest.packs).join(", ")}`);
  const excluded = manifest.exclude.map(globPattern);
  const warnings: string[] = [];
  const sources: { source: string; path: string }[] = [];
  const directory = containedDirectory(root, entry.directory);
  if (directory) sources.push(...walk(directory, ""));
  else warnings.push(`${entry.directory} does not exist; the pack has no local skills`);
  for (const include of entry.include) {
    const included = containedDirectory(root, include);
    if (!included) { warnings.push(`${include} is not installed; run pnpm skills:install`); continue; }
    if (!existsSync(join(included, "SKILL.md"))) throw new Error(`${include} must contain a SKILL.md`);
    sources.push(...walk(included, basename(included)));
  }
  const files: SkillPackFile[] = [];
  const skills: CollectedSkillPack["skills"] = [];
  const paths = new Set<string>();
  for (const { source, path } of sources) {
    if (excluded.some(pattern => pattern.test(path))) continue;
    // oxlint-disable-next-line no-control-regex -- the Context Library rejects control characters in paths
    if (path.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(path)) throw new Error(`${path} is not a valid Context Library path`);
    if (paths.has(path)) throw new Error(`${path} appears twice in pack "${id}"; an include collides with a local skill`);
    paths.add(path);
    const bytes = readFileSync(source);
    if (bytes.byteLength > MAX_DOCUMENT_BODY_BYTES) throw new Error(`${path} exceeds the Context Library's ${MAX_DOCUMENT_BODY_BYTES}-byte document limit`);
    const contentType = contentTypeFromPath(path);
    const body = isTextContentType(contentType) ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64");
    let description = "";
    if (basename(path) === "SKILL.md") {
      try {
        const skill = parseConsumerSkillManifest(body);
        description = skill.description;
        skills.push({ name: skill.name, path });
      } catch (error) { throw new Error(`${path}: ${(error as Error).message}`, { cause: error }); }
    }
    files.push({ path, contentType, body, description });
  }
  if (files.length > MAX_PACK_FILES) throw new Error(`Pack "${id}" has ${files.length} files; split it to at most ${MAX_PACK_FILES}`);
  return { id, title: entry.title, description: entry.description, files, skills, warnings };
}

/** Validate every pack and the cross-pack rules the Workshop slash-command picker depends on. */
export function checkConsumerSkills(root: string) {
  const manifest = readConsumerSkillsManifest(root);
  const packs = Object.keys(manifest.packs).map(id => collectSkillPack(root, manifest, id));
  const owners = new Map<string, string>();
  for (const pack of packs) {
    for (const skill of pack.skills) {
      const owner = owners.get(skill.name);
      if (owner) throw new Error(`Skill "${skill.name}" is defined in both ${owner} and ${pack.id}; slash commands need unique names`);
      owners.set(skill.name, pack.id);
    }
  }
  if (owners.size > MAX_CATALOG_SKILLS) throw new Error(`${owners.size} skills exceed the agent catalog's ${MAX_CATALOG_SKILLS}-skill limit`);
  return { packs, warnings: packs.flatMap(pack => pack.warnings.map(warning => `${pack.id}: ${warning}`)) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(process.argv[2] ?? ".");
    const { packs, warnings } = checkConsumerSkills(root);
    console.log(JSON.stringify({ ok: true, operation: "skills", packs: packs.map(pack => ({
      id: pack.id, title: pack.title, files: pack.files.length, skills: pack.skills.map(skill => skill.name),
    })), warnings }, null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? `Invalid JSON in ${SKILLS_MANIFEST}` : (error as Error).message);
    process.exitCode = 1;
  }
}
