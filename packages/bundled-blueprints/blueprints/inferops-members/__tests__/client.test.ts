// The Members client in jsdom, against a fake `gadget` whose answers the test releases one by one:
// what each state shows, that names and values are text, that it is read-only, and that only the
// latest load is drawn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadMembersResult } from "../files/lib/protocol.ts";

const MARKUP = `<img src="x" onerror="globalThis.pwned = true">`;

const ready = (workspaceName: string, names: string[]): LoadMembersResult => ({
  ok: true,
  workspace: { workspaceId: "00000000-0000-4000-8000-0000000000d0", workspaceName, product: "inferops" },
  members: names.map((name, i) => ({
    principalId: `p${i}`, type: i === 1 ? "service_account" : "user", name,
    role: i === 0 ? "owner" : "viewer", deniedPermissions: i === 1 ? ["billing:*"] : [],
  })),
});

/** Loads the client; each `loadMembers` call waits until the test answers it. */
async function start(...answers: LoadMembersResult[]) {
  const pending: Array<(result: LoadMembersResult) => void> = [];
  (globalThis as { gadget?: unknown }).gadget = {
    loadMembers: () => new Promise<LoadMembersResult>(resolve => pending.push(resolve)),
  };
  const loaded = import("../files/client.ts");
  await vi.waitFor(() => expect(pending.length).toBe(1));
  pending.shift()!(answers[0]!);
  await loaded;
  return {
    answer: async (result: LoadMembersResult) => {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!(result);
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    pending,
  };
}

const text = () => document.querySelector("main")!.textContent ?? "";
const reload = () => (document.querySelector("header button") as HTMLButtonElement).click();

beforeEach(() => {
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
});
afterEach(() => {
  delete (globalThis as { gadget?: unknown }).gadget;
});

describe("InferOps Members client", () => {
  it("draws the workspace and its members, as text, with no email and no controls but Reload", async () => {
    await start(ready("Demo Operations", [MARKUP, "demo-agent"]));
    expect(document.querySelector("h1")!.textContent).toBe("Demo Operations");
    expect(document.querySelector("header .meta")!.textContent)
      .toBe("InferOps workspace 00000000-0000-4000-8000-0000000000d0");
    expect([...document.querySelectorAll("th")].map(th => th.textContent))
      .toEqual(["Name", "Kind", "Role", "Denied permissions", "Principal id"]);
    const cells = [...document.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent));
    expect(cells).toEqual([[MARKUP, "Person", "owner", "None", "p0"], ["demo-agent", "Agent", "viewer", "billing:*", "p1"]]);
    expect(document.querySelector("img")).toBeNull();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
    expect(text()).toContain("Email addresses are not shown");
    expect(document.body.textContent).not.toContain("@");
    expect([...document.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Reload"]);
    expect(document.querySelectorAll("input, select, textarea, form, a")).toHaveLength(0);
  });

  it("shows the empty, not-connected, turned-off, unavailable and error states, each without members", async () => {
    const view = await start(ready("Demo Operations", []));
    expect(text()).toContain("No members");
    expect(document.querySelector("table")).toBeNull();

    for (const [result, shown] of [
      [{ ok: false, reason: "not-connected" }, "No InferOps member list connected"],
      [{ ok: false, reason: "disabled", message: "off" }, "InferOps workspace members are turned off"],
      [{ ok: false, reason: "unavailable", message: "No such member list is available to you." }, "This member list is not available to you"],
      [{ ok: false, reason: "error", message: "InferOps could not be reached." }, "The members could not be loaded"],
    ] as Array<[LoadMembersResult, string]>) {
      reload();
      await view.answer(result);
      expect(text()).toContain(shown);
      expect(document.querySelector("table")).toBeNull();
      expect(document.querySelector("h1")!.textContent).toBe("InferOps members");
      expect(document.querySelector("header .meta")!.textContent).toBe("");
    }
  });

  it("clears the members on a refusal, and shows them again on a reload that succeeds", async () => {
    const view = await start(ready("Demo Operations", ["Dana Demo"]));
    expect(text()).toContain("Dana Demo");
    reload();
    expect(text()).toContain("Loading members");
    expect(text()).not.toContain("Dana Demo");
    await view.answer({ ok: false, reason: "unavailable", message: "No such member list is available to you." });
    expect(text()).not.toContain("Dana Demo");
    (document.querySelector("main button") as HTMLButtonElement).click();
    await view.answer(ready("Demo Operations", ["Vic Viewer"]));
    expect(text()).toContain("Vic Viewer");
  });

  it("never draws a late answer to an earlier load", async () => {
    const view = await start(ready("Current", ["Dana Demo"]));
    const button = document.querySelector("header button") as HTMLButtonElement;
    reload();
    expect(button.disabled).toBe(true);
    // Two loads in flight at once, which the disabled button otherwise prevents: the older one
    // (say, for a binding since replaced) answers last and must not be drawn.
    button.disabled = false;
    reload();
    await vi.waitFor(() => expect(view.pending.length).toBe(2));
    const [older, newer] = [view.pending[0]!, view.pending[1]!];
    newer(ready("Current", ["NEW-1"]));
    await new Promise(resolve => setTimeout(resolve, 0));
    older(ready("Previous binding", ["OLD-1"]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector("h1")!.textContent).toBe("Current");
    expect(text()).toContain("NEW-1");
    expect(text()).not.toContain("OLD-1");
  });
});
