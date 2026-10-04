import { describe, expect, it } from "vitest";
import type { BlueprintBinding } from "@gadgets/workshop-shared/api";
import {
  blueprintVersionKeys, readBlueprintVersionBindings, writeBlueprintVersionBindings,
} from "../src/blueprint-archive.js";

// An in-memory stand-in for the content bucket: just enough of R2 to store and read back JSON.
function makeEnv() {
  let r2 = new Map<string, string>();
  let env = {
    BLUEPRINT_CONTENT: {
      put: async (key: string, value: string) => { r2.set(key, value); },
      get: async (key: string) => {
        let value = r2.get(key);
        return value === undefined ? null : { json: async () => JSON.parse(value) };
      },
    },
  } as unknown as Pick<Cloudflare.Env, "BLUEPRINT_CONTENT">;
  return { r2, env };
}

const DATA: BlueprintBinding = {
  type: "gatekeeper", title: "Data", description: "Where the numbers live.",
  gatekeeperName: "test", typeUrlPattern: "https://gadgets-test.example/things/*",
};

describe("a blueprint version's bindings", () => {
  it("are stored beside that version's content and read back per version", async () => {
    let { r2, env } = makeEnv();
    await writeBlueprintVersionBindings(env, "bp", 1, { DATA });
    await writeBlueprintVersionBindings(env, "bp", 2, {});

    expect(await readBlueprintVersionBindings(env, "bp", 1)).toEqual({ DATA });
    expect(await readBlueprintVersionBindings(env, "bp", 2)).toEqual({});
    // Deleting a version's keys removes its binding list along with its content.
    expect(blueprintVersionKeys("bp", 1)).toEqual(["bp/1", "bp/1.bindings"]);
    expect([...r2.keys()]).toEqual(["bp/1.bindings", "bp/2.bindings"]);
  });

  it("are absent for a version stored without them, so callers use the current ones", async () => {
    let { env } = makeEnv();
    expect(await readBlueprintVersionBindings(env, "bp", 1)).toBeNull();
  });
});
