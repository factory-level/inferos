// The user DO's account provenance for host boards (`putAccount`, `accountProvenance`): a same-id
// replacement gets a new incarnation, every mutation a new epoch. Synthetic records over an
// in-memory stand-in for the user DO's storage.
import { describe, expect, it } from "vitest";
import { accountProvenance, putAccount } from "../src/user.js";

function storage() {
  let records = new Map<number, any>();
  let epoch = 0;
  return {
    records,
    connectedAccounts: {
      get: (id: number) => records.get(id),
      put: (record: any) => { records.set(record.id, { ...record }); },
    },
    accountEpoch: { get: () => epoch, put: (value: number) => { epoch = value; } },
  } as any;
}

const record = (id: number) => ({ id, vendorId: "inferops", account: {} as never, description: {} as never });

describe("host-board account provenance", () => {
  it("gives a same-id replacement a new incarnation, and a mutation only a new epoch", () => {
    let store = storage();
    putAccount(store, record(4), "replaced");
    let first = accountProvenance(store, 4)!;
    expect(first).toMatchObject({ accountId: 4, vendorId: "inferops", epoch: 1 });
    // Signing in again points the same id at a fresh grant (linkConnectedAccountFromLogin).
    putAccount(store, { ...store.records.get(4) }, "replaced");
    let replaced = accountProvenance(store, 4)!;
    expect(replaced.incarnation).not.toBe(first.incarnation);
    expect(replaced.epoch).toBe(2);
    // An expiry or a reconnect keeps the account stub.
    putAccount(store, { ...store.records.get(4) }, "mutated");
    expect(accountProvenance(store, 4)).toEqual({ ...replaced, epoch: 3 });
  });

  it("reads a record from before provenance existed as its first incarnation, and a missing one as null", () => {
    let store = storage();
    store.records.set(3, record(3));
    expect(accountProvenance(store, 3)).toEqual({ accountId: 3, vendorId: "inferops", incarnation: "initial", epoch: 0 });
    expect(accountProvenance(store, 9)).toBeNull();
  });
});

describe("restoring an account's credentials", () => {
  // The real UserDurableObject.markCredentialsRestored over the in-memory storage, with the
  // account's describe() held so another mutation can land while it is in flight.
  async function restoring(concurrent: (user: any, store: any) => Promise<void> | void) {
    let { UserDurableObject } = await import("../src/user.js");
    let store = storage();
    let release!: () => void;
    let described = new Promise<void>(resolve => { release = resolve; });
    let account = {
      async describe() { await described; return { title: "restored (synthetic)" }; },
      async revoke() {},
    };
    let user = Object.create(UserDurableObject.prototype);
    Object.assign(user, { env: {}, storage: { ...store, cloudflareBilling: { put() {} },
      connectedAccounts: { ...store.connectedAccounts, delete: (id: number) => { store.records.delete(id); } } } });
    putAccount(store, { ...record(4), account, credentialsExpired: true }, "replaced");
    let restore = user.markCredentialsRestored(4);
    await new Promise(resolve => setTimeout(resolve, 0));
    let afterRestore = accountProvenance(store, 4);
    await concurrent(user, store);
    let concurrentState = store.records.get(4) && { ...store.records.get(4) };
    release();
    await restore;
    return { store, afterRestore, concurrentState };
  }

  it("keeps a concurrent expiry", async () => {
    let { store, concurrentState } = await restoring(user => user.markCredentialsExpired(4));
    expect(store.records.get(4).credentialsExpired).toBe(true);
    expect(store.records.get(4).epoch).toBe(concurrentState.epoch);
  });

  it("keeps a concurrent same-id replacement", async () => {
    let { store, concurrentState } = await restoring((_, s) =>
      putAccount(s, { ...s.records.get(4), account: { async describe() { return {}; } } }, "replaced"));
    expect(store.records.get(4).incarnation).toBe(concurrentState.incarnation);
    expect(store.records.get(4).epoch).toBe(concurrentState.epoch);
    expect(store.records.get(4).description).toEqual(concurrentState.description);
  });

  it("does not resurrect a concurrently disconnected account", async () => {
    let { store } = await restoring(user => user.disconnectAccount(4));
    expect(store.records.has(4)).toBe(false);
  });

  it("refreshes only the description when nothing else changed", async () => {
    let { store, afterRestore } = await restoring(() => {});
    expect(accountProvenance(store, 4)).toEqual(afterRestore);
    expect(store.records.get(4).description).toEqual({ title: "restored (synthetic)" });
    expect(store.records.get(4).credentialsExpired).toBe(false);
  });
});
