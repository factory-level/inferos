import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initialConsumerConfig } from "./config.ts";
import { checkConsumerFixture, validateBoardFixture } from "./fixtures.ts";

const fixture = () => JSON.parse(readFileSync(new URL("./project-board.json", import.meta.url), "utf8"));
const ref = "inferops://demo.local/project/board/DEMO";

test("canonical fixture validates without returning record contents or losing bigint precision", () => {
  const input = fixture();
  input.columns[0].issues[0].revision = "900719925474099300001";
  const result = validateBoardFixture(input, ref);
  assert.deepEqual(result, { projects: 1, columns: 3, issues: 1, schemaRevision: "29b01a024c377b9c37b8754e7001b290e15d1509" });
  assert.equal(input.columns[0].issues[0].revision, "900719925474099300001");
});

test("canonical schema rejects invalid wire types, identities, activity and extra fields", () => {
  for (const edit of [
    (b: ReturnType<typeof fixture>) => { b.columns[0].issues[0].revision = 2; },
    (b: ReturnType<typeof fixture>) => { b.columns[0].issues[0].id = "bad-id"; },
    (b: ReturnType<typeof fixture>) => { b.columns[0].issues[0].priority = "critical"; },
    (b: ReturnType<typeof fixture>) => { b.columns[0].issues[0].lease = { state: "held" }; },
    (b: ReturnType<typeof fixture>) => { b.columns[0].issues[0].run = { status: "invented" }; },
    (b: ReturnType<typeof fixture>) => { b.token = "never-echo-this"; },
  ]) {
    const input = fixture(); edit(input);
    assert.throws(() => validateBoardFixture(input, ref), error => error instanceof Error && /schema/.test(error.message) && !error.message.includes("never-echo-this"));
  }
});

test("fixture relationships reject duplicate IDs, wrong columns, workflows and project targets", () => {
  for (const edit of [
    (b: ReturnType<typeof fixture>) => { b.columns[1].issues.push(b.columns[0].issues[0]); },
    (b: ReturnType<typeof fixture>) => { b.columns[1].state.id = b.columns[0].state.id; },
    (b: ReturnType<typeof fixture>) => { b.projects.push(b.projects[0]); },
    (b: ReturnType<typeof fixture>) => { b.columns[0].issues[0].stateId = b.columns[1].state.id; },
    (b: ReturnType<typeof fixture>) => { b.columns[0].issues[0].workflow = "content"; },
  ]) {
    const input = fixture(); edit(input);
    assert.throws(() => validateBoardFixture(input, ref));
  }
  assert.throws(() => validateBoardFixture(fixture(), "inferops://demo.local/project/board/OTHER"), /selected project/);
});

test("file boundary rejects linked, oversized and malformed fixtures; remote mode reads no fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-fixture-"));
  const config = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
  const path = join(root, "fixtures/project-board.json");
  try {
    writeFileSync(join(root, "inferos.config.json"), JSON.stringify(config));
    mkdirSync(join(root, "fixtures"));
    writeFileSync(path, JSON.stringify(fixture()));
    assert.equal(checkConsumerFixture(root).validated, true);
    writeFileSync(path, '{"private":"never-echo-this"');
    assert.throws(() => checkConsumerFixture(root), /not valid JSON/);
    writeFileSync(path, " ".repeat(1024 * 1024 + 1));
    assert.throws(() => checkConsumerFixture(root), /1 MiB/);
    rmSync(path); symlinkSync(new URL("./project-board.json", import.meta.url), path);
    assert.throws(() => checkConsumerFixture(root), /regular JSON/);
    rmSync(join(root, "fixtures"), { recursive: true });
    symlinkSync(root, join(root, "fixtures"));
    assert.throws(() => checkConsumerFixture(root), /regular directory/);
    writeFileSync(join(root, "inferos.config.json"), JSON.stringify({ ...config, inferops: { mode: "remote", baseUrl: "https://example.invalid", targetRef: ref } }));
    assert.deepEqual(checkConsumerFixture(root), { mode: "remote", validated: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
