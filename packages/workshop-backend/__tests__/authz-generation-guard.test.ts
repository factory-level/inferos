// A guard for the authorization generation (callable-widget contract §4.1, step C5a). Every
// authorization input is a typed-storage slot that makeOverseerStorage watches
// (watchAuthzCollection and watchAuthzSingleton in sharing.ts): a subscriber raises the generation
// inside the same transactionSync as each write that changes it, so a write site cannot forget its
// bump, however it reaches the slot (an alias, a helper, an index delete). What remains to guard is
// the ways around the subscribers, and that the watched set is complete:
// - every input in the Overseer schema raises it on a change and not on an identical rewrite;
// - no source names an input's storage key in a string (raw kv access), and makeOverseerStorage is
//   the only typed-storage view of the Overseer's storage (a second view would have no subscribers);
// - storage.deleteAll(), which bypasses subscribers, runs only in deleteSelf, which carries the
//   generation over it;
// - direct bumps are limited to the watchers, the access restart and deleteSelf.
// authz-generation.test.ts drives each input through its real code path in a real Overseer.

import { describe, expect, it } from "vitest";
import { makeOverseerStorage } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";

const SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as
    Record<string, string>;

type Storage = ReturnType<typeof makeOverseerStorage>;

// Each authorization input, with its storage key (the property name unless the schema renames it),
// a write that changes it, and an identical rewrite of what that write left.
const INPUTS: { input: string; storageKey: string; change: (s: Storage) => void;
                rewrite: (s: Storage) => void }[] = [
  {
    input: "collaborators",
    storageKey: "collaborators",
    change: s => s.collaborators.put({
      profile: { type: "user", id: "a", name: "a" },
      addedBy: [{ type: "user", sharer: "owner", created: new Date(0), role: "use" }],
    }),
    // Key order differs from the stored record; the comparison is per key.
    rewrite: s => s.collaborators.put({
      addedBy: [{ role: "use", created: new Date(0), sharer: "owner", type: "user" }],
      profile: { name: "a", id: "a", type: "user" },
    }),
  },
  {
    input: "shareKeys",
    storageKey: "shareKeys",
    change: s => s.shareKeys.put({ id: "k", created: new Date(0), createdBy: "owner", role: "use" }),
    // An absent note and an undefined one store the same thing.
    rewrite: s => s.shareKeys.put(
        { id: "k", created: new Date(0), createdBy: "owner", role: "use", note: undefined }),
  },
  {
    input: "observers",
    storageKey: "observers",
    change: s => s.observers.put(
        { profileId: "a", observerId: "obs", accountChoices: { 1: 10, 2: 20 } }),
    rewrite: s => s.observers.put(
        { profileId: "a", observerId: "obs", accountChoices: { 2: 20, 1: 10 } }),
  },
  {
    input: "ownerId",
    storageKey: "ownerId",
    change: s => s.ownerId.put("owner"),
    rewrite: s => s.ownerId.put("owner"),
  },
  {
    input: "containsRestrictedData",
    storageKey: "prohibitAllSharing",
    change: s => s.containsRestrictedData.put(true),
    rewrite: s => s.containsRestrictedData.put(true),
  },
  {
    input: "ownerInvitesOnly",
    storageKey: "ownerInvitesOnly",
    change: s => s.ownerInvitesOnly.put(true),
    rewrite: s => s.ownerInvitesOnly.put(true),
  },
  {
    input: "operateSession",
    storageKey: "operateSession",
    change: s => s.operateSession.put(true),
    rewrite: s => s.operateSession.put(true),
  },
];

// The generation's own key is guarded the same way: only the helper writes it.
const GUARDED_KEYS = [...INPUTS.map(i => i.storageKey), "authzGeneration"];

// Blanks comments and, unless `keepStrings`, string and template literals in one pass (keeping
// offsets and line structure), so a mention in a comment or message is not code.
function code(source: string, keepStrings = false): string {
  return source.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      match => keepStrings && !match.startsWith("/") ? match : match.replace(/[^\n]/g, " "));
}

// `<Class>.<method>` enclosing each line, by the same indentation convention as
// chat-taint-guard.test.ts: classes at column 0, methods at column 2.
function enclosingMethods(lines: string[]): string[] {
  let className = "(module)";
  let method = "(top level)";
  return lines.map(line => {
    let classMatch = /^(?:export\s+)?class\s+(\w+)/.exec(line);
    if (classMatch) { className = classMatch[1]; method = "(class body)"; }
    let methodMatch = /^ {2}(?:static\s+)?(?:async\s+)?(#?\w+)\s*(?:<[^>]*>)?\(/.exec(line);
    if (methodMatch && !/^ {2}(?:if|for|while|switch|return)\b/.test(line)) method = methodMatch[1];
    let functionMatch = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
    if (functionMatch) { className = "(module)"; method = functionMatch[1]; }
    return `${className}.${method}`;
  });
}

// `<file>:<Class>.<method>` for each line of `source` matching `pattern`.
function sitesOf(file: string, source: string, pattern: RegExp): string[] {
  let methods = enclosingMethods(source.split("\n"));
  return source.split("\n").flatMap((line, i) =>
    pattern.test(line) ? [`${file}:${methods[i]}`] : []);
}

function allSitesOf(pattern: RegExp, keepStrings = false): string[] {
  return Object.entries(SOURCES).flatMap(([path, source]) =>
    sitesOf(path.replace("../src/", ""), code(source, keepStrings), pattern)).toSorted();
}

// A string literal that is a guarded storage key, or one followed by `:` or `.` (a collection's
// record or index prefix).
const KEY_LITERAL = new RegExp(
    String.raw`["'\`](?:${GUARDED_KEYS.join("|")})(?:[:.][^"'\`]*)?["'\`]`);

describe("authorization inputs", () => {
  for (let { input, change, rewrite } of INPUTS) {
    it(`${input}: a change raises the generation and an identical rewrite does not`, () => {
      let storage = makeOverseerStorage(makeMockStorage());
      change(storage);
      expect(storage.authzGeneration.get()).toBe(1);
      rewrite(storage);
      expect(storage.authzGeneration.get()).toBe(1);
    });
  }

  it("deleting a collection record raises it; deleting a missing one does not", () => {
    let storage = makeOverseerStorage(makeMockStorage());
    storage.observers.put({ profileId: "a", observerId: "obs", accountChoices: {} });
    storage.observers.delete("a");
    storage.observers.delete("a");
    expect(storage.authzGeneration.get()).toBe(2);
  });

  it("are written nowhere by their raw storage key", () => {
    // The two reviewed literals: the schema's own rename, and a property name in a `Pick<>` type.
    expect(allSitesOf(KEY_LITERAL, true)).toEqual([
      "analytics.ts:(module).workspaceIds",
      "overseer.ts:(module).makeOverseerStorage",
    ]);
  });

  it("are reached through makeOverseerStorage's view alone", () => {
    // The other two views are the User DO's and AdminSettings' own storage.
    expect(allSitesOf(/\bcreateTypedStorage\(/)).toEqual([
      "admin-settings.ts:(module).makeAdminSettingsStorage",
      "overseer.ts:(module).makeOverseerStorage",
      "user.ts:(module).makeUserStorage",
    ]);
  });

  it("are deleted wholesale only by deleteSelf, which carries the generation over", () => {
    expect(allSitesOf(/\bstorage\.deleteAll\(/)).toEqual([
      "overseer.ts:OverseerClientInterface.deleteSelf",
    ]);
  });

  it("only the helper and deleteSelf's carry-over write the generation directly", () => {
    expect(allSitesOf(/\bauthzGeneration\.put\(/)).toEqual([
      "overseer.ts:OverseerClientInterface.deleteSelf",
      "sharing.ts:(module).bumpAuthzGeneration",
    ]);
  });

  it("only the watchers, the access restart and deleteSelf bump directly", () => {
    // Anything else is a storage write, which the subscribers already cover.
    expect(allSitesOf(/\bbumpAuthzGeneration\(/)).toEqual([
      "overseer.ts:OverseerClientInterface.deleteSelf",
      "overseer.ts:OverseerImpl.scheduleAccessRestart",
      "sharing.ts:(module).bumpAuthzGeneration",
      "sharing.ts:(module).bumpIfChanged",
      "sharing.ts:(module).watchAuthzCollection",
      "sharing.ts:(module).watchAuthzCollection",
    ]);
  });

  it("the access restart bumps before its first await", () => {
    let source = code(SOURCES["../src/overseer.ts"]);
    let body = /async scheduleAccessRestart\(reason: string\): Promise<void> \{([\s\S]*?)\n {2}\}/
        .exec(source)![1];
    expect(body.trim()).toMatch(/^bumpAuthzGeneration\(this\.storage\);\s*await /);
  });
});

describe("the scan itself", () => {
  // A synthetic source, so a scan that silently matched nothing could not pass the checks above.
  const SAMPLE = [
    "class Sample {",
    "  raw() {",
    "    this.ctx.storage.kv.put(\"collaborators:x\", record);",
    "  }",
    "  renamed() {",
    "    this.ctx.storage.kv.put('prohibitAllSharing', true);",
    "  }",
    "  fine() {",
    "    // this.ctx.storage.kv.put(\"ownerId\", x);",
    "    let s = \"ownerIdentity\";",
    "  }",
    "}",
  ].join("\n");

  it("finds a raw key in a string, and ignores comments and longer names", () => {
    expect(sitesOf("sample.ts", code(SAMPLE, true), KEY_LITERAL)).toEqual([
      "sample.ts:Sample.raw",
      "sample.ts:Sample.renamed",
    ]);
  });
});
