import { describe, expect, it } from "vitest";
import projectUi from "../src/configurator/project-ui";
import type { InferOpsProjectConfiguratorRpc } from "../src/configurator/project-configurator-types";
import { parseProjectBoardUrl, projectBoardUrl } from "../src/resources";

const URL = "inferops://acme.operations/project/board/ENG";
const DEMO = "inferops://demo.local/project/board/DEMO";
const EXPECTED = /expected inferops:\/\/<tenant>\.<workspace>\/project\/board\/<KEY>/;

/** A configurator capability whose account offers `defaultHost` and nothing else. */
const uiWith = (defaultHost: string | null) =>
  ({ defaultHost: async () => defaultHost }) as unknown as InferOpsProjectConfiguratorRpc;

describe("project board URLs", () => {
  it("parses InferOps' own grammar, tenant and workspace from the host", () => {
    expect(parseProjectBoardUrl(URL)).toEqual({
      host: "acme.operations", tenant: "acme", workspace: "operations", projectKey: "ENG",
    });
    expect(projectBoardUrl(parseProjectBoardUrl(`${URL}/`))).toBe(URL);
    expect(parseProjectBoardUrl("inferops://my-org.ops-2/project/board/OPS1").workspace).toBe("ops-2");
  });

  it("keeps the demo host, which fits the grammar, working", () => {
    expect(parseProjectBoardUrl(DEMO)).toEqual({
      host: "demo.local", tenant: "demo", workspace: "local", projectKey: "DEMO",
    });
  });

  it.each([
    "https://acme.operations/project/board/ENG",
    // The authority is exactly two lowercase slug labels: no deployment, port or user info.
    "inferops://operations/project/board/ENG",
    "inferops://acme.operations.example/project/board/ENG",
    "inferops://localhost:8080/project/board/ENG",
    "inferops://acme.operations:8080/project/board/ENG",
    "inferops://ACME.operations/project/board/ENG",
    "inferops://acme.Operations/project/board/ENG",
    "inferops://ada@acme.operations/project/board/ENG",
    "inferops://acme.-ops/project/board/ENG",
    "inferops://acme.ops-/project/board/ENG",
    "inferops://.operations/project/board/ENG",
    `inferops://acme.${"a".repeat(64)}/project/board/ENG`,
    // The path and key.
    "inferops://acme.operations/project/board/eng",
    "inferops://acme.operations/project/board/ENG/issues",
    "inferops://acme.operations/project/ENG",
    "inferops://acme.operations/project/board/ENG?filter=project",
    "inferops:///project/board/ENG",
  ])("refuses %s", url => {
    expect(() => parseProjectBoardUrl(url)).toThrow(EXPECTED);
  });

  // The configurator duplicates the grammar because it is transpiled on its own; keep them in step.
  it.each([URL, DEMO])("round-trips %s through the configurator's prefill and resource URL", async url => {
    const values = await projectUi.initialValuesFromResourceUrl({
      resourceUrl: url, resourceUrlPattern: "inferops://*/project/board/*", ui: uiWith(null),
    });
    const { tenant, workspace, projectKey } = parseProjectBoardUrl(url);
    expect(values).toEqual({ tenant, workspace, projectKey });
    const built = await projectUi.resourceUrl({ values: { ...projectUi.initial, ...values }, ui: uiWith(null) });
    expect(parseProjectBoardUrl(built)).toEqual(parseProjectBoardUrl(url));
  });

  it("builds the demo URL with no organization or workspace only when the account offers it", async () => {
    const values = { ...projectUi.initial, projectKey: "DEMO" };
    expect(await projectUi.resourceUrl({ values, ui: uiWith("demo.local") })).toBe(DEMO);
    await expect(projectUi.resourceUrl({ values, ui: uiWith(null) }))
      .rejects.toThrow("Enter your organization and choose a workspace.");
  });
});
