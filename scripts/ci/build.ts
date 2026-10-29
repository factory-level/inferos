#!/usr/bin/env node
// Factory node 3, `build`: every deployable Worker bundled exactly as `wrangler deploy` would upload
// it (`wrangler deploy --dry-run --outdir`, the repo's pinned wrangler, no account), plus the
// release manifest — i.e. `scripts/release/build-release.ts`, reused rather than re-implemented.
//
//   node scripts/ci/build.ts [--run-id ID]
//
// Gate: the build exits 0 and wrote a manifest; its sha256 is the bundle digest recorded as
// evidence. Cloudflare account variables are removed from the child's environment, so the dry run
// provably has no account to deploy to.
// ponytail: no container image digests yet (InferOS ships Workers, not images); the plan's
// `registry:2` push belongs to the InferOps side of node 3.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exec, finish, nodeContext, runAsMain } from "./lib.ts";

/** The build child's environment: no Cloudflare account or token can reach wrangler. */
export function accountFreeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:CLOUDFLARE_|CF_API_|CF_ACCOUNT)/.test(name)));
}

export async function main(argv: string[]): Promise<number> {
  const ctx = nodeContext("build", argv);
  const out = join(ctx.dir, "release");
  const record = await exec(ctx, [process.execPath, "scripts/release/build-release.ts", "--out", out, "--release-id", ctx.runId], { log: "build-release.log", env: accountFreeEnv(ctx.env) });
  const manifestPath = join(out, "manifest.json");
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  const parsed = manifest ? JSON.parse(manifest.toString("utf8")) as { workers?: Record<string, unknown> } : null;
  return finish(ctx, {
    node: "build", ok: record.exitCode === 0 && manifest !== null,
    gate: "wrangler dry-run bundles of every deployable Worker and the release manifest build with no Cloudflare account",
    commands: [record],
    details: { manifest: manifestPath, manifestSha256: manifest ? createHash("sha256").update(manifest).digest("hex") : null, workers: parsed?.workers ? Object.keys(parsed.workers).length : null },
  });
}

await runAsMain(import.meta.url, main);
