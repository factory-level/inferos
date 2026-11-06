// FAC-162: the local storage export runs in its own process group under a deadline, so a hung
// Wrangler bundle or workerd start can't hold a heavy-run slot: on timeout the whole group, the
// grandchildren included, is killed and the command fails.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runInProcessGroup } from "./process-group.ts";

const scratch = mkdtempSync(join(tmpdir(), "inferos-fac162-group-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return condition();
}

test("a hung start is killed, grandchildren and all, within its deadline", async () => {
  const pids = join(scratch, "pids.json");
  // A child that starts a grandchild (as wrangler starts esbuild, or Miniflare starts workerd), then
  // both hang, ignoring SIGTERM.
  const hung = join(scratch, "hung.mjs");
  writeFileSync(hung, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);
  `);
  const started = Date.now();
  const result = await runInProcessGroup(process.execPath, [hung], { timeoutMs: 1500, label: "hung start" });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.match(result.message ?? "", /hung start did not finish within 1500ms; its process group was killed/);
  assert.ok(elapsed < 1500 + 3000, `returned after ${elapsed}ms`);
  const { child, grandchild } = JSON.parse(readFileSync(pids, "utf8")) as { child: number; grandchild: number };
  assert.ok(await until(() => !alive(child) && !alive(grandchild), 3000), "the child and grandchild are gone");
});

test("a command that finishes in time reports its own exit code and isn't killed", async () => {
  const ok = await runInProcessGroup(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 10_000, label: "quick" });
  assert.deepEqual(ok, { timedOut: false, code: 0 });
  const failed = await runInProcessGroup(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 10_000, label: "failing" });
  assert.deepEqual(failed, { timedOut: false, code: 3 });
});

test("the deadline must be a positive bound", async () => {
  await assert.rejects(runInProcessGroup(process.execPath, ["-e", ""], { timeoutMs: 0, label: "x" }), /positive/);
});

test("a child whose parent is killed outright ends its own group", async () => {
  const pids = join(scratch, "orphan-pids.json");
  const groupModule = JSON.stringify(new URL("./process-group.ts", import.meta.url).href);
  const child = join(scratch, "orphan-child.mjs");
  writeFileSync(child, `
    import { stopWithParent } from ${groupModule};
    import { writeFileSync } from "node:fs";
    stopWithParent(100);
    writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ child: process.pid }));
    setInterval(() => {}, 1000);
  `);
  const parent = join(scratch, "orphan-parent.mjs");
  writeFileSync(parent, `
    import { runInProcessGroup } from ${groupModule};
    await runInProcessGroup(process.execPath, [${JSON.stringify(child)}], { timeoutMs: 60_000, label: "orphan" });
  `);
  const { spawn } = await import("node:child_process");
  const runner = spawn(process.execPath, [parent], { stdio: "ignore" });
  assert.ok(await until(() => { try { readFileSync(pids); return true; } catch { return false; } }, 10_000), "the child started");
  const { child: childPid } = JSON.parse(readFileSync(pids, "utf8")) as { child: number };
  runner.kill("SIGKILL");
  assert.ok(await until(() => !alive(childPid), 5000), "the orphaned child ended itself");
});
