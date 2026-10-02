import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseConsumerConfig } from "./config.ts";

const contract = JSON.parse(readFileSync(new URL("./project-board.schema.json", import.meta.url), "utf8"));
const boardSchema = z.fromJSONSchema(contract.schema);
// This selects only relationship keys after full canonical validation, not another wire DTO.
const relationships = z.object({
  projectId: z.string().nullable(),
  projects: z.array(z.object({ id: z.string(), identifier: z.string() })).max(256),
  columns: z.array(z.object({
    state: z.object({ id: z.string(), workflow: z.string() }),
    issues: z.array(z.object({ id: z.string(), stateId: z.string(), workflow: z.string() })).max(5000),
  })).max(256),
});

const unique = (ids: string[], kind: string) => {
  if (new Set(ids).size !== ids.length) throw new Error(`InferOps fixture has duplicate ${kind} IDs`);
};

/** Check canonical wire shape and local-fixture relationships without returning record contents. */
export function validateBoardFixture(input: unknown, targetRef: string) {
  const parsed = boardSchema.safeParse(input);
  if (!parsed.success) throw new Error("InferOps fixture does not match the pinned BoardResponse schema; check required fields and wire types");
  const selected = relationships.safeParse(parsed.data);
  if (!selected.success) throw new Error("InferOps fixture exceeds supported project, column or issue limits");
  const board = selected.data;
  unique(board.projects.map(project => project.id), "project");
  unique(board.columns.map(column => column.state.id), "state");
  const issues = board.columns.flatMap(column => column.issues);
  if (issues.length > 5000) throw new Error("InferOps fixture supports at most 5000 issues");
  unique(issues.map(issue => issue.id), "issue");
  const project = board.projects.find(candidate => candidate.id === board.projectId);
  if (!project || project.identifier !== targetRef.split("/").at(-1)) {
    throw new Error("InferOps fixture selected project must match inferops.targetRef");
  }
  for (const column of board.columns) {
    if (column.issues.some(issue => issue.stateId !== column.state.id || issue.workflow !== column.state.workflow)) {
      throw new Error("InferOps fixture issue state and workflow must match its containing column");
    }
  }
  return { projects: board.projects.length, columns: board.columns.length, issues: issues.length, schemaRevision: contract.source.revision as string };
}

/** Validate the configured synthetic fixture; never read files for remote mode. */
export function checkConsumerFixture(root: string) {
  const config = parseConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
  if (config.inferops.mode !== "fixture") return { mode: "remote", validated: false };
  const directory = join(root, "fixtures");
  const directoryStat = lstatSync(directory);
  const path = join(root, config.inferops.fixture);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Consumer fixtures must be a regular directory");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("Consumer board fixture must be a regular JSON file of at most 1 MiB");
  }
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Consumer board fixture is not valid JSON"); }
  return { mode: "fixture", validated: true, ...validateBoardFixture(input, config.inferops.targetRef) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || process.argv[3]) throw new Error("Usage: fixtures.ts CONSUMER_ROOT");
  console.log(JSON.stringify({ ok: true, operation: "fixtures", ...checkConsumerFixture(resolve(process.argv[2])), runtimeReady: false }));
}
