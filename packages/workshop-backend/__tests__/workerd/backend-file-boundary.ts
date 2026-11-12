// A `setupFiles` entry of the `backend` project (see vitest.config.ts), which runs its files with
// `isolate: false`: a pool worker keeps one Miniflare and one module graph for every file it runs,
// instead of starting a fresh one per file. It marks where each file starts and ends, so `test-worker.ts`'s
// overseer runs an alarm only for the file that made it: an alarm a finished file left armed must
// not wake its overseer -- and resume its persisted agent calls through `fetch`, which the running
// file may have stubbed -- while a later file runs.
//
// A file's Durable Objects and their storage outlive it, so each file's object names carry its own
// prefix. They are not torn down here: `reset()` and `abortAllDurableObjects()` crash workerd when a
// gadget's tail event is still being delivered to an overseer they abort, and
// `evictAllDurableObjects()` waits on requests that never finish (subscriptions, held sessions).
//
// The User namespace every overseer holds as `impl.users` is one object for the whole worker, too, so
// a file that assigns onto it (`impl.users.get = ...`) would hand its stand-in to every later file's
// user lookups. As each file ends, anything it added there is removed and the file fails, naming it.

import { afterAll, beforeAll } from "vitest";
import { beginTestFile, takeSharedUsersChanges } from "../test-worker.js";

beforeAll(() => beginTestFile());
// And again as it ends, so an alarm that fires while the next file is still loading is not
// attributed to this one.
afterAll(() => {
  beginTestFile();
  let changed = takeSharedUsersChanges();
  if (changed.length > 0) {
    throw new Error(`This file assigned ${changed.join(", ")} onto the User namespace every overseer shares; `
      + "give the workspace its own stand-in (impl.users = {...}) instead.");
  }
});
