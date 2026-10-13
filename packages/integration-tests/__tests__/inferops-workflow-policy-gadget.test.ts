// The bundled `inferops.workflow-policy` gadget, installed in the real Workshop over the real InferOps
// gatekeeper on its demo data (MVP-18, slice 07). The binding is the merged private, read-only
// `project/workflow` resource (#264), switched on for this harness only; its answer comes from the
// gatekeeper's own mock (`src/fixtures/demo-workflow.json`, the synthetic DEMO policy with a canary in
// every field the projection leaves out). No InferOps provider, database, seed or credential is
// involved: this is the gadget over the existing binding, not a provider proof (that is
// `inferops-workflow-policy-live.test.ts`).
//
// What it proves:
// - the installed gadget's Durable Object returns exactly what the binding itself reads, with none
//   of the omitted fields' canaries;
// - an unconfigured project reads as unconfigured;
// - the gadget is private: a collaborator holding their own InferOps account cannot open it.
// The switch-off (`disabled`) state is covered by the blueprint's unit tests and the gatekeeper's own
// suite (#264); this harness keeps the switch on throughout.
// The operate-chat exclusion of the same binding is `operate-chat-no-workflow-policy.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type {
  InferOpsWorkflowPolicySession, WorkflowPolicyHead,
} from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import type { LoadPolicyResult } from "../../bundled-blueprints/blueprints/inferops-workflow-policy/files/lib/protocol.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder, signUp, stubFor,
  waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const VENDOR = "inferops";
const DEMO_POLICY = "inferops://demo.local/project/workflow/DEMO";
const DEMO_UNCONFIGURED = "inferops://demo.local/project/workflow/ENG";
/** Values the demo fixture carries only in fields the projection leaves out. */
const CANARIES = ["canary", "c0a9e700-0000-4000-8000-0000000a9e71", "c0b1b500-0000-4000-8000-0000000b1b51"];

const network = new NetworkInterceptor();
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    enableGadgetExecution: true,
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = { ...config.vars, INFEROPS_WORKFLOW_POLICY_ENABLED: "true" };
      },
    }],
  });
}, 120_000);

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function person(label: string): Promise<{ api: RpcStub<AuthenticatedApi>; account: ConnectedAccount; username: string }> {
  const [username] = nextUsernames(label);
  const api = await signUp(connect(harness.url), username!);
  await api.provisionAmbientAccount(VENDOR);
  const account = await waitFor(`the ${label}'s demo InferOps account`, async () =>
    (await listConnectedAccounts(api)).find(entry => entry.vendorId === VENDOR) ?? null);
  return { api, account, username: username! };
}

/** The binding's own read, outside any gadget: the authority the gadget's answer is checked against. */
async function direct(api: RpcStub<AuthenticatedApi>, account: ConnectedAccount, url: string): Promise<WorkflowPolicyHead> {
  using ws = await api.newGadget();
  using connection = await ws.newGatekeeper(account.id, url);
  if (!connection) throw new Error("No connection");
  using session = await connection.openSession() as unknown as InferOpsWorkflowPolicySession & Disposable;
  return session.readWorkflowPolicy();
}

/** Installs the gadget bound to `url` and loads it through its own Durable Object. */
async function install(api: RpcStub<AuthenticatedApi>, account: ConnectedAccount, url: string) {
  const installed = await api.newGadgetFromBlueprint("inferops.workflow-policy", {
    policy: { type: "gatekeeper", accountId: account.id, resourceUrl: url },
  });
  const { defaultGadgetId, id } = await installed.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
  using gadget = await installed.getGadget(defaultGadgetId);
  using facet = await gadget.connectToGadget() as RpcStub<{ loadPolicy(): Promise<LoadPolicyResult> }>;
  return { installed, workspaceId: id, result: await facet.loadPolicy() };
}

describe("the installed InferOps Workflow policy gadget (demo data, real Workshop)", () => {
  it("loads exactly the binding's own read, with no omitted field's canary", async () => {
    const { api, account } = await person("wfpgadget");
    const expected = await direct(api, account, DEMO_POLICY);
    const { installed, result } = await install(api, account, DEMO_POLICY);
    using _ = installed;
    expect(result).toEqual({ ok: true, head: expected });
    expect(expected).toMatchObject({ configured: true, revision: "3" });
    const shown = JSON.stringify(result);
    for (const canary of CANARIES) expect(shown).not.toContain(canary);
    for (const key of ['"reason"', '"agents"', '"publishedBy"']) expect(shown).not.toContain(key);
  });

  it("loads an unconfigured project as InferOps reports it", async () => {
    const { api, account } = await person("wfpunconf");
    const { installed, result } = await install(api, account, DEMO_UNCONFIGURED);
    using _ = installed;
    expect(result).toEqual({ ok: true, head: await direct(api, account, DEMO_UNCONFIGURED) });
    expect(result).toMatchObject({ ok: true, head: { configured: false, revision: "0", policy: null } });
  });

  it("is private: a collaborator with their own InferOps account cannot open it", async () => {
    const owner = await person("wfpowner");
    const { installed, workspaceId, result } = await install(owner.api, owner.account, DEMO_POLICY);
    using _ = installed;
    expect(result.ok).toBe(true);
    const collaborator = await person("wfpcollab");
    expect(await installed.addCollaborator(collaborator.username, "build")).toBeTruthy();
    const asked = new ObserverConfigRecorder().alwaysChoose(collaborator.account.id, MAX_OBSERVER_PROMPTS);
    using callback = stubFor(asked);
    const opened = await collaborator.api.openGadget(workspaceId, undefined, callback)
      .then(() => "", (error: unknown) => String(error));
    expect(opened).toMatch(/could not confirm/i);
  });
});
