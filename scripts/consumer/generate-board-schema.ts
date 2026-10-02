import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [source, revision, mode, ...extra] = process.argv.slice(2);
if (extra.length || !source || !/^[a-f0-9]{40}$/.test(revision ?? "") || (mode && mode !== "--check")) {
  throw new Error("Usage: generate-board-schema.ts INFEROPS_CHECKOUT FULL_REVISION [--check]");
}
const root = resolve(source);
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (git("rev-parse", "HEAD") !== revision || git("status", "--porcelain", "--untracked-files=no")) {
  throw new Error("Schema generation requires the reviewed revision and a clean tracked InferOps checkout");
}
// Bun resolves InferOps workspace packages without introducing them into the InferOS runtime.
const program = `
 const { BoardResponseSchema } = await import(process.argv[1] + '/domains/project/shared/board.dto.ts');
 const { z } = await import(process.argv[1] + '/domains/project/node_modules/zod/index.js');
 console.log(JSON.stringify(z.toJSONSchema(BoardResponseSchema)));
`;
const schema = JSON.parse(execFileSync("bun", ["--eval", program, root], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const output = JSON.stringify({
  source: { repository: "https://github.com/factory-level/inferops", revision, path: "domains/project/shared/board.dto.ts", export: "BoardResponseSchema" },
  schema,
}, null, 2) + "\n";
const destination = join(here, "project-board.schema.json");
if (mode === "--check") {
  if (readFileSync(destination, "utf8") !== output) throw new Error("Generated board schema differs; regenerate and review the contract diff");
} else writeFileSync(destination, output);
console.log(JSON.stringify({ ok: true, operation: mode ? "schema-check" : "schema-generate", revision }));
