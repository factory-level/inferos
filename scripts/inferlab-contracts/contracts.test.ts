/**
 * The consumer side of the InferLab cross-product contracts (FAC-216): this tree reads InferOps'
 * schemas the way InferOps meant them. Every reviewed fixture is checked against its JSON Schema, as
 * InferOS reads it (zod 4's `fromJSONSchema`, already a dependency here): every valid case passes,
 * every invalid case fails, and a major version the schema doesn't define is refused. The copy must
 * match `pin.json` byte for byte, so a hand edit fails here.
 *
 * Attention and identity get their own tests, for what the InferOS host will rely on (FAC-237,
 * FAC-214): an intent can't name people or a link, and the documented keys reproduce InferOps' own
 * bytes.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { HERE, type Pin, pinProblems, readLocal } from "./sync.ts";

type Fixtures = {
  valid: { name: string; value: unknown }[];
  invalid: { name: string; why: string; value: unknown }[];
};

const read = (path: string) => JSON.parse(readFileSync(join(HERE, path), "utf8"));
const schemaNames = readdirSync(join(HERE, "schemas")).toSorted();
const contractOf = (schemaName: string) => schemaName.replace(/\.schema\.json$/, "");
const validator = (schemaName: string) => z.fromJSONSchema(read(`schemas/${schemaName}`));

describe("the pinned copy", () => {
  it("matches pin.json exactly: no file was edited, added or dropped by hand", () => {
    const pin = read("pin.json") as Pin;
    assert.match(pin.inferops.revision, /^[0-9a-f]{40}$/);
    assert.deepEqual(pinProblems(pin, readLocal()), []);
  });

  it("refuses a copy with one byte changed", () => {
    const pin = read("pin.json") as Pin;
    const files = readLocal();
    const [name, text] = files[0]!;
    files[0] = [name, `${text} `];
    assert.deepEqual(pinProblems(pin, files), [`${name}: edited by hand (hash differs from pin.json)`]);
  });

  it("has one fixture file for every schema", () => {
    assert.deepEqual(
      readdirSync(join(HERE, "fixtures")).toSorted(),
      schemaNames.map((s) => `${contractOf(s)}.json`),
    );
  });
});

for (const schemaName of schemaNames) {
  const contract = contractOf(schemaName);
  describe(contract, () => {
    const schema = validator(schemaName);
    const fixtures = read(`fixtures/${contract}.json`) as Fixtures;

    for (const f of fixtures.valid) {
      it(`accepts ${f.name}`, () => assert.equal(schema.safeParse(f.value).success, true));
    }
    for (const f of fixtures.invalid) {
      it(`refuses ${f.name}: ${f.why}`, () => assert.equal(schema.safeParse(f.value).success, false));
    }
    it("refuses a major version it doesn't define", (t) => {
      const first = fixtures.valid[0]?.value as Record<string, unknown>;
      if (!("v" in first)) return t.skip("a sub-shape with no version of its own");
      assert.equal(schema.safeParse({ ...first, v: (first.v as number) + 1 }).success, false);
    });
  });
}

describe("attention at the host boundary (FAC-237 builds on this)", () => {
  const schema = read("schemas/inferlab.attention-intent.v1.schema.json");
  const intent = validator("inferlab.attention-intent.v1.schema.json");
  const valid = (read("fixtures/inferlab.attention-intent.v1.json") as Fixtures).valid[0]!.value as Record<
    string,
    unknown
  >;

  it("defines no URL, recipient list or preview text", () => {
    assert.deepEqual(Object.keys(schema.properties).toSorted(), ["audience", "reason", "sourceEventId", "target", "v"]);
  });

  it("only takes an audience rule, never named people", () => {
    const named = { ...valid, audience: { kind: "subjects", subjects: [{ issuer: "http://localhost:8080", subject: "p" }] } };
    assert.equal(intent.safeParse(named).success, false);
  });

  it("only takes a reference as its target, never a URL", () => {
    assert.equal(intent.safeParse({ ...valid, target: "https://example.test/x" }).success, false);
  });
});

/**
 * The documented key forms (InferOps `subjectKey` and `attentionItemKey`), written out here so the
 * host can't drift from the bytes InferOps produces.
 */
const encodePart = (part: string) => encodeURIComponent(part).replaceAll("~", "%7E");
const subjectKey = (s: { issuer: string; subject: string }) =>
  `subject~${encodePart(s.issuer)}~${encodePart(s.subject)}`;
const itemKey = (recipient: { issuer: string; subject: string }, sourceEventId: string, reason: string) =>
  `${subjectKey(recipient)}|${sourceEventId}|${reason}`;

describe("attention dedupe keys", () => {
  const items = (read("fixtures/inferlab.attention-item.v1.json") as Fixtures).valid.map(
    (f) => f.value as { itemKey: string; recipient: { issuer: string; subject: string }; sourceEventId: string; reason: string },
  );

  it("reproduce the key InferOps wrote into every item fixture", () => {
    for (const item of items) assert.equal(itemKey(item.recipient, item.sourceEventId, item.reason), item.itemKey);
  });

  it("don't depend on which Gadget asked: one event and reason give one item per person", () => {
    const [item] = items;
    const fromA = itemKey(item!.recipient, item!.sourceEventId, item!.reason);
    const fromB = itemKey({ ...item!.recipient }, item!.sourceEventId, item!.reason);
    assert.equal(fromA, fromB);
    assert.notEqual(fromA, itemKey({ ...item!.recipient, subject: "someone-else" }, item!.sourceEventId, item!.reason));
  });

  it("can't collide by running the issuer and subject together", () => {
    assert.notEqual(
      subjectKey({ issuer: "https://a.test", subject: "x~y" }),
      subjectKey({ issuer: "https://a.test", subject: "x%7Ey" }),
    );
  });
});

// Account keying (FAC-214) is tested where the kernel's `subjectAccountName` can be imported:
// packages/workshop-backend/__tests__/subject-login.test.ts checks it against these fixtures (it
// equals the contract's subjectKey on every item fixture) and that email plays no part in it.
