// A `setupFiles` entry of the `backend` project (see vitest.config.ts), which runs its files with
// `isolate: false`: a pool worker keeps one Miniflare and one module graph for every file it runs,
// instead of starting a fresh one per file. It marks where each file starts, so `test-worker.ts`'s
// overseer runs an alarm only for the file that made it: an alarm a finished file left armed must
// not wake its overseer -- and resume its persisted agent calls through `fetch`, which the running
// file may have stubbed -- while a later file runs.
//
// A file's Durable Objects and their storage outlive it, so each file's object names carry its own
// prefix. They are not torn down here: `reset()` and `abortAllDurableObjects()` crash workerd when a
// gadget's tail event is still being delivered to an overseer they abort, and
// `evictAllDurableObjects()` waits on requests that never finish (subscriptions, held sessions).

import { beforeAll } from "vitest";
import { beginTestFile } from "../test-worker.js";

beforeAll(() => beginTestFile());
