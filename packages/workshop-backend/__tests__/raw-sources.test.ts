// The guard tests (authz-generation-guard, chat-taint-guard) scan `src/` through `?raw` imports and
// rely on reading each file as it is on disk. capnweb-validate would otherwise edit those string
// modules too (see rpcValidation in vitest.config.ts), splicing its decorator calls into the text.

import { describe, expect, it } from "vitest";

declare const __WORKSHOP_SOURCE_LENGTHS__: Record<string, number>;

const SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as
    Record<string, string>;

describe("?raw sources", () => {
  it("are every src file, untransformed and at its length on disk", () => {
    expect(Object.keys(SOURCES).toSorted()).toEqual(Object.keys(__WORKSHOP_SOURCE_LENGTHS__).toSorted());
    let changed = Object.entries(SOURCES).filter(([path, text]) =>
      text.length !== __WORKSHOP_SOURCE_LENGTHS__[path] || /__validateRpcClass|__capnweb_validate_|\b__cw\./.test(text));
    expect(changed.map(([path]) => path)).toEqual([]);
  });

  it("include the files the transform decorates, so the check above covers them", () => {
    let decorated = Object.entries(SOURCES).filter(([, text]) => /^@validateRpc\(\)/m.test(text)).map(([path]) => path);
    expect(decorated).toEqual(expect.arrayContaining(["../src/overseer.ts", "../src/server.ts"]));
  });
});
