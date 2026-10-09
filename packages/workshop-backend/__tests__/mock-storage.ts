// oxlint-disable-next-line typescript/triple-slash-reference -- Wrangler declarations are globals.
/// <reference path="../worker-configuration.d.ts" />

/**
 * Map-backed mock DurableObjectStorage for unit tests, mirroring
 * packages/typed-storage/__tests__/index.test.ts. structuredClone on every read/write mimics the
 * serialization boundary of real DO storage, and the iterator-invalidation check mirrors the real
 * kv.list() contract.
 *
 * transactionSync rolls back through an undo journal rather than by cloning the whole map, so a
 * transaction costs O(keys it touches) and seeding n records stays O(n), not O(n^2). Each
 * transaction records a touched key's prior value (or ABSENT) the first time it writes that key;
 * a throw restores those, and a success folds the entries into the enclosing transaction's
 * journal (keeping the outer's earlier ones), so an outer failure still undoes a nested commit.
 * Saving the prior value by reference is safe because a stored value is a private clone that
 * nothing mutates: put stores a fresh clone and every read hands out another.
 */
const ABSENT = Symbol("absent");

type UndoJournal = Map<string, unknown>;

export function makeMockStorage(): DurableObjectStorage {
  let map = new Map<string, any>();
  let currentList: object | undefined;
  let journal: UndoJournal | undefined;

  let remember = (key: string) => {
    if (journal !== undefined && !journal.has(key)) {
      journal.set(key, map.has(key) ? map.get(key) : ABSENT);
    }
  };

  return <DurableObjectStorage>{
    transactionSync<T>(f: () => T): T {
      let outer = journal;
      let own: UndoJournal = new Map();
      journal = own;
      try {
        let result = f();
        journal = outer;
        if (outer !== undefined) {
          for (let [key, prior] of own) {
            if (!outer.has(key)) outer.set(key, prior);
          }
        }
        return result;
      } catch (err) {
        journal = outer;
        for (let [key, prior] of own) {
          if (prior === ABSENT) map.delete(key);
          else map.set(key, prior);
        }
        throw err;
      }
    },
    kv: {
      get<T>(key: string): T | undefined {
        return structuredClone(map.get(key));
      },
      *list<T = unknown>(options: DurableObjectListOptions = {}): Iterable<[string, T]> {
        let results: { key: string; value: any }[] = [];
        for (let [key, value] of map) {
          if ((options.prefix === undefined || key.startsWith(options.prefix))
              && (options.start === undefined || key >= options.start)
              && (options.startAfter === undefined || key > options.startAfter)
              && (options.end === undefined || key < options.end)) {
            results.push({ key, value });
          }
        }
        results.sort((a, b) => {
          if (a.key < b.key) return options.reverse ? 1 : -1;
          if (a.key > b.key) return options.reverse ? -1 : 1;
          return 0;
        });
        if (options.limit !== undefined) {
          results = results.slice(0, options.limit);
        }
        let me = {};
        currentList = me;
        for (let item of results) {
          yield [item.key, structuredClone(item.value)];
          if (currentList !== me) {
            throw new Error("kv.list() iterator was invalidated by a concurrent kv.list().");
          }
        }
        currentList = undefined;
      },
      put<T>(key: string, value: T): void {
        let stored = structuredClone(value);
        remember(key);
        map.set(key, stored);
      },
      delete(key: string): boolean {
        remember(key);
        return map.delete(key);
      },
    },
  };
}
