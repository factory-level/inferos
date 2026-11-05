import { describe, expect, it } from "vitest";
import { isValidAuthoredWidgetSourcePath } from "../src/authored-widget-path.js";
import {
  validateAuthoredWidgetSources,
  maximumSourcePathBytes,
  withBuildDeadline,
} from "../src/authored-widget-validation.js";

const valid = { "client.tsx": "export default function Widget(){ return <div>hello</div> }" };

const refusal = (source: Readonly<Record<string, string>>) => {
  expect(() => validateAuthoredWidgetSources(source)).toThrow();
};

describe("authored widget publication input", () => {
  it("refuses invalid TSX and unapproved dependencies", () => {
    refusal({ "client.tsx": "export default function {" });
    refusal({ "client.tsx": 'import fs from "node:fs"; export default function Widget(){ return <div/> }' });
  });

  it("refuses more than the source-file cap", () => {
    const files: Record<string, string> = { ...valid };
    for (let index = 0; index < 100; index++) files[`extra-${index}.tsx`] = "export {};";
    refusal(files);
  });

  it("refuses when the build deadline expires", async () => {
    const operation = new Promise<number>(() => {});
    await expect(withBuildDeadline(operation, 0)).rejects.toThrow("compile timeout");
  });

  it("accepts a bounded source tree with a default component export", () => {
    expect(validateAuthoredWidgetSources(valid)).toEqual(new Map(Object.entries(valid)));
    expect(validateAuthoredWidgetSources({
      ...valid,
      "client.tsx": 'import Panel from "./components/Panel"; export default function Widget(){ return <Panel/> }',
      "components/Panel.tsx": "export default function Panel(){ return <div/> }",
    })).toHaveProperty("size", 2);
  });

  it("accepts source paths at the byte limit and refuses paths one byte over", () => {
    const atLimit = `${"a".repeat(maximumSourcePathBytes - ".tsx".length)}.tsx`;
    expect(validateAuthoredWidgetSources({ ...valid, [atLimit]: "export {};" })).toHaveProperty("size", 2);
    const overLimit = `${"a".repeat(maximumSourcePathBytes + 1 - ".tsx".length)}.tsx`;
    expect(() => validateAuthoredWidgetSources({ ...valid, [overLimit]: "export {};" }))
      .toThrow("Invalid source path.");
  });

  it("applies the shared path grammar to every authored source path", () => {
    for (const path of [
      "../client.tsx", "/client.tsx", "folder\\client.tsx", "folder//client.tsx",
      "folder/./client.tsx", "folder/../client.tsx", "package.json", "folder/package.json",
      "client.js", "release..tsx", "C:/client.tsx", "C:\\client.tsx", "\\\\server\\share\\client.tsx",
      "bad\0name.tsx", "bad\x01name.tsx",
      "bad\x1fname.tsx", "bad\x7fname.tsx", "bad\u0080name.tsx", "bad\u009fname.tsx",
      "folder/", "bad\uFF0Fname.tsx", "bad\u2215name.tsx", "bad\u2044name.tsx",
      "bad\u2024name.tsx", "bad\u202Ename.tsx", "bad\u200Bname.tsx", "bad\u2066name.tsx",
    ]) expect(isValidAuthoredWidgetSourcePath(path), path).toBe(false);
    expect(isValidAuthoredWidgetSourcePath("client.tsx")).toBe(true);
    expect(isValidAuthoredWidgetSourcePath("components/Widget.css")).toBe(true);
  });

});
