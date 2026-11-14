#!/usr/bin/env node
/**
 * Copies the InferLab cross-product contracts (InferOps `lib/ts/contracts`, FAC-216) into this tree
 * at one pinned InferOps commit, and checks the copy. The schemas and fixtures here are InferOps'
 * bytes, never edited by hand: `pin.json` records the commit and a SHA-256 of every file, and the
 * consumer test fails on any file that doesn't match it.
 *
 * It reads the commit through `git show`, so the InferOps checkout's own working tree doesn't
 * matter, and it never runs InferOps code.
 *
 * Usage (from the repository root):
 *   node scripts/inferlab-contracts/sync.ts <inferops checkout> <full 40-character sha>
 *   node scripts/inferlab-contracts/sync.ts <inferops checkout> <sha> --check
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = "lib/ts/contracts";
const DIRS = ["schemas", "fixtures"] as const;

export type Pin = {
  inferops: { repository: string; revision: string; path: string };
  files: Record<string, string>;
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every contract file at `revision`, as `[relative path, contents]`, sorted. */
export function readAtRevision(checkout: string, revision: string): [string, string][] {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("the revision must be a full 40-character sha");
  const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  const files: [string, string][] = [];
  for (const dir of DIRS) {
    const names = git("ls-tree", "--name-only", `${revision}:${SOURCE}/${dir}`).split("\n").filter(Boolean);
    for (const name of names) files.push([`${dir}/${name}`, git("show", `${revision}:${SOURCE}/${dir}/${name}`)]);
  }
  return files.toSorted(([a], [b]) => a.localeCompare(b));
}

/** The pin for a set of files. */
export const pinFor = (revision: string, files: [string, string][]): Pin => ({
  inferops: { repository: "factory-level/inferops", revision, path: SOURCE },
  files: Object.fromEntries(files.map(([name, text]) => [name, sha256(text)])),
});

/** `pin.json`'s exact text for a pin. */
export const pinText = (pin: Pin) => `${JSON.stringify(pin, null, 2)}\n`;

/** Every contract file on disk here, as `[relative path, contents]`, sorted. */
export function readLocal(root = HERE): [string, string][] {
  const files: [string, string][] = [];
  for (const dir of DIRS) {
    for (const name of readdirSync(join(root, dir)).toSorted()) {
      files.push([`${dir}/${name}`, readFileSync(join(root, dir, name), "utf8")]);
    }
  }
  return files.toSorted(([a], [b]) => a.localeCompare(b));
}

/** What differs between the copy on disk and its pin; empty when they agree. */
export function pinProblems(pin: Pin, files: [string, string][]): string[] {
  const problems: string[] = [];
  const onDisk = new Map(files);
  for (const name of Object.keys(pin.files)) if (!onDisk.has(name)) problems.push(`${name}: missing`);
  for (const [name, text] of files) {
    const want = pin.files[name];
    if (want === undefined) problems.push(`${name}: not in pin.json`);
    else if (want !== sha256(text)) problems.push(`${name}: edited by hand (hash differs from pin.json)`);
  }
  return problems;
}

function main(argv: string[]) {
  const [checkout, revision, flag] = argv;
  if (!checkout || !revision) {
    console.error("usage: node scripts/inferlab-contracts/sync.ts <inferops checkout> <sha> [--check]");
    process.exit(2);
  }
  const files = readAtRevision(checkout, revision);
  const pin = pinFor(revision, files);
  if (flag === "--check") {
    const local = readLocal();
    const problems = [
      ...pinProblems(pin, local),
      ...(pinText(pin) === readFileSync(join(HERE, "pin.json"), "utf8") ? [] : ["pin.json: differs"]),
    ];
    if (problems.length) {
      console.error(`contracts differ from inferops ${revision}:\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`contracts match inferops ${revision} (${files.length} files)`);
    return;
  }
  for (const dir of DIRS) {
    rmSync(join(HERE, dir), { recursive: true, force: true });
    mkdirSync(join(HERE, dir), { recursive: true });
  }
  for (const [name, text] of files) writeFileSync(join(HERE, name), text);
  writeFileSync(join(HERE, "pin.json"), pinText(pin));
  console.log(`copied ${files.length} files from inferops ${revision}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
