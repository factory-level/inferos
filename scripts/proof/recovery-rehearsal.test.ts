// The recovery rehearsal's safety rails (recovery-rehearsal.ts, rehearsal-operator.ts): each is a
// refusal, so each test shows what it refuses and the one case that passes. Offline: nothing here
// starts a stack, a backend or a database.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adminUrlRefusal, databaseRefusal, envFileVariables, manifestDifferences, expectedDatabase, rehearsalRefusal, rehearse, serverRefusal, stateManifest, type RehearsalIo, type RunResult, type TargetFacts } from "./recovery-rehearsal.ts";
import { isLocalStackUrl, summarize } from "./rehearsal-summary.ts";

const ROOT = "/repo/inferOS";
const TARGET = `${ROOT}/.worktrees/rehearsal`;
const facts = (overrides: Partial<TargetFacts> = {}): TargetFacts => ({
  realPath: TARGET, repoRoot: ROOT, changes: "", adminUrl: "postgres://postgres:postgres@localhost:5432/postgres", stack: "not-running", backend: "not-running",
  env: { PATH: "/usr/bin", HOME: "/home/x" }, envFiles: { ".env": null, ".dev.vars": null, ".env.worktree": null }, ...overrides,
});

test("a clean, idle worktree under .worktrees/ in a clean shell passes", () => {
  assert.equal(rehearsalRefusal(TARGET, facts()), null);
});

test("the main checkout, a path outside .worktrees/, a nested path, a relative or missing path are refused", () => {
  assert.match(rehearsalRefusal(ROOT, facts({ realPath: ROOT }))!, /main checkout/);
  assert.match(rehearsalRefusal("/elsewhere/wt", facts({ realPath: "/elsewhere/wt" }))!, /not a worktree directly under/);
  assert.match(rehearsalRefusal(`${TARGET}/packages`, facts({ realPath: `${TARGET}/packages` }))!, /not a worktree directly under/);
  // A symlink into .worktrees/ is judged by where it really points.
  assert.match(rehearsalRefusal("/tmp/link", facts({ realPath: ROOT }))!, /main checkout/);
  assert.match(rehearsalRefusal("relative/wt", facts())!, /absolute path/);
  assert.match(rehearsalRefusal(TARGET, facts({ realPath: null }))!, /does not exist/);
});

test("uncommitted changes, an untracked file, or a git that fails, are refused", () => {
  assert.match(rehearsalRefusal(TARGET, facts({ changes: " M scripts/local/stack.ts" }))!, /uncommitted changes/);
  assert.match(rehearsalRefusal(TARGET, facts({ changes: "?? scripts/local/new-step.ts" }))!, /untracked files/);
  assert.match(rehearsalRefusal(TARGET, facts({ changes: null }))!, /git status failed/);
});

test("a Postgres admin URL that isn't localhost, or that overrides its host with host= or hostaddr=, is refused before anything starts", () => {
  const local = "postgres://postgres:postgres@localhost:5432/postgres";
  assert.equal(adminUrlRefusal(`${local}?sslmode=disable`), null);
  assert.match(rehearsalRefusal(TARGET, facts({ adminUrl: "postgres://u:pw@db.example.com/postgres" }))!, /only against localhost/);
  for (const query of ["?host=db.example.com", "?sslmode=disable&host=/cloudsql/p:r:i", "?HOST=10.0.0.5", "?hostaddr=10.0.0.5"]) {
    const refusal = rehearsalRefusal(TARGET, facts({ adminUrl: `${local}${query}` }))!;
    assert.match(refusal, /would override localhost/, query);
    assert.doesNotMatch(refusal, /postgres:postgres/, "never the URL, which may hold a password");
  }
  assert.match(adminUrlRefusal("not a url")!, /does not parse/);
});

test("a stack or a backend already running, or anyone else's on the port, is refused", () => {
  for (let stack of ["running", "port-in-use-by-other", "unknown"]) {
    assert.match(rehearsalRefusal(TARGET, facts({ stack }))!, /stop it first/, stack);
  }
  for (let backend of ["running", "starting", "port-in-use-by-other"]) {
    assert.match(rehearsalRefusal(TARGET, facts({ backend }))!, /inferops down first/, backend);
  }
});

test("a shell holding a cloud or model-provider credential is refused, by name only", () => {
  let refusal = rehearsalRefusal(TARGET, facts({ env: { CLOUDFLARE_API_TOKEN: "secret-value", ANTHROPIC_API_KEY: "sk-x" } }))!;
  assert.match(refusal, /CLOUDFLARE_API_TOKEN/);
  assert.match(refusal, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(refusal, /secret-value|sk-x/);
});

test("only localhost, and only this run's own inferos_<port> database", () => {
  let local = "postgres://postgres:postgres@localhost:5432/postgres";
  assert.equal(databaseRefusal(local, "inferos_8850", "inferos_8850"), null);
  assert.match(databaseRefusal("postgres://u:p@db.example.com/postgres", "inferos_8850", "inferos_8850")!, /only against localhost/);
  for (let name of ["inferlab", "inferlab_126", "inferos_8850; DROP DATABASE inferlab", "postgres"]) {
    assert.match(databaseRefusal(local, name, "inferos_8850")!, /only a backend's own/, name);
  }
  assert.match(databaseRefusal(local, "inferos_8860", "inferos_8850")!, /this run's backend uses inferos_8850/);
  assert.match(databaseRefusal("not a url", "inferos_8850", "inferos_8850")!, /does not parse/);
});

test("the state manifest hashes every file, so one changed byte or a missing file is a difference", () => {
  let dir = mkdtempSync(join(tmpdir(), "rehearsal-manifest-"));
  mkdirSync(join(dir, "v3", "do"), { recursive: true });
  writeFileSync(join(dir, "v3", "do", "a.sqlite"), "one");
  writeFileSync(join(dir, "v3", "kv"), "two");
  let before = stateManifest(dir);
  assert.deepEqual(Object.keys(before), ["v3/do/a.sqlite", "v3/kv"]);
  assert.deepEqual(manifestDifferences(before, stateManifest(dir)), []);
  writeFileSync(join(dir, "v3", "kv"), "twO");
  assert.deepEqual(manifestDifferences(before, stateManifest(dir)), ["v3/kv"]);
  assert.deepEqual(manifestDifferences(before, {}), ["v3/do/a.sqlite", "v3/kv"]);
  assert.deepEqual(stateManifest(join(dir, "absent")), {});
});

test("the operator signs in only to a local stack, and reports an action's code, never its message", () => {
  assert.equal(isLocalStackUrl("http://localhost:8850"), true);
  assert.equal(isLocalStackUrl("http://127.0.0.1:8850"), true);
  assert.equal(isLocalStackUrl("https://dev-os.example.com"), false);
  assert.equal(isLocalStackUrl("nonsense"), false);
  assert.deepEqual(summarize({ id: 4, state: "failed", type: "action", lastAttempt: { outcome: "notApplied", code: "STALE_REVISION" } }),
    { id: 4, state: "failed", type: "action", failure: "STALE_REVISION" });
  assert.deepEqual(summarize({ id: 5, state: "pending", type: "action" }), { id: 5, state: "pending", type: "action" });
});

test("a credential set in the target's .env, .dev.vars or .env.worktree is refused, naming the file, never the value", () => {
  for (const file of [".env", ".dev.vars", ".env.worktree"]) {
    for (const line of ["ANTHROPIC_API_KEY=sk-ant-secret-value", "export CLOUDFLARE_API_TOKEN='tok-secret'"]) {
      const refusal = rehearsalRefusal(TARGET, facts({ envFiles: { ".env": null, ".dev.vars": null, ".env.worktree": null, [file]: `# local\n${line}\n` } }));
      assert.match(refusal!, new RegExp(`${file.replace(".", "\\.")} sets`), `${file}: ${line}`);
      assert.doesNotMatch(refusal!, /secret/);
    }
  }
  // Ports, an empty value and a comment name no credential.
  const harmless = "VITE_PORT=9150\nBACKEND_PORT=9151\nANTHROPIC_API_KEY=\n# ANTHROPIC_API_KEY=sk-ant-x\n";
  assert.equal(rehearsalRefusal(TARGET, facts({ envFiles: { ".env": harmless, ".dev.vars": null, ".env.worktree": harmless } })), null);
  assert.deepEqual(envFileVariables("export A=1\nB = 'two'\n#C=3\n"), { A: "1", B: "two" });
});

// rehearse() with a spy for every command: a refusal runs only the guards' reads.
const READS = ["pnpm -s local status --json", "pnpm -s local inferops status --json", "git status --porcelain"];
const WRITES = /inferops up|local start|local stop|inferops down|local seed|local reset|pg_dump|pg_restore|psql|tar |rehearsal-operator/;

/** A real, empty worktree directory under a fake repository root, so the path guards pass. */
function worktree(): { repoRoot: string; target: string } {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "rehearsal-repo-")));
  const target = join(repoRoot, ".worktrees", "rehearsal");
  mkdirSync(target, { recursive: true });
  return { repoRoot, target };
}

/** An io whose commands are recorded and answered from `answers` (by command line), otherwise idle and clean. */
const COMPOSE_ID = "7666333140302553138";

type SpyOver = {
  env?: Record<string, string>; answers?: Record<string, Partial<RunResult>>;
  server?: string | null; compose?: string | null; worktreeEnv?: string;
};

function spyIo(over: SpyOver = {}) {
  const commands: string[] = [];
  /** The identity reads, in order: the only database contact allowed before the guards pass. */
  const identities: string[] = [];
  const { repoRoot, target } = worktree();
  if (over.worktreeEnv !== undefined) writeFileSync(join(target, ".env.worktree"), over.worktreeEnv);
  const answers: Record<string, Partial<RunResult>> = {
    "pnpm -s local status --json": { stdout: '{"stack":"not-running"}' },
    "pnpm -s local inferops status --json": { stdout: '{"backend":"not-running"}' },
    "git status --porcelain": { stdout: "" },
    ...over.answers,
  };
  const io: RehearsalIo = {
    target, repoRoot, work: mkdtempSync(join(tmpdir(), "rehearsal-work-")),
    env: { PATH: "/usr/bin", HOME: "/home/x", ...over.env },
    run: argv => {
      const line = argv.join(" ");
      commands.push(line);
      return { code: 0, stdout: "", stderr: "", ...answers[line] };
    },
    spawnDetached: argv => { commands.push(argv.join(" ")); },
    wait: async () => {},
    serverIdentity: () => { identities.push("server"); return over.server === undefined ? COMPOSE_ID : over.server; },
    composeIdentity: () => { identities.push("compose"); return over.compose === undefined ? COMPOSE_ID : over.compose; },
  };
  return { io, commands, identities };
}

const refusals: [string, SpyOver, RegExp][] = [
  ["a localhost tunnel to another server (another system_identifier)", { server: "7399112233445566778" }, /not the local Compose Postgres/],
  ["a server whose identity can't be read", { server: null }, /could not be read over the admin URL/],
  ["no Compose Postgres container to compare with", { compose: null }, /container running/],
  ["an untracked file", { answers: { "git status --porcelain": { stdout: "?? notes.txt\n" } } }, /untracked files/],
  ["a git status that fails", { answers: { "git status --porcelain": { code: 128 } } }, /git status failed/],
  ["a non-local Postgres admin URL", { env: { INFEROPS_PG_ADMIN_URL: "postgres://u:pw@db.example.com/postgres" } }, /only against localhost/],
  ["a host= override on a localhost URL", { env: { INFEROPS_PG_ADMIN_URL: "postgres://postgres:postgres@localhost/postgres?host=db.example.com" } }, /override localhost/],
  ["a stack already running", { answers: { "pnpm -s local status --json": { stdout: '{"stack":"running"}' } } }, /stop it first/],
  ["a credential in the shell", { env: { CLOUDFLARE_API_TOKEN: "tok" } }, /CLOUDFLARE_API_TOKEN/],
];
for (const [why, over, reason] of refusals) {
  test(`${why}: refused, and no command but the guards' reads runs (no up, start, stop, seed, pg_dump, restore)`, async () => {
    const { io, commands } = spyIo(over);
    const report = await rehearse(io);
    assert.equal(report.ok, false);
    assert.match(String(report.failure), reason);
    assert.deepEqual(commands.filter(c => !READS.includes(c)), [], commands.join("\n"));
    assert.deepEqual((report.stopped as { startedStack: boolean; startedBackend: boolean }), { stack: "not started", backend: "not started", startedStack: false, startedBackend: false, bothStopped: true });
  });
}

test("when the guards pass, the first command that could touch a database is inferops up, after every read", async () => {
  const { io, commands } = spyIo({ answers: { "pnpm -s local inferops up --json": { code: 1, stdout: '{"ok":false}' } } });
  const report = await rehearse(io);
  assert.equal(report.ok, false);
  const first = commands.findIndex(c => WRITES.test(c));
  assert.equal(commands[first], "pnpm -s local inferops up --json");
  for (const read of READS) assert.ok(commands.indexOf(read) < first, read);
});

test("a backend that reports any database but its own inferos_<port> is refused right after up: nothing reads or writes it", async () => {
  const { io, commands } = spyIo({ answers: { "pnpm -s local inferops up --json": { stdout: '{"ok":true,"database":"inferlab"}' } } });
  const report = await rehearse(io);
  assert.match(String(report.failure), /only a backend's own/);
  const after = commands.slice(commands.indexOf("pnpm -s local inferops up --json") + 1);
  assert.deepEqual(after.filter(c => /local start|seed|pg_dump|pg_restore|psql|tar /.test(c)), [], after.join("\n"));
  assert.ok(after.includes("pnpm -s local inferops down"), "it stops the backend it started");
});

test("the server must be the local Compose Postgres, by system_identifier, read on both sides", () => {
  assert.equal(serverRefusal(COMPOSE_ID, COMPOSE_ID), null);
  assert.match(serverRefusal("7399112233445566778", COMPOSE_ID)!, /tunnel or proxy/);
  assert.match(serverRefusal(null, COMPOSE_ID)!, /could not be read/);
  assert.match(serverRefusal(COMPOSE_ID, null)!, /container running/);
});

test("a refusal before connecting never reads the server: no identity query on a non-local or overridden URL", async () => {
  for (const url of ["postgres://u:pw@db.example.com/postgres", "postgres://postgres:postgres@localhost/postgres?host=db.example.com"]) {
    const { io, identities } = spyIo({ env: { INFEROPS_PG_ADMIN_URL: url } });
    await rehearse(io);
    assert.deepEqual(identities, [], url);
  }
});

test("the expected database is the checkout's own inferos_<port>, from its port rules, never what up reports", async () => {
  const { target } = worktree();
  assert.equal(expectedDatabase(target, {}), "inferos_8787");
  writeFileSync(join(target, ".env.worktree"), "VITE_BACKEND_HOST=localhost:8850\n");
  assert.equal(expectedDatabase(target, {}), "inferos_8850");
  assert.equal(expectedDatabase(target, { VITE_BACKEND_HOST: "localhost:8860" }), "inferos_8860", "the shell wins, as for the stack");

  // up reports another stack's well-formed database: refused right after up, nothing reads or writes it.
  const { io, commands } = spyIo({ worktreeEnv: "VITE_BACKEND_HOST=localhost:8850\n",
    answers: { "pnpm -s local inferops up --json": { stdout: '{"ok":true,"database":"inferos_8860"}' } } });
  const report = await rehearse(io);
  assert.match(String(report.failure), /this run's backend uses inferos_8850/);
  const after = commands.slice(commands.indexOf("pnpm -s local inferops up --json") + 1);
  assert.deepEqual(after.filter(c => /local start|seed|pg_dump|pg_restore|psql|tar /.test(c)), [], after.join("\n"));
});

test("the identity check runs before up, and up before anything else that touches a database", async () => {
  const { io, commands, identities } = spyIo({ answers: { "pnpm -s local inferops up --json": { code: 1, stdout: '{"ok":false}' } } });
  await rehearse(io);
  assert.deepEqual(identities, ["server", "compose"]);
  assert.equal(commands.find(c => WRITES.test(c)), "pnpm -s local inferops up --json");
});
