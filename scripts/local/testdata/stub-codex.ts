#!/usr/bin/env node
// MOCK. A stand-in for the `codex` CLI in tests: it is not Codex, it signs nothing in and calls no
// model. Its behaviour comes from `$CODEX_HOME/stub.json` (CODEX_HOME is the one place the real
// runner lets a Codex child read its state from):
//
//   { "auth": "chatgpt" | "api-key" | "none", "turn": "edit" | "quota" | "auth" }
//
//   codex --version          prints a version
//   codex login status       reports the sign-in mode, on stderr like Codex does
//   codex exec --json PROMPT "edit": writes STUB_CHANGE.md in the cwd and prints a thread id;
//                            "quota"/"auth": fails with Codex's wording for a blocked plan or login
//
// Every invocation also records the environment variable NAMES it saw in `$CODEX_HOME/stub-env.json`,
// so a test can prove what reached the coding child. Values are never written.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? ".", ".codex");
const settings: { auth?: string; turn?: string } = existsSync(join(home, "stub.json"))
  ? JSON.parse(readFileSync(join(home, "stub.json"), "utf8")) : {};
if (existsSync(home)) writeFileSync(join(home, "stub-env.json"), JSON.stringify(Object.keys(process.env).toSorted()));

const [command, ...args] = process.argv.slice(2);
if (command === "--version") {
  console.log("codex-cli 0.160.0-stub");
} else if (command === "login" && args[0] === "status") {
  const auth = settings.auth ?? "chatgpt";
  if (auth === "chatgpt") console.error("Logged in using ChatGPT");
  else if (auth === "api-key") console.error("Logged in using an API key - sk-proj-***");
  else {
    console.error("Not logged in");
    process.exitCode = 1;
  }
} else if (command === "exec") {
  const turn = settings.turn ?? "edit";
  if (turn === "quota") {
    console.error("ERROR: You've hit your usage limit. Upgrade to Pro or try again later.");
    process.exitCode = 1;
  } else if (turn === "auth") {
    console.error("ERROR: Your access token could not be refreshed. Please sign in again.");
    process.exitCode = 1;
  } else {
    const prompt = args.at(-1) ?? "";
    writeFileSync("STUB_CHANGE.md", `# Stub change\n\n${prompt.split("\n")[0]}\n`);
    console.log(JSON.stringify({ type: "thread.started", thread_id: `stub-thread-${process.pid}` }));
    console.log(JSON.stringify({ type: "turn.completed" }));
  }
} else {
  console.error(`stub codex: unsupported ${command}`);
  process.exitCode = 2;
}
