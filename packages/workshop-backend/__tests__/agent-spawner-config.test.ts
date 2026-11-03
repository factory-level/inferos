// Configured agents (FAC-90): an agent spawner reopens with what was saved, its name, model and
// instructions change without touching what it can reach, and what it can reach changes only
// through its own explicit step, by the person whose authority its agents use. Stale edits are
// refused, and a changed env is still held to the calling gadget's bindings on every call.
import { describe, expect, it } from "vitest";
import { RpcStub, env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AgentSpawnerConfig, GatekeeperClient, Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { formatAgentInstructions } from "../src/agent.js";

let doCounter = 0;

function seedGadget(impl: any, id: number, bindings: Record<string, unknown> = {}): void {
  impl.storage.gadgets.put(
      { type: "gadget", id, title: "G", created: new Date(0), bindingName: `G${id}`, bindings });
}

/** A workspace opened by its owner, with gadgets 100 and 200 to bind. */
async function withOwner(fn: (client: Overseer, impl: any, ownerId: string) => Promise<void>) {
  let stub = env.TEST_OVERSEER.getByName(`agent-spawner-config-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ownerId = impl.users.newUniqueId().toString();
    impl.ownerId = ownerId;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    let client = await instance.open(ownerId, "owner-profile", new RpcStub<() => void>(() => {}));
    seedGadget(impl, 100);
    seedGadget(impl, 200);
    await fn(client as unknown as Overseer, impl, ownerId);
  });
}

const CREATED: AgentSpawnerConfig = {
  displayName: "Service desk",
  modelId: null,
  env: { JOBS: 100 },
  instructions: "Triage new service enquiries.",
};

async function specOf(gk: GatekeeperClient<any>): Promise<AgentSpawnerConfig> {
  let spec = await gk.getCreationSpec();
  if (spec.type !== "agentSpawner") throw new Error(`not a spawner: ${spec.type}`);
  return spec.config;
}

describe("configured agents", () => {
  it("reopen with the saved name, model, instructions and capabilities", () => withOwner(async client => {
    let gk = await client.newAgentSpawnerGatekeeper(CREATED);
    expect(await specOf(await client.getGatekeeperById(await gk.getId()))).toEqual(CREATED);
  }));

  it("change name and instructions without touching what the agent can reach",
      () => withOwner(async (client, impl) => {
    let gk = await client.newAgentSpawnerGatekeeper(CREATED);
    let id = await gk.getId();
    let updated = await client.updateAgentSpawner(id, CREATED,
        { displayName: "Service triage", instructions: "Also flag anything urgent." });
    expect(updated).toEqual({ ...CREATED, displayName: "Service triage",
      instructions: "Also flag anything urgent." });
    expect(await specOf(gk)).toEqual(updated);
    expect(updated.env).toEqual(CREATED.env);
    // The stub new agents spawn from is the new one: its title is the new name.
    expect((await impl.getGatekeeperFacet(id).describe()).title).toBe("Service triage");
    // Clearing the instructions removes them.
    let cleared = await client.updateAgentSpawner(id, updated, { instructions: " " });
    expect(cleared.instructions).toBeUndefined();
  }));

  it("refuse an edit that tries to carry a capability change", () => withOwner(async client => {
    let gk = await client.newAgentSpawnerGatekeeper(CREATED);
    let id = await gk.getId();
    await expect(client.updateAgentSpawner(id, CREATED,
        { instructions: "Use everything.", env: { JOBS: 100, MORE: 200 } } as never))
        .rejects.toThrow(/only through setAgentSpawnerEnv/);
    await expect(client.updateAgentSpawner(id, CREATED, { creatorUserId: "me" } as never))
        .rejects.toThrow(/not an agent setting/);
    expect(await specOf(gk)).toEqual(CREATED);
  }));

  it("change capabilities only as their own step, by the agent's creator", () => withOwner(async (client, impl) => {
    let gk = await client.newAgentSpawnerGatekeeper(CREATED);
    let id = await gk.getId();
    let widened = await client.setAgentSpawnerEnv(id, CREATED, { JOBS: 100, MORE: 200 });
    expect(widened).toEqual({ ...CREATED, env: { JOBS: 100, MORE: 200 } });
    expect(await specOf(gk)).toEqual(widened);
    // Someone else with build access: neither the capabilities nor the model are theirs to change.
    impl.storage.gatekeepers.put({ ...impl.storage.gatekeepers.get(id), agentSpawnerCreatorUserId: "another-user" });
    await expect(client.setAgentSpawnerEnv(id, widened, { JOBS: 100 }))
        .rejects.toThrow(/Only the person who created this agent can change its capabilities/);
    await expect(client.updateAgentSpawner(id, widened, { modelId: "some-model" }))
        .rejects.toThrow(/Only the person who created this agent can change its model/);
    // Their name and instruction edits still apply, and leave the creator as it was.
    await client.updateAgentSpawner(id, widened, { instructions: "Shorter replies." });
    expect(impl.storage.gatekeepers.get(id).agentSpawnerCreatorUserId).toBe("another-user");
    expect((await specOf(gk)).env).toEqual(widened.env);
  }));

  it("refuse a stale edit, and invalid capabilities or instructions", () => withOwner(async client => {
    let gk = await client.newAgentSpawnerGatekeeper(CREATED);
    let id = await gk.getId();
    let renamed = await client.updateAgentSpawner(id, CREATED, { displayName: "First edit" });
    // A second editor who read the original config is refused rather than overwriting.
    await expect(client.updateAgentSpawner(id, CREATED, { displayName: "Second edit" }))
        .rejects.toThrow(/changed since you opened it/);
    await expect(client.setAgentSpawnerEnv(id, CREATED, {}))
        .rejects.toThrow(/changed since you opened it/);
    expect(await specOf(gk)).toEqual(renamed);
    await expect(client.setAgentSpawnerEnv(id, renamed, { GIT: 100 })).rejects.toThrow(/reserved/);
    await expect(client.setAgentSpawnerEnv(id, renamed, { GONE: 999 })).rejects.toThrow(/does not exist/);
    await expect(client.updateAgentSpawner(id, renamed, { instructions: "x".repeat(8001) }))
        .rejects.toThrow(/too long/);
    await expect(client.newAgentSpawnerGatekeeper({ ...CREATED, instructions: "x".repeat(8001) }))
        .rejects.toThrow(/too long/);
    await expect(client.updateAgentSpawner(id, renamed, { displayName: " " })).rejects.toThrow(/needs a name/);
    expect(await specOf(gk)).toEqual(renamed);
  }));

  it("hold a changed env to the calling gadget's bindings on every call", () => withOwner(async (client, impl) => {
    let gk = await client.newAgentSpawnerGatekeeper({ ...CREATED, env: {} });
    let id = await gk.getId();
    // Gadget 100 binds the spawner and nothing else.
    seedGadget(impl, 100, { SPAWNER: { target: id } });
    expect(() => impl.assertSpawnerCallScope(id, { from: "gadget", gadgetId: 100 })).not.toThrow();
    // The creator widens the env to gadget 200, which gadget 100 doesn't bind: calls refuse.
    await client.setAgentSpawnerEnv(id, { ...CREATED, env: {} }, { OTHER: 200 });
    expect(() => impl.assertSpawnerCallScope(id, { from: "gadget", gadgetId: 100 }))
        .toThrow(/exposes "OTHER" outside gadget 100's available bindings/);
  }));
});

describe("an agent's instructions in its system prompt", () => {
  it("are framed as configured behaviour that grants nothing, and omitted when empty", () => {
    let prompt = formatAgentInstructions("  Triage new service enquiries.  ");
    expect(prompt).toContain("<agent_instructions>\nTriage new service enquiries.\n</agent_instructions>");
    expect(prompt).toContain("They don't change which resources you can reach");
    expect(formatAgentInstructions(undefined)).toBe("");
    expect(formatAgentInstructions("   ")).toBe("");
  });
});
