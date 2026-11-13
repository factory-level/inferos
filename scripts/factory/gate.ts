// Record one factory gate: run a command without a shell and write its real exit code beside its
// output, so a verifier reads exit codes rather than an agent's summary.
//
//   node scripts/factory/gate.ts <stage-dir> [--name <gate>] -- <command> [args...]
//
// Writes `<stage-dir>/<gate>.json` ({command, exitCode, startedAt, durationMs}) and
// `<stage-dir>/<gate>.log`, and exits with the command's exit code. The InferOps twin is
// inferops/scripts/factory/gate.ts (bun); each repo keeps its own so toolchains never mix.
//
// ponytail: output is buffered, and there is no timeout. Upgrade path: stream it and wrap the
// command in scripts/with-timeout.ts.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Runs the gate described by `argv` and returns the command's exit code (2 on a usage error). */
export function main(argv: string[]): number {
  const sep = argv.indexOf("--");
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const dir = head[0];
  const nameAt = head.indexOf("--name");
  const name = nameAt >= 0 ? head[nameAt + 1] : "gate";
  const [program, ...rest] = command;
  if (!dir || !name || !program) {
    console.error("usage: gate.ts <stage-dir> [--name <gate>] -- <command> [args...]");
    return 2;
  }
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const r = spawnSync(program, rest, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const durationMs = Math.round(performance.now() - t0);
  const exitCode = r.status ?? 1;
  writeFileSync(join(dir, `${name}.log`), `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}${r.error ? `\n${String(r.error)}` : ""}`);
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ command, exitCode, startedAt, durationMs }, null, 2)}\n`);
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  console.error(`[gate ${name}] exit ${exitCode} in ${durationMs}ms -> ${dir}`);
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
