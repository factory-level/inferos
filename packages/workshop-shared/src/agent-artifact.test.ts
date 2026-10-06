import { describe, expect, test } from "vitest";
import {
  ARTIFACT_DIGEST_PATTERN, ARTIFACT_MANIFEST_FORMAT, artifactDigest, canonicalArtifactJson, fileDigest,
  isQualified, type ArtifactDigest, type ArtifactManifest, type ArtifactQualification,
} from "./agent-artifact";

/** A well-formed digest made of one repeated hex digit. */
const fake = (hex: string): ArtifactDigest => `sha256:${hex.repeat(64)}`;

const manifest = (overrides: Partial<ArtifactManifest> = {}): ArtifactManifest => ({
  format: ARTIFACT_MANIFEST_FORMAT,
  kind: "agent",
  files: { "instructions.md": fake("a"), "persona.md": fake("b") },
  pins: [{ kind: "skill", name: "triage", number: 3, digest: fake("c") }],
  model: { type: "any" },
  bindings: { BOARD: { type: "gatekeeper", gatekeeperName: "inferops", typeUrlPattern: "inferops://*" } },
  ...overrides,
});

describe("canonicalArtifactJson", () => {
  test("sorts keys, drops undefined members and emits no whitespace", () => {
    expect(canonicalArtifactJson({ b: [1, { d: null, c: true }], a: "x", z: undefined }))
        .toBe('{"a":"x","b":[1,{"c":true,"d":null}]}');
  });

  test("sorts keys by UTF-16 code unit, as RFC 8785 does", () => {
    expect(canonicalArtifactJson({ "é": 1, "Z": 2, "a": 3, "\u{1F600}": 4, "ﬁ": 5 }))
        .toBe('{"Z":2,"a":3,"é":1,"\u{1F600}":4,"ﬁ":5}');
  });

  test("does not normalise Unicode", () => {
    expect(canonicalArtifactJson("é")).not.toBe(canonicalArtifactJson("é"));
  });

  test("refuses values two implementations could encode differently", () => {
    for (let bad of [1.5, Number.MAX_SAFE_INTEGER + 1, NaN, 10n, new Date(0), [undefined], () => 1]) {
      expect(() => canonicalArtifactJson(bad)).toThrow(TypeError);
    }
  });
});

describe("artifactDigest", () => {
  test("is a sha256 digest that ignores key order", async () => {
    let reordered = Object.fromEntries(Object.entries(manifest()).toReversed()) as ArtifactManifest;
    let digest = await artifactDigest(manifest());
    expect(digest).toMatch(ARTIFACT_DIGEST_PATTERN);
    expect(await artifactDigest(reordered)).toBe(digest);
  });

  test("changes when a file, pin, model or binding requirement changes", async () => {
    let base = await artifactDigest(manifest());
    let changed = [
      manifest({ files: { ...manifest().files, "persona.md": fake("d") } }),
      manifest({ pins: [{ ...manifest().pins[0], digest: fake("e") }] }),
      manifest({ model: { type: "exact", provider: "anthropic", modelName: "claude-sonnet-4-6" } }),
      manifest({ bindings: { BOARD: { type: "gatekeeper", gatekeeperName: "inferops", typeUrlPattern: "x" } } }),
      manifest({ kind: "skill" }),
    ];
    for (let next of changed) expect(await artifactDigest(next)).not.toBe(base);
  });

  test("hashes a file's exact bytes", async () => {
    expect(await fileDigest(new TextEncoder().encode("abc")))
        .toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("isQualified", () => {
  const digest = fake("f");
  const qualification = (checks: ArtifactQualification["checks"], forDigest = digest): ArtifactQualification =>
    ({ digest: forDigest, harness: "test@1", checks, completedAt: new Date(0) });

  test("needs a passing deterministic check for exactly this digest", () => {
    expect(isQualified(qualification([{ name: "a", mode: "deterministic", passed: true }]), digest)).toBe(true);
    expect(isQualified(qualification([{ name: "a", mode: "deterministic", passed: true }], fake("0")), digest))
        .toBe(false);
    expect(isQualified(qualification([{ name: "a", mode: "deterministic", passed: false }]), digest)).toBe(false);
  });

  test("never lets a live-model check decide", () => {
    expect(isQualified(qualification([{ name: "live", mode: "liveModel", passed: true }]), digest)).toBe(false);
    expect(isQualified(qualification([
      { name: "a", mode: "deterministic", passed: true },
      { name: "live", mode: "liveModel", passed: false },
    ]), digest)).toBe(true);
  });
});
