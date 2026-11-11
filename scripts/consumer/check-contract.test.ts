// FAC-142: the consumer side of the cross-repo contract gate fails on each disagreement it can see
// without InferOps: a pin that isn't the schema's revision, and an AG-UI version other than the
// declared one, in a manifest or the lockfile. Over throwaway copies of the files it reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkContract } from "./check-contract.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

function repo(options: { pin?: string; schema?: string; versions?: string[]; lock?: string[] } = {}): string {
  let root = mkdtempSync(join(tmpdir(), "contract-"));
  let write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("scripts/consumer/contract.json", { agui: { package: "@ag-ui/core", version: "1.0.2" },
    boardSchema: "scripts/consumer/project-board.schema.json", pin: "custom-gatekeepers/gatekeeper-inferops/connection.json" });
  write("custom-gatekeepers/gatekeeper-inferops/connection.json", { compatibility: { provider: { revision: options.pin ?? A } } });
  write("scripts/consumer/project-board.schema.json", { source: { revision: options.schema ?? A } });
  (options.versions ?? ["1.0.2", "1.0.2"]).forEach((version, index) =>
    write(`packages/p${index}/package.json`, { dependencies: { "@ag-ui/core": version } }));
  write("pnpm-lock.yaml", (options.lock ?? ["1.0.2"]).map(v => `  '@ag-ui/core@${v}':\n    resolution: {}\n`).join(""));
  return root;
}

test("holds when the pin is the schema's revision and every package pins the declared AG-UI version", t => {
  let root = repo();
  t.after(() => rmSync(root, { recursive: true }));
  assert.deepEqual(checkContract(root), []);
});

test("fails on a pin the schema wasn't generated at, or one that isn't a full commit", t => {
  let moved = repo({ pin: B });
  let short = repo({ pin: "abc123" });
  t.after(() => { rmSync(moved, { recursive: true }); rmSync(short, { recursive: true }); });
  assert.match(checkContract(moved).join("\n"), /pins InferOps b{40}, but .* was generated at a{40}: regenerate/);
  assert.match(checkContract(short).join("\n"), /pins no full InferOps commit/);
});

test("fails on another AG-UI version in a package or in the lockfile", t => {
  let manifest = repo({ versions: ["1.0.2", "^1.0.2"] });
  let lock = repo({ lock: ["1.0.2", "1.1.0"] });
  t.after(() => { rmSync(manifest, { recursive: true }); rmSync(lock, { recursive: true }); });
  assert.match(checkContract(manifest).join("\n"), /packages\/p1 pins @ag-ui\/core \^1\.0\.2; the contract is 1\.0\.2/);
  assert.match(checkContract(lock).join("\n"), /pnpm-lock\.yaml resolves @ag-ui\/core 1\.1\.0/);
});
