import { describe, expect, it } from "vitest";
import {
  validateAuthoredWidgetSources,
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
    const operation = new Promise<number>(resolve => setTimeout(() => resolve(1), 20));
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

});
