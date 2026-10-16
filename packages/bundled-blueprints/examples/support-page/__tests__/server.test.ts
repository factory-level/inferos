// @vitest-environment node
// The Durable Object serves one demo installation per load, chosen at the source; regions are
// reported, refused or failed on their own; it stores nothing, holds no person or secret, has no
// write method and carries no approval figure.
import { describe, expect, it } from "vitest";
import { DEMO_INSTALLATIONS } from "../files/lib/fixture.ts";
import { ExportHandler, Gadget } from "../files/server.ts";

/** A Durable Object state whose storage fails the test if the gadget ever touches it. */
const NO_STORAGE = new Proxy({}, {
  get(_target, name) {
    if (name === "storage") throw new Error("the tech support page must store nothing");
    return undefined;
  },
}) as DurableObjectState;

const gadget = () => new Gadget(NO_STORAGE, {});
const [A, B, C, D, E] = DEMO_INSTALLATIONS.map(entry => entry.installation);
const REGIONS = ["peopleActiveToday", "runsFailed24h", "board", "runbook"] as const;

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe("Tech support page server", () => {
  it("S1 lists the demo installations by name and id only", async () => {
    const listed = await gadget().listInstallations();
    expect(listed).toEqual(DEMO_INSTALLATIONS.map(e => e.installation));
    for (const entry of listed) expect(Object.keys(entry).toSorted()).toEqual(["installationId", "installationName"]);
  });

  it("S2 returns only the requested installation's page", async () => {
    const result = await gadget().loadSupportPage(A!.installationId);
    expect(result).toMatchObject({ ok: true, installation: A });
    const text = JSON.stringify(result);
    for (const other of [B, C, D, E]) {
      expect(text).not.toContain(other!.installationId);
      expect(text).not.toContain(other!.installationName);
    }
    if (!result.ok || result.board.state !== "reported") throw new Error("expected A's board");
    const own = result.board.data.columns.flatMap(c => c.issues.map(i => i.identifier));
    for (const id of text.match(/SUP-\d+/g) ?? []) expect(own).toContain(id);
  });

  it("S3 answers an installation it does not know as unknown-installation", async () => {
    for (const id of ["", "*", A!.installationName, crypto.randomUUID()]) {
      expect(await gadget().loadSupportPage(id)).toEqual({ ok: false, reason: "unknown-installation" });
    }
  });

  it("S4 D is denied and E unavailable in every region, with no data, asOf or window", async () => {
    for (const [who, state] of [[D, "denied"], [E, "unavailable"]] as const) {
      const result = await gadget().loadSupportPage(who!.installationId);
      if (!result.ok) throw new Error("expected regions");
      for (const name of REGIONS) {
        const region = result[name];
        expect(region.state).toBe(state);
        for (const key of ["data", "asOf", "window"]) expect(keysOf(region)).not.toContain(key);
      }
    }
  });

  it("S5 hands out copies, so a client cannot change the fixture", async () => {
    const first = await gadget().loadSupportPage(A!.installationId);
    if (!first.ok || first.board.state !== "reported") throw new Error("expected A's board");
    first.board.data.columns[0]!.issues[0]!.title = "changed";
    first.installation.installationName = "changed";
    const second = await gadget().loadSupportPage(A!.installationId);
    if (!second.ok || second.board.state !== "reported") throw new Error("expected A's board");
    expect(second.board.data.columns[0]!.issues[0]!.title).toBe("Demo: export to CSV drops the last row");
    expect(second.installation.installationName).toBe(A!.installationName);
  });

  it("S6 stores nothing and offers no export formats", async () => {
    const g = gadget();
    await g.listInstallations();
    for (const { installation } of DEMO_INSTALLATIONS) await g.loadSupportPage(installation.installationId);
    expect(await new ExportHandler({} as ExecutionContext, {}).getExportFormats()).toEqual([]);
  });

  it("S7 holds no person or secret", () => {
    const keys = keysOf(DEMO_INSTALLATIONS);
    for (const banned of ["assigneeId", "actorId", "ownerId", "userId", "sessionId", "workspaceId", "gatekeeperId",
      "email"]) {
      expect(keys).not.toContain(banned);
    }
    for (const key of keys) expect(key).not.toMatch(/token|secret|password|credential|api.?key/i);
    expect(JSON.stringify(DEMO_INSTALLATIONS)).not.toContain("@");
  });

  it("S8 has no write surface: only the two read methods", () => {
    expect(Object.getOwnPropertyNames(Gadget.prototype).toSorted())
      .toEqual(["constructor", "listInstallations", "loadSupportPage"]);
  });

  it("S9 carries no approval figure for any installation", async () => {
    for (const { installation } of DEMO_INSTALLATIONS) {
      for (const key of keysOf(await gadget().loadSupportPage(installation.installationId))) {
        expect(key).not.toMatch(/reject|decision|approval/i);
      }
    }
  });
});
