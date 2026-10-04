// Generates a minimal connection package from the reference shape: a gatekeeper Worker over a
// synthetic fake provider, a typed client stub, the agent-facing types, a conformance test wired to
// the shared suite, `connection.json` with `status: "scaffold"`, and a README with SOP stubs.
//
// Usage: pnpm gatekeepers:scaffold <slug> [--consumer-root <wrapper>]
//
// In this checkout it writes `custom-gatekeepers/gatekeeper-<slug>/` and generates its
// `wrangler.jsonc`. With `--consumer-root` it writes the wrapper's `gatekeepers/gatekeeper-<slug>/`
// instead, which stays unbound until the wrapper lists and enables it in `inferos.config.json`.
// It never overwrites: an existing directory is refused.

import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GATEKEEPER_API_LEVEL } from "./connection-package.ts";
import { syncWorkerConfigs } from "./generate-worker-configs.ts";
import { CONSUMER_GATEKEEPER_ROOT, WORKER_PACKAGE_ROOTS, workerPackageDirs } from "./worker-dirs.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "scripts/connection-template");

/**
 * A scaffold slug: lowercase letters and digits, starting with a letter. It is the vendor id, the
 * URL scheme, the `/gatekeeper/<slug>` route and the install slug, and the release manifest's slug
 * rule admits no separators, so neither does this.
 */
const SLUG = /^[a-z][a-z0-9]{1,31}$/;

/** Where and how {@link scaffoldGatekeeper} writes. */
export interface ScaffoldOptions {
  /** The InferOS checkout whose `custom-gatekeepers/` receives the package. Defaults to this one. */
  root?: string;
  /** A consumer wrapper: write its `gatekeepers/` instead of this checkout's `custom-gatekeepers/`. */
  consumerRoot?: string;
  /** Generate the fork package's `wrangler.jsonc` (the default). Ignored for a wrapper. */
  generateConfig?: boolean;
}

/** What {@link scaffoldGatekeeper} wrote. */
export interface ScaffoldResult {
  name: string;
  directory: string;
  status: "scaffold";
  next: string[];
}

const pascal = (slug: string) => slug[0]!.toUpperCase() + slug.slice(1);

function templateFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? templateFiles(path, join(prefix, name)) : [join(prefix, name)];
  });
}

/** Generate a connection package for `slug`; refuses to overwrite anything. */
export async function scaffoldGatekeeper(slug: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  if (!SLUG.test(slug)) throw new Error("The slug must be 2 to 32 lowercase letters and digits, starting with a letter");
  const root = resolve(options.root ?? ROOT);
  const name = `gatekeeper-${slug}`;
  const wrapper = options.consumerRoot === undefined ? null : resolve(options.consumerRoot);
  if (wrapper && !existsSync(join(wrapper, "inferos.config.json"))) {
    throw new Error("--consumer-root must be a wrapper directory holding inferos.config.json");
  }
  // Every name the pinned checkout and the wrapper already use, so the new one cannot collide.
  const taken = new Set(workerPackageDirs(root, wrapper ? { consumerRoot: wrapper } : {}).map(dir => basename(dir)));
  if (taken.has(name)) throw new Error(`A package named ${name} already exists`);
  const parent = wrapper ? join(wrapper, CONSUMER_GATEKEEPER_ROOT) : join(root, WORKER_PACKAGE_ROOTS[1]);
  const target = join(parent, name);
  if (existsSync(target)) throw new Error(`${relative(wrapper ?? root, target)} already exists; the scaffolder never overwrites`);

  const pin = wrapper ? relative(target, join(wrapper, "inferos")) : relative(target, root);
  const tokens: Record<string, string> = {
    __slug__: slug,
    __Name__: pascal(slug),
    __NAME__: slug.toUpperCase(),
    __title__: pascal(slug),
    __PACKAGE__: wrapper ? name : `@inferos/${name}`,
    __WORKER_CONFIG__: wrapper ? `${pin}/scripts/worker-config.ts` : "@gadgets/scripts/worker-config",
    __INFEROS__: pin,
    __SCHEMA__: `${pin}/scripts/connection-package.schema.json`,
    __API_LEVEL__: String(GATEKEEPER_API_LEVEL),
    __DEVELOP__: wrapper
      ? "This package lives in the wrapper's `gatekeepers/`. It is bound only when `inferos.config.json` " +
        `lists it (\`"gatekeepers": [{ "slug": "${slug}", "enabled": true }]\`) with ` +
        "`features.customCloudflareCode` on, and its `connection.json` validates and is compatible. " +
        "`pnpm gatekeepers:check` reports why it is not bound. Its imports must resolve from the wrapper, " +
        "and the wrapper has no workspace to install its dependencies or run its tests: develop and " +
        "test the connector in a fork checkout's `custom-gatekeepers/` and copy it here."
      : "```sh\npnpm install\npnpm types:generate                       # worker-configuration.d.ts\n" +
        `pnpm --filter @inferos/${name} test:run   # the shared conformance suite\n` +
        `pnpm canvas gatekeeper enable ${name}  # bind it in pnpm dev-server\n\`\`\`\n\n` +
        "An unreleased package (`scaffold` or `conformant`) is left out of releases and out of the " +
        "default custom-gatekeeper selection, so it runs locally only once enabled explicitly.",
  };
  const fill = (text: string) => Object.entries(tokens).reduce((out, [token, value]) => out.replaceAll(token, value), text);

  mkdirSync(parent, { recursive: true });
  // Staged beside the target and renamed into place, so a failure leaves nothing half-written.
  const staging = mkdtempSync(join(parent, `.${name}-`));
  try {
    for (const file of templateFiles(TEMPLATE)) {
      const out = join(staging, fill(file).replace(/\.tmpl$/, ""));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, fill(readFileSync(join(TEMPLATE, file), "utf8")));
    }
    // Wrangler imports the agent types as text through this name.
    symlinkSync("types.d.ts", join(staging, "src/types.txt"));
    if (existsSync(target)) throw new Error(`${name} appeared while scaffolding; nothing was written`);
    renameSync(staging, target);
    // mkdtemp creates the staging directory owner-only; the package is an ordinary directory.
    chmodSync(target, 0o755);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  if (!wrapper && options.generateConfig !== false) await syncWorkerConfigs([target], { check: false, base: root });

  const next = wrapper
    ? [
      `Add { "slug": "${slug}", "enabled": true } to "gatekeepers" in inferos.config.json`,
      "pnpm gatekeepers:generate",
      "pnpm gatekeepers:check",
    ]
    : [
      "pnpm install",
      "pnpm types:generate",
      `pnpm --filter @inferos/${name} test:run`,
      `pnpm canvas gatekeeper enable ${name}`,
    ];
  return { name, directory: target, status: "scaffold", next };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "Usage: pnpm gatekeepers:scaffold <slug> [--consumer-root <wrapper>]";
  try {
    let parsed;
    try {
      parsed = parseArgs({ allowPositionals: true, options: { "consumer-root": { type: "string" } } });
    } catch { throw new Error(usage); }
    const [slug, extra] = parsed.positionals;
    if (!slug || extra) throw new Error(usage);
    const result = await scaffoldGatekeeper(slug, { consumerRoot: parsed.values["consumer-root"] });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
