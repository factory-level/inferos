import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployTargetProblem, parseDeployTargets, parseKvNamespaceList, retryWhileDnsPending,
} from "./stage-resources.ts";

test("parseKvNamespaceList finds the array after Wrangler's banner and refuses duplicate titles", () => {
  const stdout = " ⛅️ wrangler 4.138.0\n───\n" + JSON.stringify([
    { id: "a1", title: "inferos-dev-workshop-backend-blueprints", supports_url_encoding: true },
    { id: "b2", title: "something-else" },
    { title: "no-id" },
  ]);
  assert.deepEqual([...parseKvNamespaceList(stdout)], [
    ["inferos-dev-workshop-backend-blueprints", "a1"], ["something-else", "b2"],
  ]);
  assert.throws(() => parseKvNamespaceList(JSON.stringify([{ id: "1", title: "x" }, { id: "2", title: "x" }])),
      /two KV namespaces are titled "x"/);
  assert.throws(() => parseKvNamespaceList("not logged in"), /no JSON array/);
});

test("parseDeployTargets reads the deploy entries of an output file", () => {
  const file = [
    JSON.stringify({ version: 1, type: "wrangler-session", wrangler_version: "4.138.0" }),
    "",
    JSON.stringify({ version: 1, type: "deploy", worker_name: "inferos-dev-router", targets: ["dev-os.factorylevel.dev (custom domain)"] }),
  ].join("\n");
  assert.deepEqual(parseDeployTargets(file), ["dev-os.factorylevel.dev (custom domain)"]);
  assert.deepEqual(parseDeployTargets(JSON.stringify({ type: "deploy", worker_name: "x" })), []);
  assert.equal(parseDeployTargets(JSON.stringify({ type: "wrangler-session" })), null);
});

test("deployTargetProblem allows a worker its own custom domain and nothing anywhere else", () => {
  const host = "dev-os.factorylevel.dev";
  assert.equal(deployTargetProblem("inferos-dev-router", [`${host} (custom domain)`], host), null);
  assert.match(String(deployTargetProblem("inferos-dev-router",
      [`${host} (custom domain)`, "https://inferos-dev-router.example.workers.dev"], host)), /workers\.dev/);
  assert.match(String(deployTargetProblem("inferos-dev-router", [], host)), /no targets/);
  assert.equal(deployTargetProblem("inferos-dev-workshop-backend", [], null), null);
  assert.match(String(deployTargetProblem("inferos-dev-workshop-backend",
      ["https://inferos-dev-workshop-backend.example.workers.dev"], null)), /must have no URL/);
});

test("retryWhileDnsPending waits out ENOTFOUND, then returns the probe's answer", async () => {
  const notYet = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND dev-os.example.dev"), { code: "ENOTFOUND" }),
  });
  let calls = 0;
  const slept: number[] = [];
  const answer = await retryWhileDnsPending(async () => {
    calls++;
    if (calls < 3) throw notYet;
    return "access-redirect";
  }, 60_000, async (ms) => { slept.push(ms); });
  assert.equal(answer, "access-redirect");
  assert.deepEqual(slept, [2_000, 4_000]);
});

test("retryWhileDnsPending rethrows other errors at once, and DNS failures past the deadline", async () => {
  await assert.rejects(retryWhileDnsPending(async () => { throw new Error("ECONNRESET"); }, 60_000,
      async () => { assert.fail("must not wait on a non-DNS error"); }), /ECONNRESET/);
  await assert.rejects(retryWhileDnsPending(async () => {
    throw Object.assign(new Error("getaddrinfo EAI_AGAIN x"), { code: "EAI_AGAIN" });
  }, 0, async () => {}), /EAI_AGAIN/);
});
