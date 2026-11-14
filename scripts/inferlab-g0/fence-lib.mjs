// Helpers for fence-audit.sh (FAC-215). Two commands:
//
//   node fence-lib.mjs filter        stdin: `path:line:text` hits; prints the ones not allowlisted
//   node fence-lib.mjs configs ROOT  scans every wrangler*.json / wrangler*.jsonc under ROOT, tracked
//                                    or not (the dev launcher writes untracked wrangler.dev.jsonc
//                                    files), and prints each runtime name it read, then the hits
//
// The fenced names are the archived fork's legacy frameworks: Consoles, Dots, widget and workspace
// kinds, Operate and canvas state.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parse } = require("jsonc-parser");

/**
 * Lines that name the fork only as provenance. Each is matched as the WHOLE line, trimmed, and only
 * inside packages/gatekeeper-inferlab/ (its sources or their build copies), so anything else on such
 * a line, or the same words anywhere else, is still a hit.
 */
const ALLOWED_LINES = new Set([
  "// Ported from the archived fork's custom-gatekeepers/gatekeeper-inferops (24f5d885); see README.md",
  "// Ported from the archived fork's `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts`",
]);
const ALLOWED_DIR = /(^|\/)packages\/gatekeeper-inferlab\//;

/** A runtime name is fenced when it names one of the fork's legacy frameworks. */
const FENCED_NAME =
  /(Operate|Canvas|Console|WidgetKind|WorkspaceKind|Dots?(?=[A-Z_-]|$)|^dot[-_]|[-_]dot([-_]|$)|operate|canvas|console-widget|widget-kind|workspace-kind|gatekeeper-inferops|custom-gatekeepers|inferops-dot|mock-inferops|SHARED_CONFIGURATION_GATEKEEPER|GATEKEEPER_INFEROPS\b)/;

function filter() {
  const input = readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const hit of input) {
    const m = /^(.*?):(\d+):(.*)$/.exec(hit);
    if (m && ALLOWED_DIR.test(m[1]) && ALLOWED_LINES.has(m[3].trim())) continue;
    console.log(hit);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) yield* walk(path);
    else if (/^wrangler.*\.jsonc?$/.test(entry)) yield path;
  }
}

/** Every runtime name a config declares: bindings, classes, migrations, services, vars. */
function runtimeNames(config) {
  const names = [];
  const add = (kind, value) => { if (typeof value === "string" && value) names.push([kind, value]); };
  add("worker name", config.name);
  add("main", config.main);
  for (const b of config.durable_objects?.bindings ?? []) { add("DO binding", b.name); add("DO class", b.class_name); add("DO script", b.script_name); }
  for (const m of config.migrations ?? []) {
    for (const key of ["new_classes", "new_sqlite_classes", "deleted_classes"]) for (const c of m[key] ?? []) add(`migration ${key}`, c);
    for (const r of m.renamed_classes ?? []) { add("migration renamed from", r.from); add("migration renamed to", r.to); }
  }
  for (const s of config.services ?? []) { add("service binding", s.binding); add("service", s.service); add("service entrypoint", s.entrypoint); }
  for (const key of Object.keys(config.vars ?? {})) add("var", key);
  for (const group of ["kv_namespaces", "r2_buckets", "d1_databases", "queues", "workflows", "analytics_engine_datasets", "worker_loaders"]) {
    const list = Array.isArray(config[group]) ? config[group] : [...(config[group]?.producers ?? []), ...(config[group]?.consumers ?? [])];
    for (const b of list) { add(`${group} binding`, b.binding ?? b.name); add(`${group} class`, b.class_name); }
  }
  return names;
}

function configs(root) {
  let files = 0, scanned = 0;
  const hits = [];
  for (const path of walk(root)) {
    const config = parse(readFileSync(path, "utf8"));
    if (!config || typeof config !== "object") continue;
    files++;
    const rel = relative(root, path);
    for (const [kind, value] of runtimeNames(config)) {
      scanned++;
      const fenced = FENCED_NAME.test(value);
      console.log(`${fenced ? "HIT " : "ok  "}${rel}  ${kind}: ${value}`);
      if (fenced) hits.push(`${rel}  ${kind}: ${value}`);
    }
  }
  console.log(`# ${files} config file(s), ${scanned} runtime name(s) read, ${hits.length} hit(s)`);
  process.exitCode = hits.length ? 1 : 0;
}

const [command, arg] = process.argv.slice(2);
if (command === "filter") filter();
else if (command === "configs") configs(arg ?? ".");
else { console.error("usage: fence-lib.mjs filter | configs <root>"); process.exit(2); }
