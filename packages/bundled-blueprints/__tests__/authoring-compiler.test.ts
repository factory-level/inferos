import { describe, expect, it } from "vitest";
import {
  compileAuthoredWidget,
  compileAuthoredWidgetRevision,
} from "../src/authoring-compiler.ts";

describe("compileAuthoredWidget", () => {
  it.each([
    ["node imports", `import fs from "node:fs"; export default () => fs;`],
    ["URL imports", `import data from "https://example.com/widget.js"; export default data;`],
    ["dynamic imports", `export default () => import("./" + name);`],
    ["literal dynamic imports", `export default () => import("./other.tsx");`],
    ["unapproved packages", `import x from "some-unapproved-package"; export default x;`],
    ["network access", `export default () => fetch("https://example.com");`],
    ["indirect network access", `export default () => window.fetch("https://example.com");`],
    ["credential access", `export default () => process.env.SECRET;`],
    ["CommonJS loading", `const x = require("react"); export default x;`],
  ])("refuses %s before emitting an artifact", async (_case, source) => {
    await expect(compileAuthoredWidget({ "client.tsx": source })).rejects.toThrow();
  });

  it("does not accept authored package manifests or unsupported source files", async () => {
    await expect(compileAuthoredWidget({
      "client.tsx": "export default () => null",
      "package.json": JSON.stringify({ dependencies: { "some-package": "*" } }),
    })).rejects.toThrow(/package\.json/u);

    await expect(compileAuthoredWidget({
      "client.tsx": "export default () => null",
      "extra.js": "export const value = 1",
    })).rejects.toThrow(/unsupported/u);

    await expect(compileAuthoredWidget({
      "client.tsx": "export default () => null",
      "unused.tsx": "const = invalid syntax",
    })).rejects.toThrow(/unsupported syntax/u);
  });

  it("bundles React, Refine and CSS into a deterministic self-contained artifact", async () => {
    const sources = {
      "client.tsx": `
        import React from "react";
        import { Refine, useForm, useTable } from "@refinedev/core";
        import "./widget.css";

        const Widget = () => {
          const { result } = useTable({ resource: "orders", syncWithLocation: false });
          const { onFinish } = useForm({ resource: "orders", action: "create" });
          return <><table><tbody>{result.data?.data.map((row: { id: number }) =>
            <tr key={row.id}><td>{row.id}</td></tr>)}</tbody></table>
            <form onSubmit={onFinish}><input name="title" /><button>Create order</button></form></>;
        };

        export default function App() {
          return <Refine resources={[{ name: "orders" }]}><Widget /></Refine>;
        }
      `,
      "widget.css": "table { border-collapse: collapse; }",
    };

    const [first, second] = await Promise.all([
      compileAuthoredWidget(sources),
      compileAuthoredWidget(sources),
    ]);

    expect(first.clientJs).toBe(second.clientJs);
    expect(first.artifactHash).toBe(second.artifactHash);
    expect(first.buildInputHash).toBe(second.buildInputHash);
    expect(first.artifactBytes).toBe(new TextEncoder().encode(first.clientJs).byteLength);
    expect(first.dataUrlEncodedBytes).toBe(
      new TextEncoder().encode(encodeURIComponent(first.clientJs)).byteLength,
    );
    expect(first.clientJs).toContain("border-collapse: collapse");
    expect(first.clientJs).not.toContain("sourceMappingURL");
    expect(first.clientJs).not.toContain("sourcesContent");
    expect(first.clientJs).not.toContain("/home/factorylevel/");
    expect(first.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.dependencyLockHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.dependencyLockBytes).toBeGreaterThan(0);
    expect(first.buildDurationMs).toBeGreaterThanOrEqual(0);
    expect(first.dependencyVersions).toMatchObject({
      "@refinedev/core": "5.0.12",
      react: "19.2.8",
    });
  });

  it("fails without changing an already selected artifact when source compilation fails", async () => {
    const lastGood = await compileAuthoredWidget({
      "client.tsx": `export default function App() { return <main>last good</main>; }`,
    });
    const result = await compileAuthoredWidgetRevision({
      "client.tsx": `import x from "node:fs"; export default x;`,
    }, lastGood);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.artifact).toBe(lastGood);
      expect(result.artifact?.artifactHash).toBe(lastGood.artifactHash);
      expect(result.error.message).toMatch(/node:fs/u);
    }
  });
});
