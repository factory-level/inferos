import { describe, expect, it } from "vitest";
import { WORKSPACE_KINDS } from "@gadgets/workshop-shared/api";
import {
  checkWorkspaceKind, workspaceKindAllowsFile, workspaceKindContract, workspaceKindStarter,
} from "@gadgets/workshop-shared/workspace-kind";

const codes = (...args: Parameters<typeof checkWorkspaceKind>) =>
  checkWorkspaceKind(...args).map(violation => violation.code);

describe("workspace kind contract", () => {
  it("leaves an app as the default build: no contract and no starter", () => {
    expect(workspaceKindContract("app")).toBeNull();
    expect(workspaceKindStarter("app")).toBeNull();
  });

  it("gives every other kind a contract and a starter that fits it", () => {
    for (const kind of WORKSPACE_KINDS.filter(kind => kind !== "app")) {
      expect(workspaceKindContract(kind)).toContain("This workspace's kind is");
      const starter = workspaceKindStarter(kind)!;
      expect(checkWorkspaceKind(kind, Object.keys(starter))).toEqual([]);
      for (const filename of Object.keys(starter)) {
        expect(workspaceKindAllowsFile(kind, filename)).toBe(true);
      }
    }
  });

  it("requires a UI of an app or widget, and a server of a widget or workflow", () => {
    expect(codes("app", ["server.js"])).toEqual(["missingUi"]);
    expect(codes("app", ["client.js"])).toEqual([]);
    expect(codes("widget", [])).toEqual(["missingUi", "missingServer"]);
    expect(codes("workflow", [])).toEqual(["missingServer"]);
  });

  it("allows a workflow no UI", () => {
    expect(codes("workflow", ["server.js", "client.js"])).toEqual(["unexpectedUi"]);
    expect(workspaceKindAllowsFile("workflow", "client.js")).toBe(false);
    expect(workspaceKindAllowsFile("workflow", "lib/client.js")).toBe(true);
    expect(workspaceKindAllowsFile("widget", "client.js")).toBe(true);
  });
});
