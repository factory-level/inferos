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

it("queues a publish request for a person's approval and records the approver as publisher", async () => {
  using env = await authoringWorkspace("artifactapprover");
  const ws: RpcStub<Overseer> = env.workspace;
  const skill = await env.gadget("Triage skill", "TRIAGE");
  await env.commit(skill, "SKILL.md", undefined, "Route bugs.\n");

  using publisher = await ws.newArtifactPublisherGatekeeper();
  expect(await publisher.getCreationSpec()).toEqual({ type: "artifactPublisher" });
  // The session an agent's binding gets: validate, then ask for publication.
  using binding = await publisher.openSession() as unknown as RpcStub<{
    validate(gadgetId: number, kind: string, pins: unknown[], model: unknown): Promise<{ digest: ArtifactDigest; refusals: string[] }>;
    requestPublish(request: object): Promise<void>;
  }>;
  const { digest, refusals } = await binding.validate(skill, "skill", [], null);
  expect(refusals).toEqual([]);
  const request = { gadgetId: skill, kind: "skill", name: "triage", number: 1, pins: [], model: null };
  await binding.requestPublish({ ...request, qualification: qualified(digest) });

  const [pending] = (await ws.listActions({ filter: "pending" })).entries;
  expect(pending).toMatchObject({ type: "action", description: { title: "Publish skill/triage@1", autoApprovable: false } });
  expect(await ws.getArtifactRevision("skill/triage@1")).toBeNull();
  expect(await ws.listPreApprovableActions()).toEqual([]);

  await ws.approveAction(pending!.id);
  const me = await env.owner.whoami();
  expect(await ws.getArtifactRevision("skill/triage@1"))
      .toMatchObject({ digest, publishedBy: { type: "user", id: me.id } });

  // A request whose proof no longer matches stays pending with the refusal, until rejected.
  await binding.requestPublish({ ...request, number: 2, qualification: qualified(`sha256:${"0".repeat(64)}`) });
  const [stale] = (await ws.listActions({ filter: "pending" })).entries;
  await expect(ws.approveAction(stale!.id)).rejects.toThrow(/qualification_stale/);
  expect((await ws.listActions({ filter: "pending" })).entries.map(entry => entry.id)).toEqual([stale!.id]);
  await ws.rejectAction(stale!.id);
  expect(await ws.getArtifactRevision("skill/triage@2")).toBeNull();
  // Malformed requests fail in the requester's call, before anything is queued.
  await expect(binding.requestPublish({ ...request, name: "Bad Name", qualification: qualified(digest) }))
      .rejects.toThrow(/Invalid artifact name/);
});

/** A `.gadget` archive split into its prefix fields, metadata JSON and content bytes. */
async function readArchive(stream: ReadableStream<Uint8Array>) {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLength = view.getUint32(12);
  return {
    version: view.getUint32(8),
    metadata: JSON.parse(new TextDecoder().decode(bytes.subarray(24, 24 + metadataLength))),
    content: bytes.subarray(24 + metadataLength),
    bytes,
  };
}

function writeArchive(version: number, metadata: object, content: Uint8Array): ReadableStream<Uint8Array> {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const bytes = new Uint8Array(24 + metadataBytes.byteLength + content.byteLength);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 0xec2e2d3a2300e317n);
  view.setUint32(8, version);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  bytes.set(metadataBytes, 24);
  bytes.set(content, 24 + metadataBytes.byteLength);
  return new Response(bytes).body!;
}

it("exports revisions as .gadget v2, verifies them on import into a clean workspace, and rebinds explicitly", async () => {
  using source = await authoringWorkspace("artifactexporter");
  const ws: RpcStub<Overseer> = source.workspace;
  await source.owner.addModel(SCRIPTED_MODEL_PROFILE, SCRIPTED_MODEL_CONFIG);
  const skill = await source.gadget("Triage skill", "TRIAGE");
  await source.commit(skill, "SKILL.md", undefined, "Route bugs.\n");
  {
    using model = await ws.newAiModelGatekeeper(SCRIPTED_MODEL_ID);
    using gadget = await ws.getGadget(skill);
    await gadget.bind("MODEL", await model.getId());
  }
  const v1 = await ws.validateArtifact(skill, "skill", [], { type: "any" });
  await ws.publishArtifactRevision(skill, "skill", "triage", 1, [], { type: "any" }, qualified(v1.digest));
  await source.commit(skill, "SKILL.md", "Route bugs.\n", "Route bugs first.\n");
  const v2 = await ws.validateArtifact(skill, "skill", [], { type: "any" });
  await ws.publishArtifactRevision(skill, "skill", "triage", 2, [], { type: "any" }, qualified(v2.digest));
  const agent = await source.gadget("Agent", "AGENT");
  await source.commit(agent, "persona.md", undefined, "Be brief.\n");
  const pin = { kind: "skill" as const, name: "triage", number: 1, digest: v1.digest };
  const a1 = await ws.validateArtifact(agent, "agent", [pin], null);
  await ws.publishArtifactRevision(agent, "agent", "brief", 1, [pin], null, qualified(a1.digest));

  const archive1 = await readArchive(await ws.exportArtifactRevision("skill/triage@1"));
  const archive2 = await readArchive(await ws.exportArtifactRevision("skill/triage@2"));
  const agentArchive = await readArchive(await ws.exportArtifactRevision("agent/brief@1"));
  expect(archive1.version).toBe(2);
  expect(archive1.metadata.revision).toMatchObject({ name: "triage", number: 1, digest: v1.digest });
  expect(archive1.metadata.bindings).toEqual({ MODEL: { title: expect.any(String), description: "", type: "aiModel" } });
  // No credentials, connections, grants, history or execution state travel.
  const text = new TextDecoder().decode(archive1.bytes);
  for (const secret of [SCRIPTED_MODEL_CONFIG.apiToken, SCRIPTED_MODEL_CONFIG.accountId, "Route bugs first"]) {
    expect(text).not.toContain(secret);
  }

  using destination = await authoringWorkspace("artifactimporter");
  const dest: RpcStub<Overseer> = destination.workspace;
  await destination.owner.addModel(SCRIPTED_MODEL_PROFILE, SCRIPTED_MODEL_CONFIG);
  const reimport = (archive: Awaited<ReturnType<typeof readArchive>>, metadata = archive.metadata,
      content = archive.content, version = 2) => dest.importArtifactRevision(writeArchive(version, metadata, content));

  // Tampered and incompatible archives are refused before anything is stored.
  const tamperedFiles = { ...archive1.metadata, revision: { ...archive1.metadata.revision,
    manifest: { ...archive1.metadata.revision.manifest, files: { "SKILL.md": v2.manifest.files["SKILL.md"] } } } };
  expect(await reimport(archive1, tamperedFiles)).toMatchObject({ ok: false, refusal: "digest_mismatch" });
  expect(await reimport(archive1, archive2.metadata)).toMatchObject({ ok: false, refusal: "digest_mismatch" });
  const tamperedBindings = { ...archive1.metadata, bindings: {} };
  expect(await reimport(archive1, tamperedBindings)).toMatchObject({ ok: false, refusal: "digest_mismatch" });
  const corrupt = archive1.content.slice(); corrupt[corrupt.length - 5]! ^= 0xff;
  expect(await reimport(archive1, archive1.metadata, corrupt)).toMatchObject({ ok: false, refusal: "digest_mismatch" });
  const futureFormat = { ...archive1.metadata, revision: { ...archive1.metadata.revision,
    manifest: { ...archive1.metadata.revision.manifest, format: "inferos-artifact/9" } } };
  expect(await reimport(archive1, futureFormat)).toMatchObject({ ok: false, refusal: "unsupported_format" });
  const staleProof = { ...archive1.metadata, revision: { ...archive1.metadata.revision,
    qualification: { ...archive1.metadata.revision.qualification, digest: v2.digest } } };
  expect(await reimport(archive1, staleProof)).toMatchObject({ ok: false, refusal: "qualification_stale" });
  expect(await reimport(agentArchive)).toMatchObject({ ok: false, refusal: "pin_unresolved" });
  await expect(reimport(archive1, archive1.metadata, archive1.content, 1)).rejects.toThrow(/Unsupported gadget archive version: 1/);
  await expect(destination.owner.importBlueprint(writeArchive(2, archive1.metadata, archive1.content)))
      .rejects.toThrow(/Unsupported gadget archive version: 2/);
  expect(await dest.listArtifactRevisions("skill", "triage")).toEqual([]);

  // Verified archives import, publishedBy the importer; a dependent then resolves its pin here.
  const imported = await reimport(archive1);
  expect(imported).toMatchObject({ ok: true, created: true,
    revision: { ref: "skill/triage@1", digest: v1.digest, publishedBy: { id: (await destination.owner.whoami()).id } } });
  expect(await reimport(archive1)).toMatchObject({ ok: true, created: false });
  expect(await reimport(archive2)).toMatchObject({ ok: true, created: true });
  expect(await reimport(agentArchive)).toMatchObject({ ok: true, created: true });

  // Revision selection and rollback: bind the earlier exact revision with the destination's own model.
  const rolledBack = await dest.bindArtifactRevision("skill/triage@1", { MODEL: { type: "aiModel", modelId: SCRIPTED_MODEL_ID } });
  const head = await destination.headOf(rolledBack);
  expect(await dest.readFilesAtCommit(head, ["SKILL.md"])).toEqual([["SKILL.md", { kind: "text", text: "Route bugs.\n" }]]);
  using gadget = await dest.getGadget(rolledBack);
  expect((await gadget.listBindings()).map(binding => binding.name)).toEqual(["MODEL"]);
  // A round trip reproduces the archive's revision exactly.
  expect((await readArchive(await dest.exportArtifactRevision("skill/triage@1"))).metadata.revision)
      .toEqual(archive1.metadata.revision);
});
