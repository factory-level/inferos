import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  artifactRefusalOf, type ArtifactDigest, type ArtifactQualification,
} from "@gadgets/workshop-shared/agent-artifact";
import type { Overseer, WorkpieceId } from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE } from "../src/mock-model.js";
import { connect, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

let harness: Harness | undefined;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
});

afterAll(async () => {
  try {
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
    await harness?.server.close();
  }
});

const files = (gadgetId: number, path: string, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [[path, text]])]]);

/** A workspace with one gadget, and a way to merge one-file edits into its mainline. */
async function authoringWorkspace(username: string) {
  if (!harness) throw new Error("Workshop harness did not start");
  const api = connect(harness.url);
  const owner = await signUp(api, username);
  const workspace = await owner.newGadget();
  const workpieces = new WorkpieceRecorder();
  const subscriber = stubFor(workpieces);
  const subscription = await workspace.subscribeToWorkpieces(subscriber);
  await workpieces.loaded;
  const headOf = (gadgetId: WorkpieceId, after?: string) => waitFor(`a new head for ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined && summary.commitId !== after
      ? summary.commitId : null;
  });
  const gadget = async (title: string, bindingName: string) => {
    using client = workspace.createGadget(title, undefined, bindingName);
    return client.getId();
  };
  const commit = async (gadgetId: WorkpieceId, path: string, before: string | undefined, after: string) => {
    const head = await headOf(gadgetId);
    const chatId = await workspace.newChat("Edit", null);
    await workspace.submitCodeChange(chatId, {
      generation: 0, revision: 0, clientId: "edit", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: diffFiles(files(gadgetId, path, before), files(gadgetId, path, after)),
    });
    expect(await workspace.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    return headOf(gadgetId, head);
  };
  return {
    owner, workspace, gadget, commit, headOf, workpieceCount: () => workpieces.summaries.size,
    [Symbol.dispose]() {
      for (const stub of [subscription, subscriber, workspace, owner, api]) stub[Symbol.dispose]();
    },
  };
}

const qualified = (digest: ArtifactDigest, passed = true): ArtifactQualification => ({
  digest, harness: "inferos-qualify@1", completedAt: new Date(),
  checks: [
    { name: "fixtures/routes-bug", mode: "deterministic", passed },
    { name: "live/routes-bug", mode: "liveModel", passed: false, model: { provider: "openai", modelName: "gpt" } },
  ],
});

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return artifactRefusalOf(error);
  }
  throw new Error("Expected a refusal");
}

it("publishes qualified revisions, refuses stale or incomplete proof, and rebinds an exact revision", async () => {
  using env = await authoringWorkspace("artifactauthor");
  const ws: RpcStub<Overseer> = env.workspace;
  const skill = await env.gadget("Triage skill", "TRIAGE");
  await env.commit(skill, "SKILL.md", undefined, "Route bugs.\n");

  const v1 = await ws.validateArtifact(skill, "skill", [], null);
  expect(v1.refusals).toEqual([]);
  expect(Object.keys(v1.manifest.files)).toEqual(["SKILL.md"]);

  // Proof must be bound to the digest and complete; a failing live-model check never gates.
  const stale = `sha256:${"0".repeat(64)}` as const;
  expect(await ws.publishArtifactRevision(skill, "skill", "triage", 1, [], null, qualified(stale)))
      .toMatchObject({ ok: false, refusal: "qualification_stale" });
  expect(await ws.publishArtifactRevision(skill, "skill", "triage", 1, [], null, qualified(v1.digest, false)))
      .toMatchObject({ ok: false, refusal: "qualification_incomplete" });
  const published = await ws.publishArtifactRevision(skill, "skill", "triage", 1, [], null, qualified(v1.digest));
  expect(published).toMatchObject({
    ok: true, created: true,
    revision: { ref: "skill/triage@1", digest: v1.digest, publishedBy: { type: "user", id: expect.any(String) } },
  });
  expect(await ws.publishArtifactRevision(skill, "skill", "triage", 1, [], null, qualified(v1.digest)))
      .toMatchObject({ ok: true, created: false });
  expect(await ws.getArtifactRevision("skill/triage@1")).toMatchObject({ digest: v1.digest });
  expect(await refusalOf(ws.getArtifactRevision("skill/triage@latest" as never))).toBe("inexact_reference");

  // Any change to the files is a new digest; the earlier proof is stale for it.
  await env.commit(skill, "SKILL.md", "Route bugs.\n", "Route bugs first.\n");
  const v2 = await ws.validateArtifact(skill, "skill", [], null);
  expect(v2.digest).not.toBe(v1.digest);
  expect(await ws.publishArtifactRevision(skill, "skill", "triage", 2, [], null, qualified(v1.digest)))
      .toMatchObject({ ok: false, refusal: "qualification_stale" });
  expect(await ws.publishArtifactRevision(skill, "skill", "triage", 2, [], null, qualified(v2.digest)))
      .toMatchObject({ ok: true, created: true });
  expect(await ws.publishArtifactRevision(skill, "skill", "triage", 1, [], null, qualified(v2.digest)))
      .toMatchObject({ ok: false, refusal: "revision_exists_different_digest" });
  expect((await ws.listArtifactRevisions("skill", "triage")).map(revision => revision.ref))
      .toEqual(["skill/triage@1", "skill/triage@2"]);
  expect(await ws.diffArtifactRevisions("skill/triage@1", "skill/triage@2"))
      .toEqual([{ type: "file", path: "SKILL.md", change: "modified" }]);

  // A dependent pins an exact dependency digest; an altered or missing dependency is refused.
  const agent = await env.gadget("Triage agent", "TRIAGE_AGENT");
  await env.commit(agent, "persona.md", undefined, "Be brief.\n");
  const pin = { kind: "skill" as const, name: "triage", number: 1, digest: v1.digest };
  expect((await ws.validateArtifact(agent, "agent", [pin], { type: "any" })).refusals).toEqual([]);
  expect((await ws.validateArtifact(agent, "agent", [{ ...pin, digest: v2.digest }], null)).refusals)
      .toEqual(["pin_digest_mismatch"]);
  expect((await ws.validateArtifact(agent, "agent", [{ ...pin, number: 3 }], null)).refusals)
      .toEqual(["pin_unresolved"]);

  // Credential-shaped files are refused by path.
  await env.commit(agent, "persona.md", "Be brief.\n", `token: ghp_${"x1".repeat(18)}\n`);
  const leaky = await ws.validateArtifact(agent, "agent", [pin], null);
  expect(leaky.refusals).toEqual(["secret_present"]);
  expect(await ws.publishArtifactRevision(agent, "agent", "triage-agent", 1, [pin], null, qualified(leaky.digest)))
      .toEqual({ ok: false, refusal: "secret_present", detail: "persona.md" });

  // Rolling back means binding an earlier exact revision: a new gadget at its published files.
  await expect(ws.bindArtifactRevision("skill/triage@1", { MODEL: { type: "aiModel", modelId: "x" } }))
      .rejects.toThrow(/Unknown binding name/);
  const rebound = await ws.bindArtifactRevision("skill/triage@1", {});
  expect(rebound).not.toBe(skill);
  const head = await env.headOf(rebound);
  expect(await ws.readFilesAtCommit(head, ["SKILL.md"]))
      .toEqual([["SKILL.md", { kind: "text", text: "Route bugs.\n" }]]);
});

it("refuses an incompatible model before creating anything, and binds a compatible one", async () => {
  using env = await authoringWorkspace("artifactbinder");
  const ws: RpcStub<Overseer> = env.workspace;
  await env.owner.addModel(SCRIPTED_MODEL_PROFILE, SCRIPTED_MODEL_CONFIG);
  const agent = await env.gadget("Agent", "AGENT");
  await env.commit(agent, "persona.md", undefined, "Be brief.\n");
  {
    using model = await ws.newAiModelGatekeeper(SCRIPTED_MODEL_ID);
    using gadget = await ws.getGadget(agent);
    await gadget.bind("MODEL", await model.getId());
  }
  const exactOther = { type: "exact" as const, provider: "openai", modelName: "gpt" };
  const other = await ws.validateArtifact(agent, "agent", [], exactOther);
  expect(other.manifest.bindings).toEqual({ MODEL: { type: "aiModel" } });
  expect(await ws.publishArtifactRevision(agent, "agent", "brief", 1, [], exactOther, qualified(other.digest)))
      .toMatchObject({ ok: true });
  const exactOwn = { type: "exact" as const, provider: SCRIPTED_MODEL_CONFIG.provider, modelName: SCRIPTED_MODEL_ID };
  const own = await ws.validateArtifact(agent, "agent", [], exactOwn);
  expect(await ws.publishArtifactRevision(agent, "agent", "brief", 2, [], exactOwn, qualified(own.digest)))
      .toMatchObject({ ok: true });

  const assignment = { MODEL: { type: "aiModel" as const, modelId: SCRIPTED_MODEL_ID } };
  const before = env.workpieceCount();
  expect(await refusalOf(ws.bindArtifactRevision("agent/brief@1", assignment))).toBe("incompatible_requirement");
  expect(await refusalOf(ws.bindArtifactRevision("agent/brief@1", { MODEL: { type: "agentSpawner", modelId: null } })))
      .toBe("incompatible_requirement");
  const rebound = await ws.bindArtifactRevision("agent/brief@2", assignment);
  // The successful bind adds exactly one gadget; the refusals added none.
  await waitFor("the rebound gadget", async () => env.workpieceCount() === before + 1 || null);
  using gadget = await ws.getGadget(rebound);
  const bindings = await gadget.listBindings();
  expect(bindings.map(binding => binding.name)).toEqual(["MODEL"]);
  // Workpiece ids are allocated sequentially: the source's model connection, then the rebound
  // gadget, then its connection. A refusal that had created anything would leave a gap.
  using source = await ws.getGadget(agent);
  const [sourceModel] = await source.listBindings();
  expect([rebound, bindings[0]!.target]).toEqual([sourceModel!.target + 1, sourceModel!.target + 2]);
});
