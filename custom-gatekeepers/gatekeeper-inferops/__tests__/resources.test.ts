import { describe, expect, it } from "vitest";
import dispatchUi from "../src/configurator/dispatch-ui";
import wikiUi from "../src/configurator/wiki-ui";
import projectUi from "../src/configurator/project-ui";
import tableUi from "../src/configurator/table-ui";
import type { InferOpsProjectConfiguratorRpc } from "../src/configurator/project-configurator-types";
import {
  parseProjectBoardUrl, parseProjectDispatchUrl, parseTableUrl, parseWikiUrl, projectBoardUrl,
} from "../src/resources";

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

describe("coding-dispatch URLs", () => {
  const DISPATCH = "inferops://acme.operations/project/dispatch/ENG";
  const DEMO_DISPATCH = "inferops://demo.local/project/dispatch/DEMO";

  it("never parses as a board, nor a board as a dispatch", () => {
    expect(() => parseProjectBoardUrl(DISPATCH)).toThrow(EXPECTED);
    expect(() => parseProjectDispatchUrl(URL)).toThrow(/project\/dispatch\/<KEY>/);
  });

  // The dispatch picker duplicates the grammar too; keep it in step.
  it.each([DISPATCH, DEMO_DISPATCH])("round-trips %s through the dispatch picker", async url => {
    const values = await dispatchUi.initialValuesFromResourceUrl({
      resourceUrl: url, resourceUrlPattern: "inferops://*/project/dispatch/*", ui: uiWith(null),
    });
    const { tenant, workspace, projectKey } = parseProjectDispatchUrl(url);
    expect(values).toEqual({ tenant, workspace, projectKey });
    const built = await dispatchUi.resourceUrl({ values: { ...dispatchUi.initial, ...values }, ui: uiWith(null) });
    expect(parseProjectDispatchUrl(built)).toEqual(parseProjectDispatchUrl(url));
    // A board URL does not prefill the dispatch picker.
    expect(await dispatchUi.initialValuesFromResourceUrl({
      resourceUrl: URL, resourceUrlPattern: "inferops://*/project/dispatch/*", ui: uiWith(null),
    })).toEqual({});
  });
});

describe("Wiki URLs", () => {
  const WIKI = "inferops://acme.knowledge/knowledge/wiki";
  const DEMO_WIKI = "inferops://demo.local/knowledge/wiki";
  const PATTERN = "inferops://*/knowledge/wiki";

  // The Wiki picker duplicates the grammar too; keep it in step.
  it.each([WIKI, DEMO_WIKI])("round-trips %s through the Wiki picker", async url => {
    const values = await wikiUi.initialValuesFromResourceUrl({
      resourceUrl: url, resourceUrlPattern: PATTERN, ui: uiWith(null),
    });
    const { tenant, workspace } = parseWikiUrl(url);
    expect(values).toEqual({ tenant, workspace });
    const built = await wikiUi.resourceUrl({ values: { ...wikiUi.initial, ...values }, ui: uiWith(null) });
    expect(parseWikiUrl(built)).toEqual(parseWikiUrl(url));
    // A board URL does not prefill the Wiki picker.
    expect(await wikiUi.initialValuesFromResourceUrl({
      resourceUrl: URL, resourceUrlPattern: PATTERN, ui: uiWith(null),
    })).toEqual({});
  });

  it("builds the demo Wiki with no organization or workspace only when the account offers it", async () => {
    expect(await wikiUi.resourceUrl({ values: wikiUi.initial, ui: uiWith("demo.local") })).toBe(DEMO_WIKI);
    await expect(wikiUi.resourceUrl({ values: wikiUi.initial, ui: uiWith(null) }))
      .rejects.toThrow("choose an InferMind workspace");
  });
});

describe("custom table URLs", () => {
  const TABLE = "inferops://acme.operations/object/table/70000000-0000-4000-8000-00000000000a";
  const DEMO_TABLE = "inferops://demo.local/object/table/70000000-0000-4000-8000-000000000001";
  const PATTERN = "inferops://*/object/table/*";

  // The table picker duplicates the grammar too; keep it in step.
  it.each([TABLE, DEMO_TABLE])("round-trips %s through the table picker", async url => {
    const values = await tableUi.initialValuesFromResourceUrl({
      resourceUrl: url, resourceUrlPattern: PATTERN, ui: uiWith(null),
    });
    const { tenant, workspace, tableId } = parseTableUrl(url);
    expect(values).toEqual({ tenant, workspace, tableId });
    const built = await tableUi.resourceUrl({ values: { ...tableUi.initial, ...values }, ui: uiWith(null) });
    expect(parseTableUrl(built)).toEqual(parseTableUrl(url));
    // A board URL does not prefill the table picker.
    expect(await tableUi.initialValuesFromResourceUrl({
      resourceUrl: URL, resourceUrlPattern: PATTERN, ui: uiWith(null),
    })).toEqual({});
  });

  it("needs a table, and names the demo host only when the account offers it", async () => {
    const demo = { ...tableUi.initial, tableId: "70000000-0000-4000-8000-000000000001" };
    expect(await tableUi.resourceUrl({ values: demo, ui: uiWith("demo.local") })).toBe(DEMO_TABLE);
    await expect(tableUi.resourceUrl({ values: demo, ui: uiWith(null) })).rejects.toThrow("choose a workspace and a table");
    await expect(tableUi.resourceUrl({ values: tableUi.initial, ui: uiWith("demo.local") }))
      .rejects.toThrow("choose a workspace and a table");
  });
});
