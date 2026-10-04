// Every connection package's `connection.json` against `connection-package.schema.json`, and against
// the package's own source: a contract naming a resource kind, entrypoint, session method or
// credential the code does not have is wrong, however well it validates.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(readFileSync(join(root, "scripts/connection-package.schema.json"), "utf8"));
const validator = z.fromJSONSchema(schema);

type Contract = {
  id: string;
  package: string;
  entrypoints: { main: string; vendor: string; account: string; verifier?: string; durableObjects: string[] };
  resources: Array<{
    kind: string; urlPattern: string; gatekeeper: string; session: string; enabledBy?: string[];
    reads: Array<{ method: string }>; writes: Array<{ method: string }>;
  }>;
  credentials: Array<{ name: string }>;
  compatibility: { provider: { revision: string }; contracts: Array<{ path: string }> };
  conformance: { tests: string[]; covered: Record<string, string[]>; perConnector: Array<{ kind: string }> };
};

/** Every `connection.json` one level under the two package roots. */
function contractPaths(): string[] {
  const found: string[] = [];
  for (const base of ["packages", "custom-gatekeepers"]) {
    for (const entry of readdirSync(join(root, base))) {
      const candidate = join(root, base, entry, "connection.json");
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** The text of every TypeScript source file under `dir`, joined. */
function sourceText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir).map(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? "" : sourceText(path);
    return /\.tsx?$/.test(name) ? readFileSync(path, "utf8") : "";
  }).join("\n");
}

const contracts = contractPaths();

describe("connection packages", () => {
  it("finds the reference package", () => {
    assert.ok(contracts.some(path => path.endsWith("custom-gatekeepers/gatekeeper-inferops/connection.json")),
      "custom-gatekeepers/gatekeeper-inferops/connection.json is missing");
  });

  for (const path of contracts) {
    const dir = join(path, "..");
    const name = relative(root, path);
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));

    describe(name, () => {
      it("matches the schema", () => {
        const parsed = validator.safeParse(raw);
        assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
      });

      const contract = raw as Contract;
      const source = sourceText(join(dir, "src"));

      it("names its own package", () => {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
        assert.equal(contract.package, manifest.name);
        assert.ok(existsSync(join(dir, contract.entrypoints.main)), `${contract.entrypoints.main} is missing`);
      });

      it("declares only resource kinds the source offers", () => {
        for (const resource of contract.resources) {
          assert.ok(source.includes(`"${resource.urlPattern}"`),
            `${resource.kind}: no source declares urlPattern ${resource.urlPattern}`);
          const named = resource.urlPattern.replace(/^[a-z]+:\/\/\*\//, "").replace(/\/\*$/, "");
          assert.equal(named, resource.kind, `${resource.kind}: its urlPattern names ${named}`);
        }
        const kinds = contract.resources.map(resource => resource.kind);
        assert.equal(new Set(kinds).size, kinds.length, "a resource kind is listed twice");
      });

      it("names entrypoints, sessions and methods the source defines", () => {
        const { vendor, account, verifier, durableObjects } = contract.entrypoints;
        for (const cls of [vendor, account, verifier, ...durableObjects,
          ...contract.resources.map(resource => resource.gatekeeper)]) {
          if (cls === undefined) continue;
          assert.match(source, new RegExp(`\\bclass ${cls}\\b`), `no class ${cls} in src/`);
        }
        for (const resource of contract.resources) {
          assert.match(source, new RegExp(`\\binterface ${resource.session}\\b`),
            `${resource.kind}: no interface ${resource.session} in src/`);
          for (const { method } of [...resource.reads, ...resource.writes]) {
            assert.match(source, new RegExp(`\\b${method}\\(`), `${resource.kind}: no method ${method} in src/`);
          }
          for (const flag of resource.enabledBy ?? []) {
            assert.ok(contract.credentials.some(credential => credential.name === flag),
              `${resource.kind}: switch ${flag} is not among the package's configuration names`);
          }
        }
      });

      it("names only configuration the source reads, and holds no values", () => {
        for (const { name: variable } of contract.credentials) {
          assert.match(source, new RegExp(`\\b${variable}\\b`), `${variable} is not read anywhere in src/`);
        }
        // The schema already refuses unknown keys; this is the property it exists to protect.
        assert.ok(contract.credentials.every(credential => !("value" in credential)));
      });

      it("pins each contract file to the provider revision it records", () => {
        for (const { path: contractPath } of contract.compatibility.contracts) {
          const file = join(root, contractPath);
          assert.ok(existsSync(file), `${contractPath} is missing`);
          const pinned = (JSON.parse(readFileSync(file, "utf8")) as { source?: { revision?: string } })
            .source?.revision;
          assert.equal(pinned, contract.compatibility.provider.revision,
            `${contractPath} was generated at ${pinned}, not the recorded revision`);
        }
      });

      it("registers the shared conformance suite for the kinds it claims", () => {
        for (const test of contract.conformance.tests) {
          const text = readFileSync(join(dir, test), "utf8");
          assert.match(text, /from "@gadgets\/gatekeeper-kit\/conformance"/, `${test} does not import the suite`);
          assert.match(text, /defineConformanceSuite\(/, `${test} does not register the suite`);
        }
        const kinds = new Set(contract.resources.map(resource => resource.kind));
        for (const kind of [...Object.keys(contract.conformance.covered),
          ...contract.conformance.perConnector.map(entry => entry.kind)]) {
          assert.ok(kinds.has(kind), `conformance names unknown resource kind ${kind}`);
        }
      });
    });
  }
});

describe("connection package schema", () => {
  const valid = JSON.parse(readFileSync(
    join(root, "custom-gatekeepers/gatekeeper-inferops/connection.json"), "utf8")) as Contract;

  it("refuses a credential carrying a value", () => {
    const leaked = structuredClone(valid) as unknown as { credentials: Array<Record<string, unknown>> };
    leaked.credentials[0]!.value = "secret";
    assert.equal(validator.safeParse(leaked).success, false);
  });

  it("refuses an unknown format version and an unknown conformance case", () => {
    assert.equal(validator.safeParse({ ...valid, schemaVersion: 2 }).success, false);
    const unknownCase = structuredClone(valid);
    unknownCase.conformance.covered["project/board"] = ["everything"];
    assert.equal(validator.safeParse(unknownCase).success, false);
  });
});
