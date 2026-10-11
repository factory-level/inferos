import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Step, type Workspace, packageFor, planChecks, report, scriptTestsFor, splitTestRun,
  touchesSettings, workspaceGlobs,
} from "./check-fast.ts";

const BACKEND = {
  dir: "packages/workshop-backend",
  name: "@gadgets/workshop-backend",
  testRun: "node scripts/a.ts && node scripts/b.ts && vitest run && vitest run --config vitest.integration.config.ts",
};
const SHARED = { dir: "packages/workshop-shared", name: "@gadgets/workshop-shared", testRun: "vitest run" };
const NO_TESTS = { dir: "packages/gatekeeper-slack", name: "@gadgets/gatekeeper-slack" };
const BUN = { dir: "assistant-plugins/openai", name: "@gadgets/assistant-plugin-openai", testRun: "bun test src" };

const SOURCES: Record<string, string> = {
  "scripts/vp/concurrency.test.ts": `import { x } from "./concurrency.ts";`,
  "scripts/vp/run.test.ts": `import { y } from "../map-concurrent.ts";`,
  "scripts/map-concurrent.test.ts": `import { mapConcurrent } from "./map-concurrent.ts";`,
  "scripts/consumer/intake.test.ts": `import { intake } from "./intake.ts";`,
  "scripts/consumer/settings.test.ts": `import { SETTINGS } from "./settings.ts";`,
};

const workspace: Workspace = {
  root: "/repo",
  packages: [BACKEND, SHARED, NO_TESTS, BUN],
  scriptTests: Object.keys(SOURCES),
  readFile: file => SOURCES[file] ?? "",
  exists: file => !file.includes("deleted"),
  bin: (_dir, bin) => ["node", [`/bin/${bin}.mjs`]],
};

const commandLine = (step: Step) => [step.command, ...step.args].join(" ");

describe("workspaceGlobs", () => {
  it("reads only the packages list", () => {
    const yaml = "packages:\n  - packages/*\n  # a comment\n  - 'custom-gatekeepers/*'\n  - scripts\n\n" +
      "catalog:\n  - not-a-package\n";
    assert.deepEqual(workspaceGlobs(yaml), ["packages/*", "custom-gatekeepers/*", "scripts"]);
  });
});

describe("splitTestRun", () => {
  it("separates the codegen prelude from each vitest run's arguments", () => {
    assert.deepEqual(splitTestRun(BACKEND.testRun), {
      prelude: ["node scripts/a.ts", "node scripts/b.ts"],
      vitest: [[], ["--config", "vitest.integration.config.ts"]],
    });
  });

  it("has nothing to run for a missing or non-vitest script", () => {
    assert.deepEqual(splitTestRun(undefined), { prelude: [], vitest: [] });
    assert.deepEqual(splitTestRun("bun test src"), { prelude: [], vitest: [] });
  });
});

describe("packageFor", () => {
  it("matches a whole directory, never a name prefix", () => {
    assert.equal(packageFor("packages/workshop-backend/src/a.ts", workspace.packages), BACKEND);
    assert.equal(packageFor("packages/workshop-backend-extra/a.ts", workspace.packages), undefined);
  });
});

describe("scriptTestsFor", () => {
  it("finds a module's sibling suite and its direct importers", () => {
    assert.deepEqual(scriptTestsFor("scripts/map-concurrent.ts", workspace),
      ["scripts/map-concurrent.test.ts", "scripts/vp/run.test.ts"]);
    assert.deepEqual(scriptTestsFor("scripts/vp/concurrency.ts", workspace), ["scripts/vp/concurrency.test.ts"]);
  });

  it("runs a changed suite itself", () => {
    assert.deepEqual(scriptTestsFor("scripts/consumer/intake.test.ts", workspace), ["scripts/consumer/intake.test.ts"]);
  });

  it("runs the nearest directory's suites for a data file", () => {
    assert.deepEqual(scriptTestsFor("scripts/consumer/fixtures/intake/a.json", workspace),
      ["scripts/consumer/intake.test.ts", "scripts/consumer/settings.test.ts"]);
  });
});

describe("touchesSettings", () => {
  for (const file of ["scripts/consumer/config.ts", "scripts/dev-server-config.ts",
    "packages/workshop-backend/src/env.d.ts", "docs/wiki/configuration-reference.md"]) {
    it(`includes ${file}`, () => assert.equal(touchesSettings(file), true));
  }
  it("leaves unrelated files alone", () => assert.equal(touchesSettings("scripts/vp/run.ts"), false));
});

describe("planChecks", () => {
  it("type-checks a package and runs vitest related once per config, after its prelude", () => {
    const plan = planChecks(
      ["packages/workshop-backend/src/sharing.ts", "packages/workshop-backend/src/deleted.ts"], workspace);
    assert.deepEqual(plan.unchecked, []);
    const [group] = plan.groups;
    assert.equal(group.name, BACKEND.name);
    assert.deepEqual(group.prelude.map(step => step.command), ["node scripts/a.ts", "node scripts/b.ts"]);
    assert.ok(group.prelude.every(step => step.shell && step.cwd === "/repo/packages/workshop-backend"));
    assert.deepEqual(group.checks.map(commandLine), [
      `${process.execPath} /repo/scripts/vp/run.ts -F @gadgets/workshop-backend --cache build`,
      // The deleted file still type-checks the package, but is not handed to vitest.
      "node /bin/vitest.mjs related /repo/packages/workshop-backend/src/sharing.ts --run --passWithNoTests",
      "node /bin/vitest.mjs related /repo/packages/workshop-backend/src/sharing.ts --run --passWithNoTests " +
        "--config vitest.integration.config.ts",
    ]);
  });

  it("only type-checks a package whose tests are absent or not vitest", () => {
    const plan = planChecks(["packages/gatekeeper-slack/src/a.ts", "assistant-plugins/openai/src/a.ts"], workspace);
    assert.deepEqual(plan.groups.map(group => [group.name, group.prelude.length, group.checks.length]),
      [[BUN.name, 0, 1], [NO_TESTS.name, 0, 1]]);
    assert.deepEqual(plan.unchecked.map(entry => entry.file), ["assistant-plugins/openai"]);
  });

  it("runs the scripts suites, the scripts type-check, the settings check and docs:check", () => {
    const plan = planChecks(["scripts/vp/concurrency.ts", "scripts/consumer/config.ts", "docs/wiki/a.md"], workspace);
    assert.deepEqual(plan.groups.map(group => group.name), ["repo"]);
    const labels = plan.groups[0].checks.map(step => step.label);
    assert.deepEqual(labels, ["node --test (2 suites)", "pnpm types:scripts", "pnpm docs:check"]);
    assert.deepEqual(plan.groups[0].checks[0].args,
      ["--test", "scripts/consumer/settings.test.ts", "scripts/vp/concurrency.test.ts"]);
  });

  it("reports what it cannot check instead of passing it silently", () => {
    const plan = planChecks(["package.json", "packages/workshop-backend/vitest.config.ts"], workspace);
    assert.deepEqual(plan.groups, []);
    assert.deepEqual(plan.unchecked.map(entry => entry.file), ["package.json", "packages/workshop-backend/vitest.config.ts"]);
  });
});

describe("report", () => {
  it("prints failures in full and exits non-zero", () => {
    let out = "";
    const code = report([
      { group: "a", label: "type-check", status: "ok", seconds: 1.25, output: "fine" },
      { group: "a", label: "vitest", status: "FAIL", seconds: 2, output: "boom", detail: "1 failed (1)" },
    ], 3, text => { out += text; });
    assert.equal(code, 1);
    assert.match(out, /=== FAIL a: vitest ===\nboom/);
    assert.doesNotMatch(out, /fine/);
    assert.match(out, /ok {4}a: type-check\s+1\.3s/);
    assert.match(out, /1 failed in 3\.0s/);
  });
});
