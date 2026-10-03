import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initialConsumerConfig, parseConsumerConfig, type CapabilityName, type ConsumerConfig } from "./config.ts";
import { diagnoseSettings } from "./runtime.ts";
import {
  DOC_BEGIN, DOC_END, REFERENCE_DOC, SETTINGS, renderSettingsTable, replaceGeneratedSection, settingsDiagnostic, validateSettings,
} from "./settings.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const v1 = () => initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
const v2 = (capabilities: CapabilityName[]): ConsumerConfig =>
  initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40), { capabilities });
// Bypasses the parser so the coding rows can be exercised whether or not this pin parses `codingWorkbench`.
const withRepos = (config: ConsumerConfig, repos: unknown[]): ConsumerConfig => Object.assign(structuredClone(config), { codingWorkbench: { repos } });

const REPO_ID = "0b6f7a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET = "iex_dev_sre_SECRET_VALUE_0001";
const codingEnv = { INFEROPS_CLI: "/opt/inferops/bin/inferops", INFEROPS_API_KEY: SECRET };

const codes = (result: ReturnType<typeof validateSettings>) => result.findings.map(finding => `${finding.setting}:${finding.code}`);

test("the default wrapper needs nothing beyond its configuration", () => {
  const result = validateSettings(v1(), {});
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.filter(setting => setting.required).map(setting => setting.name),
    ["inferops.targetRef", "inferops.mode", "local.port", "upstream.revision"]);
  assert.equal(settingsDiagnostic(result).status, "pass");
});

test("required-when follows sign-in, the stopgap token, custom code and coding", () => {
  const signIn = validateSettings(v2(["INFEROPS_ENABLED", "INFEROPS_AUTH"]), {});
  assert.deepEqual(codes(signIn), ["INFERLAB_AUTH_ORIGIN:missing"]);
  assert.equal(validateSettings(v2(["INFEROPS_ENABLED", "INFEROPS_AUTH"]), { INFERLAB_AUTH_ORIGIN: "http://localhost:8080" }).ok, true);

  const token = validateSettings(v1(), { INFEROPS_API_TOKEN: SECRET });
  assert.deepEqual(codes(token).toSorted(), ["INFEROPS_BASE_URL:missing", "INFEROPS_WORKSPACE_ID:missing", "INFEROPS_WORKSPACE_SLUG:missing"]);

  const custom = validateSettings(parseConsumerConfig({ ...v1(), features: { customCloudflareCode: true } }), {});
  assert.equal(custom.settings.find(setting => setting.name === "inferos.extensions.json")?.required, true);
  // Doctor's extensions check validates the manifest itself, so an unchecked row is not a finding here.
  assert.equal(custom.ok, true);

  const coding = validateSettings(withRepos(v2(["INFEROPS_ENABLED", "CODING_WORKBENCH_ENABLED"]), []), {});
  assert.deepEqual(codes(coding).toSorted(), [
    "INFEROPS_API_KEY:missing", "INFEROPS_CLI:missing", "codex login:unchecked", "codingWorkbench.repos:missing",
  ]);
  const ready = validateSettings(withRepos(v2(["INFEROPS_ENABLED", "CODING_WORKBENCH_ENABLED"]), [{ repoId: REPO_ID, path: "/src/app", testCommands: ["pnpm test"] }]), codingEnv);
  assert.equal(ready.ok, true);
  assert.deepEqual(codes(ready), ["codex login:unchecked"]);
  assert.equal(settingsDiagnostic(ready).status, "warning");
  // A version 1 wrapper takes coding from the shell, as the dev server does.
  assert.deepEqual(codes(validateSettings(v1(), { CODING_WORKBENCH_ENABLED: "true", CODING_WORKBENCH_REPOS: REPO_ID, ...codingEnv })), ["codex login:unchecked"]);
});

test("contradictions are errors, and shell values a version 2 wrapper overrides are warnings", () => {
  // Sign-in is listed in the shell, but nothing tells the gatekeeper where InferLab is.
  assert.deepEqual(codes(validateSettings(v1(), { AUTH_GATEKEEPERS: "inferops" })), ["AUTH_GATEKEEPERS:contradictory"]);
  assert.deepEqual(codes(validateSettings(v1(), { DISABLE_PASSWORD_AUTH: "true" })), ["AUTH_GATEKEEPERS:missing"]);
  assert.deepEqual(codes(validateSettings(v2(["INFEROPS_ENABLED", "INFEROPS_AUTH"]), { INFERLAB_AUTH_ORIGIN: "http://localhost:8080" }, { inferOpsGatekeeperSelected: false })),
    ["AUTH_GATEKEEPERS:contradictory", "INFEROPS_ENABLED:contradictory"]);
  assert.deepEqual(codes(validateSettings(v1(), { INFEROPS_ENABLED: "yes" })), ["INFEROPS_ENABLED:contradictory"]);

  // Coding without the integration, in either spelling.
  const offV1 = validateSettings(v1(), { INFEROPS_ENABLED: "false", CODING_WORKBENCH_ENABLED: "true", CODING_WORKBENCH_REPOS: REPO_ID, ...codingEnv });
  assert.ok(codes(offV1).includes("CODING_WORKBENCH_ENABLED:contradictory"));
  assert.equal(offV1.ok, false);
  // Version 2 parsing refuses this once coding has a dependency; built directly so this pin checks it too.
  const codingOff = v2(["INFEROPS_ENABLED"]);
  if (codingOff.schemaVersion === 2) codingOff.capabilities = { ...codingOff.capabilities, INFEROPS_ENABLED: false, CODING_WORKBENCH_ENABLED: true };
  const offV2 = validateSettings(withRepos(codingOff, [{ repoId: REPO_ID }]), codingEnv);
  assert.ok(codes(offV2).includes("CODING_WORKBENCH_ENABLED:contradictory"));

  assert.ok(codes(validateSettings(v1(), { CODING_WORKBENCH_ENABLED: "true", CODING_WORKBENCH_REPOS: "not-a-uuid", ...codingEnv }))
    .includes("codingWorkbench.repos:missing"));
  assert.ok(codes(validateSettings(v1(), { CODING_WORKBENCH_ENABLED: "true", CODING_WORKBENCH_REPOS: `${REPO_ID},x`, ...codingEnv }))
    .includes("codingWorkbench.repos:invalid"));
  assert.ok(codes(validateSettings(v1(), { CODING_WORKBENCH_ENABLED: "true", CODING_WORKBENCH_REPOS: REPO_ID, ...codingEnv, INFEROPS_CLI: "bin/inferops" }))
    .includes("INFEROPS_CLI:invalid"));
  assert.deepEqual(codes(validateSettings(v1(), { CODING_WORKBENCH_ENABLED: "maybe" })), ["CODING_WORKBENCH_ENABLED:invalid"]);

  const overridden = validateSettings(v2(["INFEROPS_ENABLED"]), { INFEROPS_ENABLED: "false", CODING_WORKBENCH_ENABLED: "true", CODING_WORKBENCH_REPOS: REPO_ID });
  assert.deepEqual(codes(overridden), ["INFEROPS_ENABLED:contradictory", "CODING_WORKBENCH_ENABLED:contradictory", "codingWorkbench.repos:contradictory"]);
  assert.equal(overridden.ok, true);

  const slug = validateSettings(v1(), { INFEROPS_API_TOKEN: SECRET, INFEROPS_BASE_URL: "http://localhost:8080", INFEROPS_WORKSPACE_ID: "w1", INFEROPS_WORKSPACE_SLUG: "acme" });
  assert.deepEqual(codes(slug), ["INFEROPS_WORKSPACE_SLUG:contradictory"]);
});

test("credentialed and malformed URLs are rejected", () => {
  assert.deepEqual(codes(validateSettings(v1(), { INFERLAB_AUTH_ORIGIN: "https://user:pw@auth.example.com" })), ["INFERLAB_AUTH_ORIGIN:credentialed"]);
  assert.deepEqual(codes(validateSettings(v1(), { INFERLAB_AUTH_ORIGIN: "http://auth.example.com" })), ["INFERLAB_AUTH_ORIGIN:invalid"]);
  assert.deepEqual(codes(validateSettings(v1(), { INFEROPS_BASE_URL: "https://user:pw@api.example.com/v1" })), ["INFEROPS_BASE_URL:credentialed"]);
  assert.deepEqual(codes(validateSettings(v1(), { INFEROPS_BASE_URL: "ftp://api.example.com" })), ["INFEROPS_BASE_URL:invalid"]);
});

test("unsupported settings and remote mode are reported", () => {
  const result = validateSettings(v1(), {});
  assert.deepEqual(result.settings.filter(setting => setting.state === "unsupported").map(setting => setting.name), ["Wiki binding", "Cloud deployment target"]);
  assert.match(settingsDiagnostic(result).message, /not supported yet: Wiki binding, Cloud deployment target/);
  const remote = validateSettings(parseConsumerConfig({ ...v1(), inferops: { mode: "remote", baseUrl: "https://api.example.com", targetRef: "inferops://acme.ops/project/board/ENG" } }), {});
  assert.deepEqual(codes(remote), ["inferops.mode:unsupported"]);
  assert.equal(settingsDiagnostic(remote).status, "error");
});

test("no output ever carries a value, and secrets are reported by presence only", () => {
  const leaks = [SECRET, "s3cr3t-pw", "/opt/inferops/bin/inferops", "auth.example.com", "api.example.com", "acme-slug"];
  const envs = [
    { INFEROPS_API_TOKEN: SECRET, INFEROPS_API_KEY: SECRET, INFEROPS_CLI: "/opt/inferops/bin/inferops" },
    { INFERLAB_AUTH_ORIGIN: "https://admin:s3cr3t-pw@auth.example.com", INFEROPS_BASE_URL: "https://admin:s3cr3t-pw@api.example.com", INFEROPS_API_TOKEN: SECRET, INFEROPS_WORKSPACE_SLUG: "acme-slug" },
    { CODING_WORKBENCH_ENABLED: "true", INFEROPS_ENABLED: "false", INFEROPS_API_KEY: SECRET, INFEROPS_CLI: "relative/opt/inferops/bin/inferops", AUTH_GATEKEEPERS: "inferops" },
  ];
  for (const env of envs) {
    for (const config of [v1(), v2(["INFEROPS_ENABLED", "INFEROPS_AUTH"])]) {
      const result = validateSettings(config, env);
      const output = JSON.stringify(result) + JSON.stringify(settingsDiagnostic(result));
      for (const value of leaks) assert.ok(!output.includes(value), `output leaks ${value}`);
      for (const state of result.settings) assert.deepEqual(Object.keys(state).toSorted(), ["kind", "name", "required", "state"]);
    }
  }
  const secrets = SETTINGS.filter(entry => entry.kind === "secret").map(entry => entry.name);
  assert.deepEqual(secrets, ["INFEROPS_API_TOKEN", "INFEROPS_API_KEY", "codex login"]);
});

test("every row is complete and the generated reference has not drifted", () => {
  for (const entry of SETTINGS) {
    assert.ok(entry.description && entry.readAt && entry.requiredWhen.text, entry.name);
    assert.ok(["local", "cloud", "both"].includes(entry.source), entry.name);
  }
  assert.equal(new Set(SETTINGS.map(entry => entry.name)).size, SETTINGS.length);
  const committed = readFileSync(REFERENCE_DOC, "utf8");
  assert.equal(replaceGeneratedSection(committed, renderSettingsTable()), committed,
    "docs/wiki/configuration-reference.md is out of date; run node scripts/consumer/settings.ts");
  const check = spawnSync(process.execPath, [join(REPO, "scripts/consumer/settings.ts"), "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  // A changed row is drift.
  const edited = renderSettingsTable(SETTINGS.map(entry => entry.name === "local.port" ? { ...entry, default: "`9000`" } : entry));
  assert.notEqual(replaceGeneratedSection(committed, edited), committed);
  assert.throws(() => replaceGeneratedSection("no markers", renderSettingsTable()), /markers/);
  assert.ok(committed.includes(DOC_BEGIN) && committed.includes(DOC_END));
});

test("doctor's settings check runs the pinned table and fails only on errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-settings-"));
  try {
    const bare = join(root, "bare-pin");
    mkdirSync(bare);
    const missing = await diagnoseSettings(root, bare, v1(), {});
    assert.equal(missing.check.status, "warning");
    assert.equal(missing.report, null);

    const pass = await diagnoseSettings(root, REPO, v1(), {});
    assert.equal(pass.check.name, "settings");
    assert.equal(pass.check.status, "pass");
    assert.ok(pass.report?.settings.length);

    const failing = await diagnoseSettings(root, REPO, v2(["INFEROPS_ENABLED", "INFEROPS_AUTH"]), { INFEROPS_API_KEY: SECRET });
    assert.equal(failing.check.status, "error");
    assert.match(failing.check.message, /INFERLAB_AUTH_ORIGIN is required/);
    assert.ok(!JSON.stringify(failing).includes(SECRET));

    // inferos.canvas.json leaving the gatekeeper out reaches the validation.
    writeFileSync(join(root, "inferos.canvas.json"), JSON.stringify({ customGatekeepers: [] }));
    const deselected = await diagnoseSettings(root, REPO, v2(["INFEROPS_ENABLED"]), {});
    assert.equal(deselected.check.status, "error");
    assert.match(deselected.check.message, /leaves gatekeeper-inferops out/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
