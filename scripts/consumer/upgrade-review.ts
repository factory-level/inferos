// What a reviewer of an InferOS upgrade needs to see (#75), computed from the submodule's history
// between the current pin and the target, plus the portability scan a reviewed upgrade branch must
// pass before it is committed.
//
// The sections follow the design's list: code, configuration, capabilities, connections and OAuth,
// data (Durable Object migrations) and approvals (action kinds). Each is a text-level reading of
// known InferOS files, not a semantic analysis; where a section cannot see something it says so
// rather than reporting "no change".

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = (repository: string, args: string[]): string | null => {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
};
const lines = (text: string | null) => (text ?? "").split("\n").filter(Boolean);

/** Added and removed entries between two revisions. */
export interface SetChange { added: string[]; removed: string[] }

const change = (before: Iterable<string>, after: Iterable<string>): SetChange => {
  const a = new Set(before);
  const b = new Set(after);
  return { added: [...b].filter(item => !a.has(item)).toSorted(), removed: [...a].filter(item => !b.has(item)).toSorted() };
};
const changed = (value: SetChange) => value.added.length > 0 || value.removed.length > 0;

/**
 * The bracketed initializer of `export const <name>` in a TypeScript source, or null. Brackets are
 * counted naively, which is enough for the literal tables this reads.
 */
export function exportBlock(text: string | null, name: string): string | null {
  if (text === null) return null;
  const declaration = new RegExp(`export const ${name}\\b[^=]*=\\s*`).exec(text);
  if (!declaration) return null;
  let index = declaration.index + declaration[0].length;
  while (index < text.length && text[index] !== "[" && text[index] !== "{") index++;
  let depth = 0;
  for (let end = index; end < text.length; end++) {
    if (text[end] === "[" || text[end] === "{") depth++;
    else if (text[end] === "]" || text[end] === "}") {
      depth--;
      if (depth === 0) return text.slice(index, end + 1);
    }
  }
  return null;
}

/** The entries of a literal table, one per line, without comments, brackets or trailing commas. */
const entries = (block: string | null) => lines(block).map(line => line.trim().replace(/,$/, ""))
  .filter(line => line && !/^(\/\/|\/\*|\*)/.test(line) && !/^[[\]{}]+;?$/.test(line));

/** The review of one upgrade; see the module comment. */
export interface UpgradeReview {
  from: string;
  to: string;
  code: { available: boolean; commits: string[]; total: number; shortstat: string; compare?: string };
  configuration: { schemaSources: string[] };
  capabilities: { available: boolean; names: SetChange; requirements: SetChange; sources: SetChange };
  connections: { files: string[]; diff: string; truncated: boolean };
  migrations: { config: string; added: string[]; removed: string[] }[];
  actions: { kinds: { gatekeeper: string; added: string[]; removed: string[] }[]; changedGatekeepers: string[]; limits: string };
}

const MAX_COMMITS = 50;
const MAX_DIFF_LINES = 200;

const gatekeeperOf = (path: string) => /(?:^|\/)(gatekeeper-[^/]+)\//.exec(path)?.[1] ?? null;

/** Literal action kind tags (`tag: "..."`) in gatekeeper sources, and the record kinds in `*actions.ts`, by gatekeeper. */
function actionKinds(repository: string, revision: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const sources = [":(glob)packages/gatekeeper-*/src/**/*.ts", ":(glob)custom-gatekeepers/gatekeeper-*/src/**/*.ts", ":(exclude,glob)**/*.test.ts", ":(exclude,glob)**/__tests__/**"];
  const searches: [string, string[]][] = [
    ["tag:[[:space:]]*[\"'`][A-Za-z0-9._-]+[\"'`]", sources],
    ["kind:[[:space:]]*\"[a-z][a-z-]*\";", [":(glob)packages/gatekeeper-*/src/**/*actions.ts", ":(glob)custom-gatekeepers/gatekeeper-*/src/**/*actions.ts"]],
  ];
  for (const [pattern, pathspecs] of searches) {
    for (const line of lines(run(repository, ["grep", "-o", "--full-name", "-E", "-I", "-e", pattern, revision, "--", ...pathspecs]))) {
      // <revision>:<path>:<match>
      const rest = line.slice(revision.length + 1);
      const split = rest.indexOf(":");
      const gatekeeper = gatekeeperOf(rest.slice(0, split));
      const kind = /["'`]([^"'`]+)["'`]/.exec(rest.slice(split + 1))?.[1];
      if (!gatekeeper || !kind) continue;
      if (!found.has(gatekeeper)) found.set(gatekeeper, new Set());
      found.get(gatekeeper)!.add(kind);
    }
  }
  return found;
}

/** Review the change from `from` to `to` in `repository` (the wrapper's submodule). */
export function reviewUpgrade(repository: string, from: string, to: string, upstreamUrl?: string): UpgradeReview {
  const same = from === to;
  const show = (revision: string, path: string) => run(repository, ["show", `${revision}:${path}`]);
  const diffNames = (...pathspecs: string[]) => same ? [] : lines(run(repository, ["diff", "--name-only", from, to, "--", ...pathspecs]));

  const log = same ? "" : run(repository, ["log", "--oneline", "--no-decorate", `-n${MAX_COMMITS}`, `${from}..${to}`]);
  const total = same ? 0 : Number(run(repository, ["rev-list", "--count", `${from}..${to}`])?.trim() ?? 0);
  const compare = upstreamUrl && /^https:\/\/github\.com\/[^/]+\/[^/]+?(\.git)?$/.test(upstreamUrl) && !same
    ? `${upstreamUrl.replace(/\.git$/, "")}/compare/${from}...${to}` : undefined;
  const code = { available: log !== null, commits: lines(log), total, shortstat: same ? "" : (run(repository, ["diff", "--shortstat", from, to])?.trim() ?? ""), ...(compare ? { compare } : {}) };

  const config = (revision: string) => show(revision, "scripts/consumer/config.ts");
  const runtime = (revision: string) => show(revision, "scripts/consumer/runtime.ts");
  const names = (revision: string) => [...(exportBlock(config(revision), "CAPABILITY_NAMES") ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map(match => match[1]!);
  const capabilities = {
    available: config(to) !== null,
    names: change(names(from), names(to)),
    requirements: change(entries(exportBlock(config(from), "CAPABILITY_REQUIREMENTS")), entries(exportBlock(config(to), "CAPABILITY_REQUIREMENTS"))),
    sources: change(entries(exportBlock(runtime(from), "capabilitySources")), entries(exportBlock(runtime(to), "capabilitySources"))),
  };

  const connectionSpecs = [":(glob)**/connection.json", ":(glob)**/deploy-inputs.json"];
  const connectionFiles = same ? [] : lines(run(repository, ["diff", "--name-status", from, to, "--", ...connectionSpecs])).map(line => line.replace(/\t/g, " "));
  const connectionDiff = same ? [] : lines(run(repository, ["diff", from, to, "--", ...connectionSpecs]));

  const migrations = diffNames(":(glob)**/cloudflare.config.ts").flatMap(path => {
    const tags = (revision: string) => entries(exportBlock(show(revision, path), "migrations")).filter(entry => /\btag:/.test(entry));
    const delta = change(tags(from), tags(to));
    return changed(delta) ? [{ config: path, ...delta }] : [];
  });

  const kindsFrom = same ? new Map() : actionKinds(repository, from);
  const kindsTo = same ? new Map() : actionKinds(repository, to);
  const kinds = [...new Set([...kindsFrom.keys(), ...kindsTo.keys()])].toSorted().flatMap(gatekeeper => {
    const delta = change(kindsFrom.get(gatekeeper) ?? [], kindsTo.get(gatekeeper) ?? []);
    return changed(delta) ? [{ gatekeeper, ...delta }] : [];
  });
  const changedGatekeepers = [...new Set(diffNames("packages", "custom-gatekeepers").filter(path => !/\.test\.tsx?$|__tests__\//.test(path)).map(gatekeeperOf).filter(Boolean) as string[])].toSorted();

  return {
    from, to, code,
    configuration: { schemaSources: diffNames("scripts/consumer/config.ts", ":(glob)scripts/consumer/*.schema.json") },
    capabilities,
    connections: { files: connectionFiles, diff: connectionDiff.slice(0, MAX_DIFF_LINES).join("\n"), truncated: connectionDiff.length > MAX_DIFF_LINES },
    migrations,
    actions: {
      kinds, changedGatekeepers,
      limits: "Reads literal `tag:` action kinds in gatekeeper sources and record kinds in `*actions.ts`; computed tags and new read or write methods are not analysed, so review every changed gatekeeper.",
    },
  };
}

/** One reconciled file, as the summary shows it. */
export interface ReconcileLine { path: string; class: string; action: string; reason?: string }

const list = (items: string[], empty: string) => items.length ? items.map(item => `- \`${item}\``).join("\n") : empty;
const setChange = (label: string, value: SetChange) => changed(value)
  ? [`${label}:`, ...value.added.map(item => `  - added \`${item}\``), ...value.removed.map(item => `  - removed \`${item}\``)].join("\n")
  : `${label}: no change.`;

const short = (sha: string) => sha.slice(0, 12);

/** The review as Markdown: the reviewed upgrade's commit body and PR description. */
export function renderReview(review: UpgradeReview, input: {
  relation: string; config: { schemaVersion: number | null; unsupported: string[]; migrate: unknown }; check: { ok: boolean; error?: string };
  files: ReconcileLine[]; needsReview: string[]; scan: string[]; rollback: string;
}): string {
  const out: string[] = [];
  out.push(`Moves the pinned InferOS submodule from \`${review.from}\` to \`${review.to}\` (${input.relation}). Nothing here was granted, deployed or migrated: review each section, then run \`pnpm run setup\` and \`pnpm inferos verify\` on this branch.`);

  out.push("## Code");
  if (!review.code.available) out.push("The submodule history between the two revisions is not available here; review the range upstream.");
  else {
    out.push(`${review.code.total} commit${review.code.total === 1 ? "" : "s"}${review.code.shortstat ? `; ${review.code.shortstat}` : ""}.${review.code.compare ? ` Compare: ${review.code.compare}` : ""}`);
    if (review.code.commits.length) out.push("```\n" + review.code.commits.join("\n") + (review.code.total > review.code.commits.length ? `\n... ${review.code.total - review.code.commits.length} more` : "") + "\n```");
  }

  out.push("## Configuration");
  const migrate = input.config.migrate as { applicable?: boolean; available?: boolean; command?: string } | null;
  out.push([
    `- \`upstream.revision\` in \`inferos.config.json\` moves to \`${short(review.to)}\`; no other configuration field is changed.`,
    `- Schema version ${input.config.schemaVersion ?? "unknown"}${migrate?.applicable ? `; \`${migrate.command}\` ${migrate.available ? "would succeed" : "is blocked"} on the target (not run)` : ""}.`,
    `- Enabled capabilities the target does not ship: ${input.config.unsupported.length ? input.config.unsupported.join(", ") : "none"}.`,
    `- The wrapper ${input.check.ok ? "checks" : `does not check (${input.check.error})`} on the target.`,
    `- Configuration schema sources changed upstream: ${review.configuration.schemaSources.length ? review.configuration.schemaSources.map(path => `\`${path}\``).join(", ") : "none"}.`,
  ].join("\n"));

  out.push("## Capabilities");
  out.push(review.capabilities.available ? [
    setChange("- `CAPABILITY_NAMES`", review.capabilities.names),
    setChange("- `CAPABILITY_REQUIREMENTS`", review.capabilities.requirements),
    setChange("- `capabilitySources` (what the installation can honour)", review.capabilities.sources),
    "- Capabilities are deployer choices: the upgrade switches none on.",
  ].join("\n") : "The target has no capability table; not analysed.");

  out.push("## Connections and OAuth");
  out.push(review.connections.files.length
    ? list(review.connections.files, "") + "\n\n```diff\n" + review.connections.diff + (review.connections.truncated ? "\n... truncated" : "") + "\n```"
    : "No `connection.json` or gatekeeper `deploy-inputs.json` changed. OAuth scopes requested in gatekeeper code are not analysed.");

  out.push("## Data and Durable Object migrations");
  out.push(review.migrations.length
    ? review.migrations.map(item => [`- \`${item.config}\``, ...item.added.map(entry => `  - new: \`${entry}\``), ...item.removed.map(entry => `  - removed: \`${entry}\` (a removed migration needs special care)`)].join("\n")).join("\n")
      + `\n\n${input.rollback}`
    : `No Durable Object migration changed. ${input.rollback}`);

  out.push("## Approvals and action kinds");
  out.push([
    review.actions.kinds.length
      ? review.actions.kinds.map(item => [`- \`${item.gatekeeper}\``, ...item.added.map(kind => `  - **new action kind \`${kind}\`: review**`), ...item.removed.map(kind => `  - removed action kind \`${kind}\``)].join("\n")).join("\n")
      : "- No action kind added or removed.",
    `- Gatekeepers whose source changed: ${review.actions.changedGatekeepers.length ? review.actions.changedGatekeepers.map(name => `\`${name}\``).join(", ") : "none"}.`,
    `- ${review.actions.limits}`,
    "- Authority: the wrapper stores no grants, bindings, approvals or auto-approval rules, so this branch changes none. Auto-approval rules are kept per gatekeeper and action kind in the running deployment, so a new kind starts with none and every action of it waits for a manual decision until someone enables one.",
  ].join("\n"));

  out.push("## Reconciliation");
  const shown = input.files.filter(file => file.action !== "unchanged");
  out.push(shown.length
    ? "| File | Class | Action | Note |\n| --- | --- | --- | --- |\n" + shown.map(file => `| \`${file.path}\` | ${file.class} | ${file.action} | ${(file.reason ?? "").replace(/\|/g, "\\|")} |`).join("\n")
    : "No wrapper file changes.");
  if (input.needsReview.length) {
    out.push("Unresolved files keep the wrapper's text. The target's text, or a diff3 merge with conflict markers, was written outside the branch for whoever ran the upgrade:\n" + list(input.needsReview, ""));
  }

  out.push("## Portability");
  out.push(input.scan.length
    ? "The scan found credential material; this branch was not committed:\n" + input.scan.map(item => `- ${item}`).join("\n")
    : "Staged files exclude `.wrangler/`, `.dev.vars*`, `.env*`, `.inferos/state/` and `node_modules/`, and the staged diff contains no value from the wrapper's `.dev.vars*`/`.env*` files and no known token pattern. No runtime token, customer data, grant, pending approval or agent memory is part of this branch.");
  return out.join("\n\n") + "\n";
}

/** Paths a portable upgrade never stages. */
export const PORTABLE_EXCLUDED: RegExp[] = [/^\.dev\.vars/, /^\.env/, /(^|\/)\.wrangler\//, /^\.inferos\/state\//, /(^|\/)node_modules\//];

/** Token shapes that are never portable, by name. */
export const TOKEN_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["API secret key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer token", /\bBearer [A-Za-z0-9._~+/-]{20,}/],
];

/** Values of the wrapper's local secret files (`.dev.vars*`, `.env*` at its root) long enough to identify. */
export function localSecretValues(root: string): string[] {
  const values: string[] = [];
  for (const name of readdirSync(root)) {
    if (!/^(\.dev\.vars|\.env)/.test(name)) continue;
    let text: string;
    try { text = readFileSync(join(root, name), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
      const value = match?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
      if (value && value.length >= 12) values.push(value);
    }
  }
  return values;
}

/**
 * Findings that make output non-portable: excluded staged paths, local secret values, or known token
 * shapes in `text`. Findings name the path or pattern, never the matched value.
 */
export function scanPortable(paths: string[], text: string, secrets: string[]): string[] {
  const findings: string[] = [];
  for (const path of paths) if (PORTABLE_EXCLUDED.some(pattern => pattern.test(path))) findings.push(`excluded path staged: ${path}`);
  if (secrets.some(secret => text.includes(secret))) findings.push("a value from the wrapper's .dev.vars or .env files");
  for (const [name, pattern] of TOKEN_PATTERNS) if (pattern.test(text)) findings.push(`a ${name}`);
  return findings;
}
