import { describe, expect, it } from "vitest";
import { makeMockStorage } from "./mock-storage";

/**
 * The mock's previous transaction implementation, which cloned the whole map on every
 * transaction. Its transactionSync, get, put and delete are kept verbatim (list is reduced to a
 * sorted dump) as the reference the undo-journal mock must match.
 */
function makeWholeMapCloneStorage(): DurableObjectStorage {
  let map = new Map<string, any>();
  return <DurableObjectStorage>{
    transactionSync<T>(f: () => T): T {
      let oldMap = structuredClone(map);
      try {
        return f();
      } catch (err) {
        map = oldMap;
        throw err;
      }
    },
    kv: {
      get<T>(key: string): T | undefined {
        return structuredClone(map.get(key));
      },
      *list<T = unknown>(): Iterable<[string, T]> {
        let entries = [...map].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (let [key, value] of entries) yield [key, structuredClone(value)];
      },
      put<T>(key: string, value: T): void {
        map.set(key, structuredClone(value));
      },
      delete(key: string): boolean {
        return map.delete(key);
      },
    },
  };
}

class Abort extends Error {}

function contents(storage: DurableObjectStorage): [string, unknown][] {
  return [...storage.kv.list()];
}

function seeded(): DurableObjectStorage {
  let storage = makeMockStorage();
  storage.kv.put("kept", { n: 1 });
  storage.kv.put("overwritten", { n: 2 });
  storage.kv.put("deleted", { n: 3 });
  return storage;
}

function abort(storage: DurableObjectStorage, f: () => void): void {
  expect(() => storage.transactionSync(() => { f(); throw new Abort(); })).toThrow(Abort);
}

const SEEDED: [string, unknown][] = [
  ["deleted", { n: 3 }], ["kept", { n: 1 }], ["overwritten", { n: 2 }],
];

describe("makeMockStorage transactionSync", () => {
  it("rolls back an overwritten key, a new key and a deleted key", () => {
    let storage = seeded();
    abort(storage, () => {
      storage.kv.put("overwritten", { n: 20 });
      storage.kv.put("added", { n: 4 });
      expect(storage.kv.delete("deleted")).toBe(true);
      expect(contents(storage)).toEqual([
        ["added", { n: 4 }], ["kept", { n: 1 }], ["overwritten", { n: 20 }],
      ]);
    });
    expect(contents(storage)).toEqual(SEEDED);
  });

  it("restores the original value of a key touched repeatedly in one transaction", () => {
    let storage = seeded();
    abort(storage, () => {
      storage.kv.put("overwritten", { n: 20 });
      storage.kv.delete("overwritten");
      storage.kv.put("overwritten", { n: 21 });
      storage.kv.put("added", { n: 4 });
      storage.kv.delete("added");
      storage.kv.put("added", { n: 5 });
      storage.kv.delete("deleted");
      storage.kv.put("deleted", { n: 30 });
    });
    expect(contents(storage)).toEqual(SEEDED);
  });

  it("commits writes and returns the callback's result", () => {
    let storage = seeded();
    let result = storage.transactionSync(() => {
      storage.kv.put("overwritten", { n: 20 });
      storage.kv.delete("deleted");
      return "done";
    });
    expect(result).toBe("done");
    expect(contents(storage)).toEqual([["kept", { n: 1 }], ["overwritten", { n: 20 }]]);
  });

  it("undoes only a failed inner transaction that the outer one catches, then commits", () => {
    let storage = seeded();
    storage.transactionSync(() => {
      storage.kv.put("outer", { n: 10 });
      storage.kv.put("overwritten", { n: 20 });
      abort(storage, () => {
        storage.kv.put("inner", { n: 11 });
        storage.kv.put("overwritten", { n: 21 });
        storage.kv.put("kept", { n: 22 });
        storage.kv.delete("deleted");
      });
      expect(storage.kv.get("overwritten")).toEqual({ n: 20 });
      storage.kv.put("after", { n: 12 });
    });
    expect(contents(storage)).toEqual([
      ["after", { n: 12 }], ["deleted", { n: 3 }], ["kept", { n: 1 }], ["outer", { n: 10 }],
      ["overwritten", { n: 20 }],
    ]);
  });

  it("undoes a nested transaction that succeeded when the outer one then fails", () => {
    let storage = seeded();
    abort(storage, () => {
      storage.kv.put("overwritten", { n: 20 });
      storage.transactionSync(() => {
        storage.kv.put("overwritten", { n: 21 });
        storage.kv.put("inner", { n: 11 });
        storage.kv.delete("deleted");
        storage.transactionSync(() => storage.kv.put("kept", { n: 22 }));
      });
    });
    expect(contents(storage)).toEqual(SEEDED);
  });
});

describe("makeMockStorage value isolation", () => {
  it("is unaffected by mutating a value after put or after get", () => {
    let storage = makeMockStorage();
    let value = { tags: ["a"] };
    storage.kv.put("k", value);
    value.tags.push("put-alias");
    storage.kv.get<{ tags: string[] }>("k")!.tags.push("get-alias");
    expect(storage.kv.get("k")).toEqual({ tags: ["a"] });
  });

  it("restores an unaliased prior value after a rollback", () => {
    let storage = makeMockStorage();
    let value = { tags: ["a"] };
    storage.kv.put("k", value);
    abort(storage, () => {
      storage.kv.get<{ tags: string[] }>("k")!.tags.push("get-alias");
      storage.kv.put("k", { tags: ["b"] });
      value.tags.push("put-alias");
    });
    let restored = storage.kv.get<{ tags: string[] }>("k")!;
    expect(restored).toEqual({ tags: ["a"] });
    restored.tags.push("after-rollback");
    value.tags.push("after-rollback");
    expect(storage.kv.get("k")).toEqual({ tags: ["a"] });
  });
});

type Op =
  | { kind: "put"; key: string; value: unknown }
  | { kind: "delete"; key: string }
  | { kind: "transaction"; ops: Op[]; fails: boolean };

/** Applies `ops` to `storage`, recording every observable result. */
function run(storage: DurableObjectStorage, ops: Op[], log: unknown[]): void {
  for (let op of ops) {
    if (op.kind === "put") {
      storage.kv.put(op.key, op.value);
    } else if (op.kind === "delete") {
      log.push(storage.kv.delete(op.key));
    } else {
      // A failing transaction is caught just outside it, so its enclosing transaction carries
      // on; a failure after nested commits is what exercises undoing a nested success.
      try {
        log.push(storage.transactionSync(() => {
          run(storage, op.ops, log);
          if (op.fails) throw new Abort();
          return op.ops.length;
        }));
      } catch (err) {
        if (!(err instanceof Abort)) throw err;
        log.push("aborted");
      }
    }
    log.push(contents(storage));
  }
}

/** A deterministic script of puts, deletes and nested transactions over a few keys. */
function script(seed: number, depth: number, length: number): Op[] {
  let state = seed;
  let next = (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  let build = (level: number, count: number): Op[] => {
    let ops: Op[] = [];
    for (let i = 0; i < count; i++) {
      let key = `k${next(5)}`;
      let roll = next(10);
      if (roll < 5) {
        ops.push({ kind: "put", key, value: { seed, level, i, list: [next(100)] } });
      } else if (roll < 7 || level >= depth) {
        ops.push({ kind: "delete", key });
      } else {
        let fails = next(3) === 0;
        ops.push({ kind: "transaction", ops: build(level + 1, 1 + next(5)), fails });
      }
    }
    return ops;
  };
  return build(0, length);
}

describe("makeMockStorage against the whole-map-clone reference", () => {
  it("produces the same results and contents for the same operation scripts", () => {
    for (let seed = 1; seed <= 50; seed++) {
      let ops = script(seed, 3, 12);
      let actualLog: unknown[] = [];
      let expectedLog: unknown[] = [];
      run(makeMockStorage(), ops, actualLog);
      run(makeWholeMapCloneStorage(), ops, expectedLog);
      expect(actualLog, `seed ${seed}`).toEqual(expectedLog);
    }
  });
});
