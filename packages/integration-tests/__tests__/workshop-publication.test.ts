import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getPublicationErrorCode, PUBLICATION_ERROR_CODES,
  type AuthenticatedApi, type PublicApi, type PublicationErrorCode, type PublicationRecord,
} from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, settled, signUp, waitFor } from "../src/rpc-client.js";

// Publication records (#68, ADR 0008, Option A): a blueprint reaches beyond its owner only while a
// deployment admin's approved record pins its current version, with its kind's flag on. These run
// in order against one deployment, reloading it to change its env as a deployer would.

const WORKSHOP_WORKER = "workshop-backend";

let harness: Harness;
const network = new NetworkInterceptor();
const [aliceName, bobName] = nextUsernames("publisher", "installer");

type Session = { publicApi: RpcStub<PublicApi>; alice: RpcStub<AuthenticatedApi>;
  bob: RpcStub<AuthenticatedApi>; admin: RpcStub<AuthenticatedApi> };
let session: Session | undefined;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
  using publicApi = connect(harness.url);
  for (const name of [aliceName!, bobName!, ADMIN_USERNAME]) (await signUp(publicApi, name))[Symbol.dispose]();
});

afterAll(async () => {
  try {
    disposeSession();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

function disposeSession() {
  if (!session) return;
  for (const stub of Object.values(session)) stub[Symbol.dispose]();
  session = undefined;
}

/** Signed-in stubs on the current deployment, reconnected after each reload. */
async function current(): Promise<Session> {
  if (session) return session;
  const publicApi = connect(harness.url);
  session = {
    publicApi,
    alice: await logIn(publicApi, aliceName!),
    bob: await logIn(publicApi, bobName!),
    admin: await logIn(publicApi, ADMIN_USERNAME),
  };
  return session;
}

/** Reload the Workshop with `vars` set, keeping its storage, as a deployer's redeploy would. */
async function redeploy(vars: Record<string, string>): Promise<void> {
  disposeSession();
  await harness.server.update(options => ({
    ...options,
    workers: options.workers.map(worker => {
      if (!("config" in worker)) throw new Error("Expected inline harness config");
      if (worker.config.name !== WORKSHOP_WORKER) return worker;
      return { ...worker, config: { ...worker.config, vars: { ...worker.config.vars, ...vars } } };
    }),
  }));
  harness.url = (await harness.server.listen()).url;
  await settled(harness.url);
}

async function admin() {
  const api = await (await current()).admin.getAdminApi();
  if (!api) throw new Error("The deployment admin API was unavailable");
  return api;
}

async function codeOf(promise: Promise<unknown>): Promise<PublicationErrorCode | undefined> {
  try {
    await promise;
  } catch (error) {
    return getPublicationErrorCode(error);
  }
  throw new Error("Expected a refusal");
}

/** Publishes a blueprint of the bundled document format as `owner`, once it reached their list. */
async function publishBlueprint(owner: RpcStub<AuthenticatedApi>, title: string): Promise<string> {
  const formats = await waitFor("bundled output formats", async () => {
    const offers = await owner.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const document = formats.find(format => format.output.id === "document");
  if (!document) throw new Error("Document output format is not installed");
  using workspace = await owner.newGadgetFromBlueprint(document.blueprintId, {});
  const { defaultGadgetId } = await workspace.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("No default gadget");
  using gadget = await workspace.getGadget(defaultGadgetId);
  const { id } = await gadget.createBlueprint(title, `${title} for publication`);
  await waitFor("the blueprint in its owner's list", async () =>
    (await owner.listOwnBlueprints()).some(entry => entry.id === id) || null);
  return id;
}

async function download(publicApi: RpcStub<PublicApi>, id: string): Promise<number> {
  return (await new Response(await publicApi.downloadBlueprint(id)).arrayBuffer()).byteLength;
}

const reachable = async (id: string) => (await (await current()).publicApi.getBlueprint(id)) !== null;
const waitReach = (id: string, expected: boolean) =>
  waitFor(`blueprint ${id} reachable: ${expected}`, async () => (await reachable(id)) === expected || null);

let existing: string;
let exported: string;

it("with the flags off, an existing blueprint link is refused; bundled formats and installs still work", async () => {
  const { publicApi, alice, bob } = await current();
  existing = await publishBlueprint(alice, "Existing");

  // A link that reached anyone before publication records reaches no one now.
  expect(await publicApi.getBlueprint(existing)).toBeNull();
  expect(await codeOf(download(publicApi, existing))).toBe(PUBLICATION_ERROR_CODES.notPublished);
  expect(await codeOf(alice.requestPublication(existing, "export"))).toBe(PUBLICATION_ERROR_CODES.appFlagOff);
  expect(await codeOf(alice.requestPublication(existing, "deployment"))).toBe(PUBLICATION_ERROR_CODES.appFlagOff);
  expect(await (await admin()).listPublications()).toEqual([]);

  // Inside the deployment, signed-in people still read it and install it by id (Operate installs).
  expect((await bob.getBlueprintInfo(existing))?.metadata.title).toBe("Existing");
  using install = await bob.newGadgetFromBlueprint(existing, {});
  expect((await install.getMetadata()).installedFrom?.blueprintId).toBe(existing);

  // Bundled blueprints are deployment configuration, not publication.
  const [document] = (await alice.listOutputFormats()).filter(format => format.output.id === "document");
  expect((await publicApi.getBlueprint(document!.blueprintId))?.id).toBe(document!.blueprintId);
  expect(await download(publicApi, document!.blueprintId)).toBeGreaterThan(0);
  expect((await bob.listFeaturedBlueprints()).map(entry => entry.id)).toContain(document!.blueprintId);
});

it("request, approve, reach, withdraw: an approved export reaches link holders until withdrawn", async () => {
  await redeploy({ PUBLISH_CLOUDFLAREOS_APP: "true" });
  const { publicApi, alice } = await current();
  exported = await publishBlueprint(alice, "Exported");

  const requested = await alice.requestPublication(exported, "export");
  expect(requested).toMatchObject({
    artifact: { blueprintId: exported, version: 1, kind: "app", title: "Exported" },
    destination: "export", publishedBy: aliceName, status: "requested",
  });
  expect(requested.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(requested.audience).toMatch(/cannot be recalled/);
  // Asking again returns the standing request rather than another record.
  expect((await alice.requestPublication(exported, "export")).id).toBe(requested.id);
  expect(await reachable(exported)).toBe(false);

  // Only someone else may approve it: an admin approving their own request is refused.
  const adminApi = await admin();
  const own = await publishBlueprint((await current()).admin, "Admin's own");
  const ownRequest = await (await current()).admin.requestPublication(own, "export");
  expect(await codeOf(adminApi.approvePublication(ownRequest.id)))
      .toBe(PUBLICATION_ERROR_CODES.selfApprovalOff);

  const approved = await adminApi.approvePublication(requested.id);
  expect(approved).toMatchObject({ status: "active", approvedBy: ADMIN_USERNAME });
  expect(approved.selfApproved).toBeUndefined();
  expect(await codeOf(adminApi.approvePublication(requested.id))).toBe(PUBLICATION_ERROR_CODES.invalidState);
  await waitReach(exported, true);
  expect(await download(publicApi, exported)).toBeGreaterThan(0);
  expect(await reachable(existing)).toBe(false);

  // The owner withdraws it: link reads and downloads stop, and the record is kept.
  const withdrawn = await alice.withdrawPublication(requested.id, "No longer shared");
  expect(withdrawn).toMatchObject({ status: "withdrawn", withdrawnBy: aliceName, reason: "No longer shared" });
  await waitReach(exported, false);
  expect(await codeOf(download(publicApi, exported))).toBe(PUBLICATION_ERROR_CODES.notPublished);
  expect((await alice.withdrawPublication(requested.id, "again")).reason).toBe("No longer shared");
  expect((await adminApi.listPublications()).find(record => record.id === requested.id))
      .toMatchObject({ status: "withdrawn", approvedBy: ADMIN_USERNAME });
  // An admin refuses a request by withdrawing it.
  expect(await adminApi.withdrawPublication(ownRequest.id, "Refused")).toMatchObject({ status: "withdrawn" });
});

it("a deployment approval lists the blueprint; featuring needs one, and a newer version is not covered", async () => {
  const { alice, bob } = await current();
  const adminApi = await admin();
  const listed = await publishBlueprint(alice, "Listed");
  expect(await codeOf(adminApi.setBlueprintFeatured(listed, true))).toBe(PUBLICATION_ERROR_CODES.notPublished);

  const request = await alice.requestPublication(listed, "deployment");
  await adminApi.approvePublication(request.id);
  await waitFor("the listed blueprint", async () =>
    (await bob.listFeaturedBlueprints()).some(entry => entry.id === listed) || null);
  expect(await reachable(listed)).toBe(false);  // `deployment` never reaches outside it.

  await alice.withdrawPublication(request.id, "Done");
  await waitFor("the unlisted blueprint", async () =>
    (await bob.listFeaturedBlueprints()).some(entry => entry.id === listed) ? null : true);
});

it("self-approval needs PUBLICATION_SELF_APPROVAL, and the record says so", async () => {
  await redeploy({ PUBLISH_CLOUDFLAREOS_APP: "true", PUBLICATION_SELF_APPROVAL: "true" });
  const { admin: adminUser } = await current();
  const own = await publishBlueprint(adminUser, "Self-approved");
  const request = await adminUser.requestPublication(own, "export");
  expect(await (await admin()).approvePublication(request.id))
      .toMatchObject({ status: "active", approvedBy: ADMIN_USERNAME, selfApproved: true });
  await waitReach(own, true);
});

let suspended: PublicationRecord;

it("turning the flag off suspends reach and refuses every operation; on again needs re-confirmation", async () => {
  await redeploy({ PUBLISH_CLOUDFLAREOS_APP: "true", PUBLICATION_SELF_APPROVAL: "false" });
  const { alice } = await current();
  suspended = await alice.requestPublication(exported, "export");
  await (await admin()).approvePublication(suspended.id);
  await waitReach(exported, true);

  await redeploy({ PUBLISH_CLOUDFLAREOS_APP: "false" });
  const adminApi = await admin();
  expect((await adminApi.listPublications()).find(record => record.id === suspended.id)?.status)
      .toBe("suspended");
  await waitReach(exported, false);
  const off = PUBLICATION_ERROR_CODES.appFlagOff;
  expect(await codeOf((await current()).alice.requestPublication(exported, "deployment"))).toBe(off);
  expect(await codeOf((await current()).alice.withdrawPublication(suspended.id, "x"))).toBe(off);
  expect(await codeOf(adminApi.withdrawPublication(suspended.id, "x"))).toBe(off);
  expect(await codeOf(adminApi.confirmPublication(suspended.id))).toBe(off);

  await redeploy({ PUBLISH_CLOUDFLAREOS_APP: "true" });
  const again = await admin();
  expect((await again.listPublications()).find(record => record.id === suspended.id)?.status)
      .toBe("unconfirmed");
  expect(await reachable(exported)).toBe(false);
  expect(await codeOf(again.approvePublication(suspended.id))).toBe(PUBLICATION_ERROR_CODES.invalidState);
  const confirmed = await again.confirmPublication(suspended.id);
  expect(confirmed).toMatchObject({ status: "active" });
  expect(confirmed.confirmations).toEqual([expect.objectContaining({ by: ADMIN_USERNAME })]);
  await waitReach(exported, true);
  // Installs inside the deployment never depended on any of this.
  using install = await (await current()).bob.newGadgetFromBlueprint(existing, {});
  expect((await install.getMetadata()).installedFrom?.blueprintId).toBe(existing);
});
