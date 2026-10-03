// Test fixtures for the coding runner commands: a throwaway git repository, a wrapper whose
// inferos.config.json allowlists it, and the MOCK `inferops` and `codex` binaries beside this file.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialConsumerConfig } from "../../consumer/config.ts";

/** The MOCK InferOps CLI (`runner codex` patch mode only). */
export const STUB_CLI = join(import.meta.dirname, "stub-inferops-cli.ts");
/** The MOCK Codex CLI. */
export const STUB_CODEX = join(import.meta.dirname, "stub-codex.ts");

/** A repository id the wrapper allowlists. */
export const REPO_ID = "5e000000-0000-4000-8000-000000000001";
/** A workspace id the runner settings name. */
export const WORKSPACE_ID = "9a000000-0000-4000-8000-000000000001";

/** A git repository with one commit on `main` and a test script the runner can execute. */
export function makeGitRepo(parent: string): string {
  const repo = join(parent, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  // Passes once the (stub) agent's change is in the checkout, so the evidence depends on the patch.
  writeFileSync(join(repo, "check.mjs"), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('STUB_CHANGE.md') ? 0 : 1);\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "init");
  return repo;
}

/** Options for {@link makeCodingWrapper}. */
export interface WrapperOptions {
  /** CODING_WORKBENCH_ENABLED in the wrapper (INFEROPS_ENABLED is always on). */
  enabled?: boolean;
  /** Repositories to allowlist; defaults to one fresh git repository. */
  repos?: { repoId: string; path: string; testCommands: string[]; baseRef?: string }[];
  /** Lines for the wrapper's `.dev.vars`; defaults name the MOCK binaries and a fake endpoint. */
  devVars?: Record<string, string>;
  /** Contents of `$CODEX_HOME/stub.json` for the MOCK Codex. */
  codex?: { auth?: string; turn?: string };
}

/** A temporary wrapper configured for the runner, with its git repository and Codex home. */
export function makeCodingWrapper(options: WrapperOptions = {}) {
  const parent = mkdtempSync(join(tmpdir(), "inferos-coding-"));
  const root = join(parent, "wrapper");
  mkdirSync(root);
  const repo = makeGitRepo(parent);
  const codexHome = join(parent, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "stub.json"), JSON.stringify(options.codex ?? {}));
  const capabilities = options.enabled === false ? ["INFEROPS_ENABLED"] as const : ["INFEROPS_ENABLED", "CODING_WORKBENCH_ENABLED"] as const;
  const config = {
    ...initialConsumerConfig("https://github.com/factory-level/inferos.git", "0".repeat(40), { capabilities }),
    codingWorkbench: { repos: options.repos ?? [{ repoId: REPO_ID, path: repo, testCommands: ["node check.mjs"], baseRef: "main" }] },
  };
  writeFileSync(join(root, "inferos.config.json"), JSON.stringify(config, null, 2));
  const devVars = {
    INFEROPS_CLI: STUB_CLI, CODEX_PATH: STUB_CODEX, CODEX_HOME: codexHome,
    INFEROPS_ENDPOINT: "http://127.0.0.1:9", INFEROPS_WORKSPACE_ID: WORKSPACE_ID,
    INFEROPS_API_KEY: "iops_sk_supersecretvalue123", ...options.devVars,
  };
  writeFileSync(join(root, ".dev.vars"), Object.entries(devVars).map(([name, value]) => `${name}=${value}`).join("\n") + "\n");
  return { parent, root, repo, codexHome, apiKey: devVars.INFEROPS_API_KEY };
}
