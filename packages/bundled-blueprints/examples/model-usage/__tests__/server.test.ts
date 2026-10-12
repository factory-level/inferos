// @vitest-environment node
// The Durable Object serves one demo workspace per load, chosen at the source, and stores nothing.
import { describe, expect, it } from "vitest";
import { DEMO_WORKSPACES } from "../files/lib/fixture.ts";
import { ExportHandler, Gadget } from "../files/server.ts";

/** A Durable Object state whose storage fails the test if the gadget ever touches it. */
const NO_STORAGE = new Proxy({}, {
  get(_target, name) {
    if (name === "storage") throw new Error("the Model usage gadget must store nothing");
    return undefined;
  },
}) as DurableObjectState;

const gadget = () => new Gadget(NO_STORAGE, {});
const [OPS, RESEARCH, QUIET, UNAVAILABLE] = DEMO_WORKSPACES.map(entry => entry.workspace);

describe("Model usage server", () => {
  it("lists the demo workspaces by name and id only", async () => {
    expect(await gadget().listWorkspaces()).toEqual(DEMO_WORKSPACES.map(e => e.workspace));
  });

  it("returns only the requested workspace's figures", async () => {
    const result = await gadget().loadUsage(OPS!.workspaceId);
    expect(result).toMatchObject({ ok: true, source: "demo-fixture", workspace: OPS });
    if (!result.ok) throw new Error("expected usage");
    expect(result.rows.map(r => r.model)).toEqual(["demo-large", "demo-small", "demo-code"]);
    // Nothing of another workspace travels with it.
    const text = JSON.stringify(result);
    for (const other of [RESEARCH, QUIET, UNAVAILABLE]) expect(text).not.toContain(other!.workspaceId);
  });

  it("answers a workspace it does not know as unknown-workspace, with no figures", async () => {
    for (const id of ["", "00000000-0000-4000-8000-000000000011", "*", RESEARCH!.workspaceName]) {
      const result = await gadget().loadUsage(id);
      expect(result).toEqual({ ok: false, reason: "unknown-workspace" });
    }
  });

  it("reports an unavailable source and an empty window truthfully", async () => {
    expect(await gadget().loadUsage(UNAVAILABLE!.workspaceId))
      .toMatchObject({ ok: false, reason: "unavailable" });
    expect(await gadget().loadUsage(QUIET!.workspaceId)).toMatchObject({ ok: true, rows: [] });
  });

  it("hands out copies, so a client cannot change the fixture", async () => {
    const first = await gadget().loadUsage(OPS!.workspaceId);
    if (!first.ok) throw new Error("expected usage");
    first.rows[0]!.inputTokens = 1;
    const second = await gadget().loadUsage(OPS!.workspaceId);
    if (!second.ok) throw new Error("expected usage");
    expect(second.rows[0]!.inputTokens).toBe(1_250_000);
  });

  it("offers no export formats", async () => {
    expect(await new ExportHandler({} as ExecutionContext, {}).getExportFormats()).toEqual([]);
  });
});
