import { describe, expect, it } from "vitest";
import type { BlueprintInstall } from "@gadgets/workshop-shared/api";
import {
  blueprintVersionMetadata, checkDataContract, sanitizeDataContract,
} from "../src/blueprint-archive.js";
import { assertUpgradeCompatible } from "../src/blueprint-install.js";

const INSTALLED: BlueprintInstall = { blueprintId: "bp", version: 1, kind: "app", dataContract: 3 };

describe("a blueprint version's data contract", () => {
  it("is stored with the version's content only when declared", () => {
    expect(blueprintVersionMetadata("widget", 3)).toEqual({ kind: "widget", dataContract: "3" });
    expect(blueprintVersionMetadata(undefined, undefined)).toEqual({ kind: "app" });
  });

  it("is a non-negative integer, and anything else is undeclared or refused", () => {
    expect(sanitizeDataContract(0)).toBe(0);
    for (let value of [-1, 1.5, "2", Number.NaN, 2 ** 60, null]) {
      expect(sanitizeDataContract(value)).toBeUndefined();
    }
    expect(checkDataContract(undefined)).toBeUndefined();
    expect(() => checkDataContract(-1)).toThrow(/non-negative integer/);
  });
});

describe("an upgrade between versions", () => {
  it("is allowed only between equal declared contracts of the same kind", () => {
    expect(() => assertUpgradeCompatible(INSTALLED, 2, "app", 3)).not.toThrow();
    expect(() => assertUpgradeCompatible(INSTALLED, 2, "app", 4)).toThrow(/version 2 needs migration/);
    expect(() => assertUpgradeCompatible(INSTALLED, 2, "app", undefined))
      .toThrow(/version 2 declares no data contract/);
    expect(() => assertUpgradeCompatible({ ...INSTALLED, dataContract: undefined }, 2, "app", 3))
      .toThrow(/installed version 1 declares no data contract/);
    expect(() => assertUpgradeCompatible(INSTALLED, 2, "widget", 3)).toThrow(/cannot change the install's kind/);
  });
});
