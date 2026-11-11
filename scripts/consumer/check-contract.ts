// The consumer side of the cross-repo contract gate (FAC-142): holds this repository to what
// `contract.json` declares it consumes from InferOps. Needs nothing from InferOps and no secret,
// so it runs on every pull request, a fork's included. InferOps' CI holds the producer to the same
// declaration (it reads this repository's main): a board DTO that differs from the generated schema
// here, or another AG-UI version, fails there.
//
//   node scripts/consumer/check-contract.ts [root]
//
// Checks that the gatekeeper's InferOps pin is the revision the board schema was generated at, and
// that every package depending on the AG-UI package pins exactly the declared version, which is
// the only one the lockfile resolves.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** What `contract.json` declares. */
export type ConsumerContract = {
  agui: { package: string; version: string };
  boardSchema: string;
  pin: string;
};

const SHA = /^[0-9a-f]{40}$/;
/** Where package manifests live, below the repository root. */
const PACKAGE_DIRS = ["packages", "custom-gatekeepers"];

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Every problem with the repository at `root` against its declared contract; none when it holds. */
export function checkContract(root: string): string[] {
  let problems: string[] = [];
  let contract = readJson(join(root, "scripts/consumer/contract.json")) as ConsumerContract;
  let { agui } = contract;
  if (typeof agui?.package !== "string" || !/^\d+\.\d+\.\d+$/.test(agui?.version ?? "")) {
    return ["contract.json must name the AG-UI package and an exact version."];
  }

  let pin = (readJson(join(root, contract.pin)) as { compatibility?: { provider?: { revision?: unknown } } })
    .compatibility?.provider?.revision;
  let schema = (readJson(join(root, contract.boardSchema)) as { source?: { revision?: unknown } }).source?.revision;
  if (typeof pin !== "string" || !SHA.test(pin)) problems.push(`${contract.pin} pins no full InferOps commit.`);
  if (typeof schema !== "string" || !SHA.test(schema)) problems.push(`${contract.boardSchema} records no full InferOps commit.`);
  if (typeof pin === "string" && typeof schema === "string" && pin !== schema) {
    problems.push(`${contract.pin} pins InferOps ${pin}, but ${contract.boardSchema} was generated at ${schema}: ` +
      `regenerate the schema at the pin (node scripts/consumer/generate-board-schema.ts <checkout> ${pin}).`);
  }

  let dependents = 0;
  for (let dir of PACKAGE_DIRS) {
    if (!existsSync(join(root, dir))) continue;
    for (let entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      let manifest = join(root, dir, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      let pkg = readJson(manifest) as Record<string, Record<string, string> | undefined>;
      for (let field of ["dependencies", "devDependencies", "peerDependencies"]) {
        let version = pkg[field]?.[agui.package];
        if (version === undefined) continue;
        dependents++;
        if (version !== agui.version) {
          problems.push(`${dir}/${entry.name} pins ${agui.package} ${version}; the contract is ${agui.version}.`);
        }
      }
    }
  }
  if (dependents === 0) problems.push(`No package depends on ${agui.package}; update contract.json if that is intended.`);

  let lock = join(root, "pnpm-lock.yaml");
  if (existsSync(lock)) {
    let escaped = agui.package.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    let resolved = new Set([...readFileSync(lock, "utf8").matchAll(new RegExp(`^  '?${escaped}@(\\d+\\.\\d+\\.\\d+)`, "gm"))]
      .map(match => match[1]));
    for (let version of resolved) {
      if (version !== agui.version) problems.push(`pnpm-lock.yaml resolves ${agui.package} ${version}; the contract is ${agui.version}.`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let problems = checkContract(resolve(process.argv[2] ?? "."));
  for (let problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log("The consumer contract holds.");
}
