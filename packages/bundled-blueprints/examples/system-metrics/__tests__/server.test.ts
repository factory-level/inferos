// @vitest-environment node
// The Durable Object serves one demo installation per load, chosen at the source, with each panel
// reported or unavailable on its own, and stores nothing.
import { describe, expect, it } from "vitest";
import { DEMO_INSTALLATIONS } from "../files/lib/fixture.ts";
import { ExportHandler, Gadget } from "../files/server.ts";

/** A Durable Object state whose storage fails the test if the gadget ever touches it. */
const NO_STORAGE = new Proxy({}, {
  get(_target, name) {
    if (name === "storage") throw new Error("the System metrics gadget must store nothing");
    return undefined;
  },
}) as DurableObjectState;

const gadget = () => new Gadget(NO_STORAGE, {});
const [A, B, C, D] = DEMO_INSTALLATIONS.map(entry => entry.installation);

describe("System metrics server", () => {
  it("S1 lists the demo installations by name and id only", async () => {
    const listed = await gadget().listInstallations();
    expect(listed).toEqual(DEMO_INSTALLATIONS.map(e => e.installation));
    for (const entry of listed) expect(Object.keys(entry).toSorted()).toEqual(["installationId", "installationName"]);
  });

  it("S2 returns only the requested installation's figures", async () => {
    const result = await gadget().loadMetrics(A!.installationId);
    expect(result).toMatchObject({ ok: true, installation: A });
    const text = JSON.stringify(result);
    for (const other of [B, C, D]) {
      expect(text).not.toContain(other!.installationId);
      expect(text).not.toContain(other!.installationName);
    }
    expect(text).not.toContain("demo-scheduler");
  });

  it("S3 answers an installation it does not know as unknown-installation, with no figures", async () => {
    for (const id of ["", "*", A!.installationName, crypto.randomUUID()]) {
      expect(await gadget().loadMetrics(id)).toEqual({ ok: false, reason: "unknown-installation" });
    }
  });

  it("S4 reports three unavailable panels that carry no data, window or freshness", async () => {
    const result = await gadget().loadMetrics(D!.installationId);
    if (!result.ok) throw new Error("expected panels");
    for (const panel of [result.activity, result.runs, result.health]) {
      expect(panel).toMatchObject({ state: "unavailable", source: "demo-fixture" });
      expect(Object.keys(panel).toSorted()).toEqual(["message", "modelledOn", "source", "state"]);
    }
  });

  it("S5 hands out copies, so a client cannot change the fixture", async () => {
    const first = await gadget().loadMetrics(A!.installationId);
    if (!first.ok || first.health.state !== "reported") throw new Error("expected health");
    first.health.data.workers[0]!.requests = 1;
    first.installation.installationName = "changed";
    const second = await gadget().loadMetrics(A!.installationId);
    if (!second.ok || second.health.state !== "reported") throw new Error("expected health");
    expect(second.health.data.workers[0]!.requests).toBe(48_210);
    expect(second.installation.installationName).toBe(A!.installationName);
  });

  it("S6 stores nothing and offers no export formats", async () => {
    const g = gadget();
    await g.listInstallations();
    for (const { installation } of DEMO_INSTALLATIONS) await g.loadMetrics(installation.installationId);
    expect(await new ExportHandler({} as ExecutionContext, {}).getExportFormats()).toEqual([]);
  });

  it("S7 holds no person fields", () => {
    const text = JSON.stringify(DEMO_INSTALLATIONS);
    for (const key of ["actorId", "ownerId", "email", "userId", "sessionId", "workspaceId"]) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(text).not.toContain("@");
  });
});
