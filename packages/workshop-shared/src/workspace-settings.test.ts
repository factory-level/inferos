// The settings registry (FAC-95): one shape at both levels, so a value's owner is where it sits.
import { describe, expect, test } from "vitest";
import { parseWorkspaceSettings, resolveWorkspaceSetting, resolveWorkspaceSettings, WORKSPACE_SETTING_KEYS } from "./workspace-settings";

describe("workspace settings", () => {
  test("take registry keys with their values, and detach them", () => {
    const input = { "baseUi.alerts": true, "chatPane.widgets": "none" };
    const parsed = parseWorkspaceSettings(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parseWorkspaceSettings({})).toEqual({});
  });

  test("refuse an unknown key, a value the key doesn't take, and anything that isn't an object", () => {
    expect(() => parseWorkspaceSettings({ "baseUi.modals": true })).toThrow('Unknown setting "baseUi.modals".');
    expect(() => parseWorkspaceSettings({ "baseUi.alerts": "yes" })).toThrow('Setting "baseUi.alerts" must be one of false, true.');
    expect(() => parseWorkspaceSettings({ "chatPane.widgets": "all" })).toThrow('Setting "chatPane.widgets" must be one of "console", "none".');
    for (const value of [null, [], "x", 1]) expect(() => parseWorkspaceSettings(value)).toThrow("Settings must be an object.");
  });

  // r2 round 1 on #395: only a plain record is settings. A Date, Map or other object with no
  // entries of its own must never read as "no settings", which would clear every one.
  test("refuse anything but a plain record, whatever entries it has", () => {
    class Settings { "baseUi.alerts" = true; }
    for (const value of [new Date(), new Map([["baseUi.alerts", true]]), new Set(), new Settings(), new Uint8Array(2),
      Object.create({ "baseUi.alerts": true }), /x/]) {
      expect(() => parseWorkspaceSettings(value)).toThrow("Settings must be an object.");
    }
    const bare = Object.create(null) as Record<string, unknown>;
    bare["baseUi.alerts"] = true;
    expect(parseWorkspaceSettings(bare)).toEqual({ "baseUi.alerts": true });
  });

  test("resolve to the page's override, else the workspace's value, else the default, naming the owner", () => {
    expect(resolveWorkspaceSetting("baseUi.alerts", { "baseUi.alerts": true }, { "baseUi.alerts": false }))
      .toMatchObject({ value: false, owner: "page" });
    expect(resolveWorkspaceSetting("baseUi.alerts", { "baseUi.alerts": true }, {})).toMatchObject({ value: true, owner: "workspace" });
    expect(resolveWorkspaceSetting("baseUi.alerts", {})).toMatchObject({ value: false, owner: "default" });
    expect(resolveWorkspaceSetting("chatPane.widgets", {})).toMatchObject({ value: "console", owner: "default" });
    expect(resolveWorkspaceSettings({}, {}).map(setting => setting.key)).toEqual(WORKSPACE_SETTING_KEYS);
    for (const setting of resolveWorkspaceSettings({})) expect(setting.permits).toContain("grants nothing");
  });
});
