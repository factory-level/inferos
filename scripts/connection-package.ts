// A connection package's `connection.json`, read the way every loader reads it: validated against
// `connection-package.schema.json`, never trusted for anything it does not pass. Used by the wrapper
// gatekeeper loader (`consumer/gatekeepers.ts`), the scaffolder, the release manifest and the canvas
// selection; `connection-package.test.ts` additionally checks the fork's own packages against source.

import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CONNECTION_FILE, type ConnectionStatus } from "./connection-status.ts";

export {
  CONNECTION_FILE, CONNECTION_STATUSES, RELEASED_STATUSES, declaredStatus, isUnreleasedConnection,
  type ConnectionStatus,
} from "./connection-status.ts";

/**
 * The gatekeeper API level this checkout implements: the `workshop-shared` gatekeeper interfaces and
 * the `gatekeeper-kit` modules a connection package is compiled against. Raised when either changes
 * incompatibly. A wrapper gatekeeper lists the levels it was built for in
 * `compatibility.inferos.gatekeeperApi`, and is not bound by a checkout whose level it does not list.
 */
export const GATEKEEPER_API_LEVEL = 1;

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "connection-package.schema.json");
const validator = z.fromJSONSchema(JSON.parse(readFileSync(schemaPath, "utf8")));

/** The parts of a validated contract the loaders read. The schema guarantees their shape. */
export interface ConnectionContract {
  schemaVersion: 1;
  id: string;
  package: string;
  status: ConnectionStatus;
  compatibility: { inferos?: { gatekeeperApi: number[] } };
}

/** What reading a package directory's `connection.json` found. */
export type ConnectionRead =
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | { state: "valid"; contract: ConnectionContract };

/** Validate parsed `connection.json` content; the reason names the first failing path, never a value. */
export function validateConnection(raw: unknown): ConnectionRead {
  const parsed = validator.safeParse(raw);
  if (parsed.success) return { state: "valid", contract: raw as ConnectionContract };
  const [issue] = parsed.error.issues;
  const at = issue?.path.length ? issue.path.map(String).join(".") : "(root)";
  return { state: "invalid", reason: `${CONNECTION_FILE} does not match the schema at ${at}` };
}

/**
 * Read and validate `dir`'s `connection.json`. A symbolic link, unreadable file or invalid JSON is
 * `invalid`, not `missing`: a loader must refuse it rather than treat the package as uncontracted.
 */
export function readConnection(dir: string): ConnectionRead {
  const path = join(dir, CONNECTION_FILE);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "invalid", reason: `${CONNECTION_FILE} cannot be read` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { state: "invalid", reason: `${CONNECTION_FILE} must be a regular file` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "invalid", reason: `${CONNECTION_FILE} is not valid JSON` };
  }
  return validateConnection(raw);
}
