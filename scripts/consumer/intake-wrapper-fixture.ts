// Test fixture: a consumer wrapper `intake apply` can run against, bootstrapped by the real
// `bootstrapConsumer` from a small synthetic pin that holds what intake needs. Shared by the intake
// unit suite (`intake.test.ts`) and the integration test that reads an intake-derived board through
// the InferOps gatekeeper (`packages/integration-tests/__tests__/intake-customer-board.test.ts`).
// Nothing here runs at import.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapConsumer } from "./bootstrap.ts";
import { capabilitySources } from "./runtime.ts";

/** The reviewed synthetic Acme sample intake. */
export const SAMPLE_INTAKE = join(import.meta.dirname, "fixtures/intake/acme-field-ops.json");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

/** A pin with what intake needs: v2 parsing, the canvas CLI, the InferOps gatekeeper, view sources and the intake script itself. */
export function intakeSource(root: string) {
  const source = join(root, "source");
  const repo = join(import.meta.dirname, "../..");
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  execFileSync("git", ["init", "--quiet", source]);
  write("package.json", JSON.stringify({ type: "module", packageManager: "pnpm@11.17.0" }));
  write("packages/bundled-blueprints/blueprints/example/files/client.js", "// upstream blueprint\n");
  for (const path of ["scripts/consumer/config.ts", "scripts/consumer/runtime.ts", "scripts/consumer/canvas.ts", "scripts/consumer/intake.ts", "scripts/consumer/intake-inferops.ts",
    "scripts/worker-dirs.ts", "scripts/connection-status.ts", "packages/workshop-shared/src/canvas.ts"]) write(path, readFileSync(join(repo, path)));
  write("custom-gatekeepers/gatekeeper-inferops/wrangler.jsonc", "{}\n");
  write("packages/workshop-backend/src/canvas-store.ts", "export {};\n");
  for (const path of [capabilitySources.INFEROPS_ENABLED!, capabilitySources.INFEROPS_AUTH!]) write(path, "export {};\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return { source, revision: git(source, "rev-parse", "HEAD") };
}

/** A fresh wrapper (version 1 unless `options` switch capabilities on) with the sample at `intake/acme.json`. */
export function wrapper(root: string, options: Parameters<typeof bootstrapConsumer>[3] = {}) {
  const { source, revision } = intakeSource(root);
  const target = join(root, "acme");
  bootstrapConsumer(target, source, revision, options);
  mkdirSync(join(target, "intake"));
  const intakePath = join(target, "intake/acme.json");
  writeFileSync(intakePath, readFileSync(SAMPLE_INTAKE));
  return { target, intakePath, upstream: join(target, "inferos") };
}
