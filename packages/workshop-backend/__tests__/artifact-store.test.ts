import { describe, expect, it, vi } from "vitest";
import {
  artifactDigest, artifactRef, artifactRefusalOf, type ArtifactDigest, type ArtifactPin,
  type ArtifactQualification,
} from "@gadgets/workshop-shared/agent-artifact";
import type { BlueprintBinding } from "@gadgets/workshop-shared/api";
import {
  artifactRefusalError, containsSecret, requireBindingTemplates, diffManifests, qualificationFindings, requirePins, revisionOf,
  WorkspaceArtifactStore, type ArtifactRevisionRecord,
} from "../src/artifact-store.js";
import { makeOverseerStorage } from "../src/overseer.js";
import {
  ARTIFACT_ARCHIVE_VERSION, buildBlueprintArchiveStream, parseArtifactArchive, parseBlueprintArchive,
} from "../src/blueprint-archive.js";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const fake = (hex: string): ArtifactDigest => `sha256:${hex.repeat(64)}`;

function makeStore() {
  let durable = makeMockStorage();
  return new WorkspaceArtifactStore(durable, makeOverseerStorage(durable));
}

const BINDINGS: Record<string, BlueprintBinding> = {
  BOARD: {
    title: "Board", description: "", type: "gatekeeper", gatekeeperName: "inferops",
    typeUrlPattern: "inferops://*", resourceUrl: "inferops://acme.ops/project/board/OPS",
  },
  MODEL: { title: "Model", description: "", type: "aiModel", suggestedModel: { provider: "openai", modelName: "gpt" } },
};

const passing = (digest: ArtifactDigest, extra: ArtifactQualification["checks"] = []): ArtifactQualification => ({
  digest, harness: "inferos-qualify@1",
  checks: [{ name: "fixtures/routes-bug", mode: "deterministic", passed: true }, ...extra],
  completedAt: new Date(0),
});

async function publish(store: WorkspaceArtifactStore, kind: "skill" | "agent", name: string, number: number,
    files: Record<string, string>, pins: ArtifactPin[] = []) {
  let draft = await store.draft(kind, new Map(Object.entries(files)), pins, { type: "any" }, {});
  let record: ArtifactRevisionRecord = {
    ref: artifactRef(kind, name, number), kind, name, number, digest: draft.digest, manifest: draft.manifest,
    qualification: passing(draft.digest), publishedBy: { type: "user", id: "ada", name: "Ada" },
    publishedAt: new Date(0), commitId: "0".repeat(40), bindingTemplates: draft.bindingTemplates,
  };
  return { draft, result: store.publish(record) };
}

describe("drafts", () => {
  it("digests the manifest of decoded files, requirements and pins, and drops source suggestions", async () => {
    let store = makeStore();
    let draft = await store.draft("agent", new Map([["persona.md", "Be brief.\n"]]), [], null, BINDINGS);
    expect(draft.digest).toBe(await artifactDigest(draft.manifest));
    expect(draft.manifest.bindings).toEqual({
      BOARD: { type: "gatekeeper", gatekeeperName: "inferops", typeUrlPattern: "inferops://*" },
      MODEL: { type: "aiModel" },
    });
    expect(JSON.stringify(draft.bindingTemplates)).not.toMatch(/acme|suggestedModel/);
    expect(draft.findings).toEqual([]);
  });

  it("refuses credential-shaped files by path, never echoing the match", async () => {
    let store = makeStore();
    let key = `ghp_${"a1".repeat(18)}`;
    let draft = await store.draft("skill", new Map([["ok.md", "fine"], ["config.ts", `const t = "${key}";`]]),
        [], null, {});
    expect(draft.findings).toEqual([{ refusal: "secret_present", detail: "config.ts" }]);
    expect(JSON.stringify(draft.findings)).not.toContain(key);
  });

  it("refuses unsorted or duplicate pins instead of sorting them", () => {
    let a = { kind: "skill" as const, name: "a", number: 1, digest: fake("1") };
    let b = { kind: "skill" as const, name: "b", number: 1, digest: fake("2") };
    expect(requirePins([a, b])).toEqual([a, b]);
    expect(() => requirePins([b, a])).toThrow(/sorted/);
    expect(() => requirePins([a, { ...a, number: 2 }])).toThrow(/one per kind and name/);
    expect(() => requirePins([{ ...a, number: 0 }])).toThrow(/revision number/);
  });
});

describe("pins and dependencies", () => {
  it("reports unresolved pins and pins whose dependency was published with another digest", async () => {
    let store = makeStore();
    let { draft: skill } = await publish(store, "skill", "triage", 1, { "SKILL.md": "Route bugs.\n" });
    let pin = { kind: "skill" as const, name: "triage", number: 1, digest: skill.digest };
    expect(store.pinFindings([pin])).toEqual([]);
    expect(store.pinFindings([{ ...pin, number: 2 }]))
        .toEqual([{ refusal: "pin_unresolved", detail: "skill/triage@2" }]);
    expect(store.pinFindings([{ ...pin, digest: fake("f") }]))
        .toEqual([{ refusal: "pin_digest_mismatch", detail: "skill/triage@1" }]);
  });

  it("changes a dependent's digest, and so stales its qualification, when a pinned dependency changes", async () => {
    let store = makeStore();
    let { draft: v1 } = await publish(store, "skill", "triage", 1, { "SKILL.md": "Route bugs.\n" });
    let { draft: v2 } = await publish(store, "skill", "triage", 2, { "SKILL.md": "Route bugs first.\n" });
    let files = new Map([["persona.md", "Be brief.\n"]]);
    let pinned = (draft: typeof v1) => [{ kind: "skill" as const, name: "triage", number: draft === v1 ? 1 : 2, digest: draft.digest }];
    let agentV1 = await store.draft("agent", files, pinned(v1), null, {});
    let agentV2 = await store.draft("agent", files, pinned(v2), null, {});
    expect(agentV2.digest).not.toBe(agentV1.digest);
    expect(qualificationFindings(passing(agentV1.digest), agentV2.digest))
        .toEqual([{ refusal: "qualification_stale", detail: `qualification is for ${agentV1.digest}` }]);
  });
});

describe("qualification", () => {
  it("needs a deterministic check and every deterministic check passing; live-model checks never gate", () => {
    let digest = fake("a");
    let live = { name: "live/triage", mode: "liveModel" as const, passed: false,
      model: { provider: "openai", modelName: "gpt" } };
    expect(qualificationFindings(passing(digest, [live]), digest)).toEqual([]);
    expect(qualificationFindings({ ...passing(digest), checks: [live] }, digest))
        .toEqual([{ refusal: "qualification_incomplete", detail: "no deterministic check" }]);
    let failed = passing(digest, [{ name: "fixtures/edge", mode: "deterministic", passed: false }]);
    expect(qualificationFindings(failed, digest))
        .toEqual([{ refusal: "qualification_incomplete", detail: "deterministic check failed: fixtures/edge" }]);
  });

  it("refuses credential-shaped evidence by field", () => {
    let digest = fake("a");
    let leaky = passing(digest, [{ name: "live/x", mode: "liveModel", passed: true,
      detail: "used key AKIAABCDEFGHIJKLMNOP" }]);
    expect(qualificationFindings(leaky, digest))
        .toEqual([{ refusal: "secret_present", detail: "qualification.checks[1].detail" }]);
  });
});

describe("publishing", () => {
  it("is immutable per name and number, accepts identical republishes and only increases", async () => {
    let store = makeStore();
    let first = await publish(store, "skill", "triage", 2, { "SKILL.md": "v2\n" });
    expect(first.result).toMatchObject({ created: true });
    expect(store.list("skill", "triage").map(revisionOf))
        .toEqual([revisionOf((first.result as { record: ArtifactRevisionRecord }).record)]);

    expect((await publish(store, "skill", "triage", 2, { "SKILL.md": "v2\n" })).result)
        .toMatchObject({ created: false });
    expect((await publish(store, "skill", "triage", 2, { "SKILL.md": "changed\n" })).result)
        .toEqual({ refusal: "revision_exists_different_digest", detail: "skill/triage@2" });
    expect((await publish(store, "skill", "triage", 1, { "SKILL.md": "v1\n" })).result)
        .toEqual({ refusal: "number_not_increasing", detail: "skill/triage@2 is published" });
    expect((await publish(store, "skill", "triage", 3, { "SKILL.md": "v3\n" })).result)
        .toMatchObject({ created: true });
    expect(store.list("skill", "triage").map(record => record.number)).toEqual([2, 3]);
    // A name sharing a prefix lists separately.
    await publish(store, "skill", "triage-x", 1, { "SKILL.md": "x\n" });
    expect(store.list("skill", "triage")).toHaveLength(2);
  });

  it("keeps workspace-local fields off the wire form", async () => {
    let store = makeStore();
    let { result } = await publish(store, "skill", "triage", 1, { "SKILL.md": "v1\n" });
    expect(Object.keys(revisionOf((result as { record: ArtifactRevisionRecord }).record)))
        .not.toEqual(expect.arrayContaining(["commitId"]));
  });
});

describe("diffs", () => {
  it("names changed files, pins, model and bindings", async () => {
    let store = makeStore();
    let a = await store.draft("agent", new Map([["a.md", "1"], ["b.md", "2"]]),
        [{ kind: "skill", name: "triage", number: 1, digest: fake("1") }], { type: "any" }, BINDINGS);
    let b = await store.draft("agent", new Map([["b.md", "3"], ["c.md", "4"]]),
        [{ kind: "skill", name: "triage", number: 2, digest: fake("2") }],
        { type: "exact", provider: "openai", modelName: "gpt" }, { BOARD: BINDINGS.BOARD! });
    expect(diffManifests(a.manifest, b.manifest)).toEqual([
      { type: "file", path: "a.md", change: "removed" },
      { type: "file", path: "b.md", change: "modified" },
      { type: "file", path: "c.md", change: "added" },
      { type: "pin", kind: "skill", name: "triage", from: 1, to: 2 },
      { type: "model", from: { type: "any" }, to: { type: "exact", provider: "openai", modelName: "gpt" } },
      { type: "binding", name: "MODEL", change: "removed" },
    ]);
    expect(diffManifests(a.manifest, a.manifest)).toEqual([]);
  });
});

describe("secret detection", () => {
  it("matches well-known credential formats and leaves ordinary text alone", () => {
    for (let secret of [
      "-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "AKIAABCDEFGHIJKLMNOP",
      `github_pat_${"A".repeat(30)}`, `xoxb-${"1".repeat(12)}`, `sk-ant-${"a".repeat(40)}`,
      `AIza${"b".repeat(35)}`, `sk_live_${"c".repeat(24)}`,
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.${"d".repeat(43)}`,
    ]) expect(containsSecret(`x ${secret} y`), secret).toBe(true);
    for (let text of ["const password = process.env.PASSWORD;", "sk-short", "-----BEGIN PUBLIC KEY-----",
      "Use your API key from settings.", "AKIA is an AWS prefix"]) {
      expect(containsSecret(text), text).toBe(false);
    }
  });

  it("round-trips refusal codes through thrown errors", () => {
    expect(artifactRefusalOf(artifactRefusalError("inexact_reference", "latest"))).toBe("inexact_reference");
    expect(artifactRefusalOf(new Error("No such revision: skill/a@1"))).toBeNull();
  });
});

describe(".gadget format version 2", () => {
  const metadata = { title: "t", description: "", author: { type: "user", id: "a", name: "A" }, created: new Date(0),
    version: 1, lastUpdated: new Date(0), bindings: {} } as const;
  const archive = (version: number) => buildBlueprintArchiveStream({ ...metadata, author: { ...metadata.author } },
      new Response(new Uint8Array([1, 2, 3])).body!, 3, version);

  it("is read only by the version 2 reader, and version 1 only by the version 1 reader", async () => {
    let read = await parseArtifactArchive(archive(ARTIFACT_ARCHIVE_VERSION));
    expect(read).toMatchObject({ rawMetadata: { title: "t" }, contentLength: 3 });
    expect(new Uint8Array(await new Response(read.content).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await expect(parseBlueprintArchive(archive(ARTIFACT_ARCHIVE_VERSION))).rejects.toThrow(/version: 2/);
    await expect(parseArtifactArchive(archive(1))).rejects.toThrow(/version: 1/);
    expect((await parseBlueprintArchive(archive(1))).metadata.created).toEqual(new Date(0));
  });

  it("keeps only the display text, requirement and spawner env of archived binding templates", () => {
    expect(requireBindingTemplates({
      A: { title: "A", description: "", type: "gatekeeper", gatekeeperName: "x", typeUrlPattern: "x://*",
        resourceUrl: "x://secret", extra: 1 },
      S: { title: "S", description: "", type: "agentSpawner", env: { A: { type: "binding", name: "A" }, G: { type: "gadget" } },
        suggestedModel: null, spawnerOnly: true },
    })).toEqual({
      A: { title: "A", description: "", type: "gatekeeper", gatekeeperName: "x", typeUrlPattern: "x://*" },
      S: { title: "S", description: "", type: "agentSpawner", env: { A: { type: "binding", name: "A" }, G: { type: "gadget" } },
        spawnerOnly: true },
    });
    expect(() => requireBindingTemplates({ A: { title: "A", type: "unknown" } })).toThrow(/Unknown binding type/);
  });
});
