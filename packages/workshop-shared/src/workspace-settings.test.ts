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
    // An inherited key doesn't count as one of its own.
    expect(() => parseWorkspaceSettings(Object.create({ "baseUi.alerts": true }))).not.toThrow();
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
