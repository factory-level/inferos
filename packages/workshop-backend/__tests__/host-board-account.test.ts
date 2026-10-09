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
