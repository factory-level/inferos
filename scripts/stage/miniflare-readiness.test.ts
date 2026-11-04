import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForMiniflareReady } from "./miniflare-readiness.ts";

test("Miniflare startup fails with a clear timeout when readiness stalls", async () => {
  await assert.rejects(waitForMiniflareReady(new Promise(() => {}), 1),
    /Miniflare did not become ready within 1ms/);
});

test("Miniflare startup clears its timeout after becoming ready", async () => {
  await waitForMiniflareReady(Promise.resolve(), 1_000);
});
