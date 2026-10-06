import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm views`: the Workshop frontend's views and subviews, as a registry a person or an agent can
 * walk to find, open and restyle any screen. The registry is data only (`views.json` beside the
 * frontend); `check` keeps it honest against the routes and components that actually exist.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRONTEND = "packages/workshop-frontend";
/** The registry file, repo-relative. */
export const REGISTRY_FILE = `${FRONTEND}/views.json`;

/** What sort of UI a view is. `global` is app-wide styling (tokens, theme) rather than a screen. */
export const VIEW_KINDS = [
  "route", "region", "tab", "step", "modal", "menu", "popover", "card", "toast", "banner", "state", "global",
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** One view or subview. Ids are dot paths whose first segment names the area; `parent` is the view it opens from. */
export interface View {
  id: string;
  title: string;
  kind: ViewKind;
  parent: string | null;
  /** The TanStack route path it renders on (`$param` syntax, `_` suffixes as declared), or `*`. */
  route: string;
  /** How to make it visible locally: URL, clicks, required state. */
  reach: string;
  component: string;
  /** Repo-relative, primary file first. */
  files: string[];
  components: string[];
  styling: string;
  /** A stable DOM hook to find it in the browser, if the code has one. */
  selector: string | null;
  flags: string[];
  notes: string;
}

export interface ViewRegistry {
  schemaVersion: 1;
  /** Frontend source files that render no view of their own (contexts, entry points), so `check` skips them. */
  nonViewFiles: string[];
  /** Components nothing renders, so there is nothing to style; `check` fails once one is used again. */
  unusedFiles: string[];
  views: View[];
}

export function readRegistry(root = ROOT): ViewRegistry {
  return JSON.parse(readFileSync(join(root, REGISTRY_FILE), "utf8")) as ViewRegistry;
}

/** The route paths the router declares, read from `createFileRoute(...)` in each route module. */
export function declaredRoutes(root = ROOT): Map<string, string> {
  const dir = join(root, FRONTEND, "src/routes");
  const routes = new Map<string, string>([["__root", `${FRONTEND}/src/routes/__root.tsx`]]);
  for (const name of readdirSync(dir)) {
    const match = /createFileRoute\(\s*['"]([^'"]+)['"]/.exec(readFileSync(join(dir, name), "utf8"));
    if (match) routes.set(match[1], `${FRONTEND}/src/routes/${name}`);
  }
  return routes;
}

function frontendComponentFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(path);
    }
  };
  walk(`${FRONTEND}/src`);
  return out.toSorted();
}

/** Extension-less repo paths of every module some non-test frontend file, other than `ignore`, imports by relative path. */
function importedModules(root: string, ignore: Set<string>): Set<string> {
  const imported = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || ignore.has(path)) continue;
      for (const [, specifier] of readFileSync(join(root, path), "utf8").matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        imported.add(relative(root, resolve(root, dir, specifier)).replace(/\.tsx?$/, ""));
      }
    }
  };
  walk(`${FRONTEND}/src`);
  return imported;
}

/** Every inconsistency between the registry and the checkout; empty when it is current. */
export function checkRegistry(registry: ViewRegistry, root = ROOT): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const routes = declaredRoutes(root);
  const referenced = new Set<string>([...registry.nonViewFiles, ...registry.unusedFiles]);
  for (const view of registry.views) {
    const at = `view "${view.id}"`;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(view.id)) problems.push(`${at}: id must be lowercase dot-separated`);
    if (ids.has(view.id)) problems.push(`${at}: duplicate id`);
    ids.add(view.id);
    if (!VIEW_KINDS.includes(view.kind)) problems.push(`${at}: unknown kind "${view.kind}"`);
    if (view.route !== "*" && !routes.has(view.route)) problems.push(`${at}: route "${view.route}" is not declared in src/routes`);
    if (view.files.length === 0) problems.push(`${at}: no files`);
    for (const file of view.files) {
      if (!existsSync(join(root, file))) problems.push(`${at}: file ${file} does not exist`);
      referenced.add(file);
    }
  }
  const parents = new Map(registry.views.map(view => [view.id, view.parent]));
  for (const view of registry.views) {
    if (view.parent !== null && !ids.has(view.parent)) problems.push(`view "${view.id}": parent "${view.parent}" is not a view`);
    for (let seen = new Set<string>(), at: string | null = view.id; at !== null; at = parents.get(at) ?? null) {
      if (seen.has(at)) { problems.push(`view "${view.id}": parent chain loops through "${at}"`); break; }
      seen.add(at);
    }
  }
  for (const [route, file] of routes) {
    if (!registry.views.some(view => view.route === route && view.kind === "route") && route !== "__root") {
      problems.push(`route "${route}" (${file}) has no view of kind "route"`);
    }
  }
  for (const file of frontendComponentFiles(root)) {
    if (!referenced.has(file)) problems.push(`${file} is in no view's files and not listed in nonViewFiles`);
  }
  for (const file of [...registry.nonViewFiles, ...registry.unusedFiles]) {
    if (!existsSync(join(root, file))) problems.push(`${file} is listed as a non-view or unused file but does not exist`);
  }
  // An import from another unused file is not a use.
  const imported = importedModules(root, new Set(registry.unusedFiles));
  for (const file of registry.unusedFiles) {
    if (imported.has(file.replace(/\.tsx?$/, ""))) problems.push(`${file} is listed as unused but is imported; give it a view`);
  }
  return problems;
}

/** The view and, with `deep`, all of its descendants by parent link, in registry order. */
export function subtree(registry: ViewRegistry, id: string, deep: boolean): View[] {
  const view = registry.views.find(candidate => candidate.id === id);
  if (!view) throw new Error(`No view "${id}"; run \`pnpm views list\``);
  if (!deep) return [view];
  const within = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const candidate of registry.views) {
      if (candidate.parent !== null && within.has(candidate.parent) && !within.has(candidate.id)) { within.add(candidate.id); grew = true; }
    }
  }
  return registry.views.filter(candidate => within.has(candidate.id));
}

/**
 * The local URL a view renders on. A trailing `_` on a segment only un-nests a route in TanStack's
 * file layout, so it is not part of the URL; `$params` must be supplied.
 */
export function viewUrl(view: View, base: string, params: Record<string, string>): string {
  const path = view.route === "*" || view.route === "__root" ? "/" : view.route
    .split("/")
    .map(segment => {
      const bare = segment.replace(/_$/, "");
      if (!bare.startsWith("$")) return bare;
      const value = params[bare.slice(1)];
      if (value === undefined) throw new Error(`View "${view.id}" needs --param ${bare.slice(1)}=<value> (route ${view.route})`);
      return encodeURIComponent(value);
    })
    .join("/");
  return new URL(path, base).toString();
}

function matches(view: View, query: string): boolean {
  const haystack = [view.id, view.title, view.component, view.route, ...view.files].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

function describe(view: View, registry: ViewRegistry): string {
  const children = registry.views.filter(candidate => candidate.parent === view.id).map(child => child.id);
  const lines = [
    `${view.id}  (${view.kind})`,
    `  ${view.title}`,
    `  route:      ${view.route}`,
    `  component:  ${view.component}`,
    `  reach:      ${view.reach}`,
    `  selector:   ${view.selector ?? "-"}`,
    `  flags:      ${view.flags.length ? view.flags.join(", ") : "-"}`,
    `  styling:    ${view.styling}`,
    `  built from: ${view.components.join("; ") || "-"}`,
    "  files:",
    ...view.files.map(file => `    ${file}`),
  ];
  if (view.notes) lines.push(`  notes:      ${view.notes}`);
  if (view.parent) lines.push(`  parent:     ${view.parent}`);
  if (children.length) lines.push("  children:", ...children.map(child => `    ${child}`));
  return lines.join("\n");
}

/** Indents each view under its nearest listed ancestor; views whose parent is filtered out become roots. */
function tree(views: View[], all: View[]): string {
  const listed = new Set(views.map(view => view.id));
  const parentOf = new Map(all.map(view => [view.id, view.parent]));
  const listedParent = (view: View) => {
    let at = view.parent;
    while (at !== null && !listed.has(at)) at = parentOf.get(at) ?? null;
    return at;
  };
  const children = new Map<string | null, View[]>();
  for (const view of views) children.set(listedParent(view), [...(children.get(listedParent(view)) ?? []), view]);
  const rows: [string, View][] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const view of children.get(parent) ?? []) { rows.push([`${"  ".repeat(depth)}${view.id}`, view]); visit(view.id, depth + 1); }
  };
  visit(null, 0);
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, view]) => `${label.padEnd(width + 2)}${view.kind.padEnd(7)} ${view.title}`).join("\n");
}

/** Where `demo` serves by default; clear of the dev client's 3000 and run-local's 8787. */
export const DEMO_PORT = 3100

export const USAGE = `Usage: pnpm views <command> [options]

  list [query]          Tree of views; query filters by id, title, component, route or file
                        --kind <kind>  --route <route>  --roots (top-level views only)
  show <id>             Everything about one view: how to reach it, styling, files, children
  files <id> [--deep]   Its source files, one per line (--deep adds descendants')
  demo [--port <n>]     Serve the frontend alone on fixtures (no backend, login or setup);
                        a "Demo screens" picker (Ctrl/Cmd+Shift+K) jumps to any view
  url <id>              Its URL   --demo (on the demo server, port ${DEMO_PORT} unless --port)
                        --base <url> (default $VIEWS_BASE_URL or http://localhost:8787)
                        --param <name>=<value> for route params, e.g. --param id=3
  open <id>             Open that URL in the browser (same options as url)
  check                 Verify the registry against src/routes and every component file

  --json                Machine-readable output (list, show, files)
Kinds: ${VIEW_KINDS.join(", ")}`;

interface Parsed { positional: string[]; options: Map<string, string[]>; flags: Set<string> }

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { positional: [], options: new Map(), flags: new Set() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) { parsed.positional.push(arg); continue; }
    const name = arg.slice(2);
    if (["json", "deep", "roots", "help", "demo"].includes(name)) { parsed.flags.add(name); continue; }
    const value = args[++index];
    if (value === undefined) throw new Error(`--${name} needs a value\n\n${USAGE}`);
    parsed.options.set(name, [...(parsed.options.get(name) ?? []), value]);
  }
  return parsed;
}

/** Runs one command and returns what to print. Throws with a message for the user on misuse. */
export function runViewsCommand(args: string[], root = ROOT, env = process.env): { output: string; open?: string; serveDemo?: number } {
  const { positional: [command = "list", ...rest], options, flags } = parseArgs(args);
  if (flags.has("help") || command === "help") return { output: USAGE };
  const registry = readRegistry(root);
  const json = flags.has("json");
  const one = (name: string) => options.get(name)?.at(-1);
  const port = Number(one("port") ?? DEMO_PORT)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`--port expects a port number`)
  const urlFor = (id: string) => {
    // Demo mode resolves the route itself, from the view's scenario and the fixture world.
    if (flags.has("demo")) return `http://localhost:${port}/?demo=${encodeURIComponent(subtree(registry, id, false)[0].id)}`
    const params = Object.fromEntries((options.get("param") ?? []).map(pair => {
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`--param expects name=value, got "${pair}"`);
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }));
    return viewUrl(subtree(registry, id, false)[0], one("base") ?? env.VIEWS_BASE_URL ?? "http://localhost:8787", params);
  };
  const needId = () => {
    if (rest.length !== 1) throw new Error(`${command} takes one view id\n\n${USAGE}`);
    return rest[0];
  };

  switch (command) {
    case "list": {
      const kind = one("kind");
      if (kind && !VIEW_KINDS.includes(kind as ViewKind)) throw new Error(`Unknown kind "${kind}". Kinds: ${VIEW_KINDS.join(", ")}`);
      const route = one("route");
      const views = registry.views.filter(view =>
        (!rest.length || matches(view, rest.join(" "))) && (!kind || view.kind === kind)
        && (!route || view.route === route) && (!flags.has("roots") || view.parent === null));
      if (json) return { output: JSON.stringify(views, null, 2) };
      return { output: views.length ? `${tree(views, registry.views)}\n\n${views.length} of ${registry.views.length} views` : "No matching views" };
    }
    case "show": {
      const [view] = subtree(registry, needId(), false);
      return { output: json ? JSON.stringify(view, null, 2) : describe(view, registry) };
    }
    case "files": {
      const files = [...new Set(subtree(registry, needId(), flags.has("deep")).flatMap(view => view.files))];
      return { output: json ? JSON.stringify(files, null, 2) : files.join("\n") };
    }
    case "url":
      return { output: urlFor(needId()) };
    case "open": {
      const url = urlFor(needId());
      return { output: url, open: url };
    }
    case "demo":
      if (rest.length) break;
      return { output: `Demo screens at http://localhost:${port}/ (open one: pnpm views open <id> --demo)`, serveDemo: port };
    case "check": {
      if (rest.length) break;
      const problems = checkRegistry(registry, root);
      if (problems.length) throw new Error(`${relative(process.cwd(), join(root, REGISTRY_FILE))} is out of date:\n  ${problems.join("\n  ")}`);
      return { output: `${registry.views.length} views, all routes and components accounted for` };
    }
  }
  throw new Error(USAGE);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output, open, serveDemo } = runViewsCommand(process.argv.slice(2));
    console.log(output);
    if (serveDemo) {
      const frontend = join(ROOT, FRONTEND);
      spawn(join(frontend, "node_modules/.bin/vite"), ["--port", String(serveDemo), "--strictPort"], {
        cwd: frontend, stdio: "inherit", env: { ...process.env, VITE_DEMO: "true" },
      }).on("exit", code => { process.exitCode = code ?? 1; });
    }
    if (open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(opener, [open], { stdio: "ignore", detached: true }).unref();
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
