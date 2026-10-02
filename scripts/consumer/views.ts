import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCanvasDefinition, type CanvasDefinition } from "../../packages/workshop-shared/src/canvas.ts";

/** Validate wrapper-owned starter definitions without loading domain data or granting capabilities. */
export function readConsumerViews(root: string): CanvasDefinition[] {
  const directory = join(root, "views");
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Consumer views must be a directory, not a symbolic link");
  const files = readdirSync(directory).filter(name => name !== "README.md" && !name.startsWith("."));
  if (files.length > 64) throw new Error("At most 64 starter views are supported");
  const ids = new Set<string>();
  return files.toSorted().map(name => {
    const path = join(directory, name);
    const fileStat = lstatSync(path);
    if (!name.endsWith(".json") || fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > 128 * 1024) {
      throw new Error("Each starter view must be a regular JSON file of at most 128 KiB");
    }
    const view = parseCanvasDefinition(JSON.parse(readFileSync(path, "utf8")));
    if (ids.has(view.id)) throw new Error("Starter views must have unique view IDs");
    ids.add(view.id);
    return view;
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || process.argv[3]) throw new Error("Usage: views.ts CONSUMER_ROOT");
  const views = readConsumerViews(resolve(process.argv[2]));
  console.log(JSON.stringify({ ok: true, operation: "views", ids: views.map(view => view.id), runtimeReady: false }));
}
