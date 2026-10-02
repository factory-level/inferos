import { describe, expect, it } from "vitest";
import projectUi from "../src/configurator/project-ui";
import { parseProjectBoardUrl, projectBoardUrl } from "../src/resources";

const URL = "inferops://demo.local/project/board/DEMO";

describe("project board URLs", () => {
  it("parses and formats as inverses", () => {
    expect(parseProjectBoardUrl(URL)).toEqual({ host: "demo.local", projectKey: "DEMO" });
    expect(projectBoardUrl(parseProjectBoardUrl(`${URL}/`))).toBe(URL);
  });

  it.each([
    "https://demo.local/project/board/DEMO",
    "inferops://demo.local/project/board/demo",
    "inferops://demo.local/project/board/DEMO/issues",
    "inferops://demo.local/project/DEMO",
    "inferops:///project/board/DEMO",
  ])("refuses %s", url => {
    expect(() => parseProjectBoardUrl(url)).toThrow(/expected inferops:\/\/<host>\/project\/board\/<KEY>/);
  });

  // The configurator duplicates the grammar because it is transpiled on its own; keep them in step.
  it("round-trips through the configurator's prefill and resource URL", async () => {
    const values = await projectUi.initialValuesFromResourceUrl({
      resourceUrl: URL, resourceUrlPattern: "inferops://*/project/board/*", ui: null as never,
    });
    expect(values).toEqual({ host: "demo.local", projectKey: "DEMO" });
    const url = await projectUi.resourceUrl({ values: { ...projectUi.initial, ...values }, ui: null as never });
    expect(parseProjectBoardUrl(url)).toEqual(parseProjectBoardUrl(URL));
  });
});
