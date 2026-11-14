// Test worker: the production entrypoints, plus a fake Workshop callback and the hooks a test
// drives an attempt through. Under the capnweb-validate vite plugin, decorated WorkerEntrypoint
// exports are not registered in `ctx.exports` (see gatekeeper-gitlab's workerd worker), so the
// account and the vendor are re-exported here as undecorated subclasses with the same behaviour.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ConnectHandoff, GatekeeperConnectCallback, GatekeeperUser, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GatekeeperVendor as RealVendor, InferLabAccount as RealAccount,
} from "../src/worker.js";

export { default } from "../src/worker.js";
export { SignInAttempt } from "../src/worker.js";

/** The sign-in account, reachable through `ctx.exports` in tests. */
export class InferLabAccount extends RealAccount {}

/** The vendor, reachable through `ctx.exports` in tests. */
export class GatekeeperVendor extends RealVendor {}

/** What the fake Workshop saw of the account a sign-in handed it. */
export type Received = {
  subject: { issuer: string; subject: string } | null;
  email: string | null;
  resources: number;
  /** For each access request, the error it was refused with, or "allowed". */
  refused: Record<string, string>;
};

const received = new Map<string, Received>();

const refusal = async (call: () => Promise<unknown>) => {
  try {
    await call();
    return "allowed";
  } catch (error) {
    return (error as Error).message;
  }
};

/** The Workshop's side: records what the account answers and probes everything it refuses. */
export class FakeCallback extends WorkerEntrypoint<Cloudflare.Env, { label: string }>
    implements Pick<GatekeeperConnectCallback, "complete"> {
  async complete(account: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    received.set(this.ctx.props.label, {
      subject: await (account as unknown as Fetcher<RealAccount>).getAuthenticatedSubject(),
      email: await account.getAuthenticatedEmail(),
      resources: (await account.getSupportedResources()).length,
      refused: {
        getVerifier: await refusal(() => account.getVerifier()),
        ensureResources: await refusal(() => account.ensureResources(["*"])),
        getGatekeeperClassFor: await refusal(() => account.getGatekeeperClassFor("inferops://x")),
        reconnect: await refusal(() => account.reconnect()),
      },
    });
    return { targetOrigin: "http://localhost:8787", ticket: "t".repeat(64) };
  }
}

/** `ctx.exports` as this test worker has it: the generated types know only the production worker. */
type TestExports = { FakeCallback(options: { props: { label: string } }): Fetcher<FakeCallback> };

/** Starts attempts and reads back what the fake Workshop received, from inside the isolate. */
export class TestHooks extends DurableObject<Cloudflare.Env> {
  async startAttempt(attemptId: string, nonce: string, label: string): Promise<void> {
    const callback = (this.ctx.exports as unknown as TestExports).FakeCallback({ props: { label } });
    const stub = this.env.SIGN_IN_ATTEMPT.get(this.env.SIGN_IN_ATTEMPT.idFromString(attemptId));
    await stub.start(callback as unknown as Fetcher<GatekeeperConnectCallback>, nonce);
  }

  async received(label: string): Promise<Received | null> {
    return received.get(label) ?? null;
  }

  /** The vendor as the Workshop reaches it: describe, list and connect. */
  async vendor(scopes: "auth" | "full" | undefined, env?: Partial<Cloudflare.Env>)
      : Promise<{ description: VendorDescription; resources: number; connect: string }> {
    const vendor = new GatekeeperVendor(this.ctx as unknown as ExecutionContext, { ...this.env, ...env });
    const callback = (this.ctx.exports as unknown as TestExports).FakeCallback({ props: { label: "vendor" } });
    return {
      description: await vendor.describe(),
      resources: (await vendor.getSupportedResources()).length,
      connect: await refusal(async () => {
        const { url } = await vendor.connectAccount(
          callback as unknown as Fetcher<GatekeeperConnectCallback>, scopes ? { scopes } : undefined);
        return url;
      }),
    };
  }
}
