import { afterEach, expect, it, vi } from "vitest";
import type { QueryResult } from "../../../libraries/service-dashboard/protocol.ts";
afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); vi.resetModules(); });

it("composes three governed reads, renders labels as text, and preserves denial", async () => {
  const query = vi.fn(async (name: string): Promise<QueryResult> => name === "service-jobs"
    ? { ok: true, page: { name, version: 1, rows: [{ id: "job", projectId: "project", headSeq: "1", relatedTruncated: false,
      identifier: "SVC-1", title: "<img src=x onerror=alert(1)>", state: { id: "state", name: "Open", group: "unstarted" },
      createdAt: "2026-11-06", updatedAt: "2026-11-06", customers: [], sites: [], contacts: [] }], nextCursor: "next" } }
    : { ok: false, reason: "denied" });
  const comment = vi.fn(async () => ({ ok: true }));
  (globalThis as { gadget?: unknown }).gadget = { query, comment };
  await import("../files/client.ts");
  await vi.waitFor(() => expect(document.querySelectorAll("article")).toHaveLength(3));
  await vi.waitFor(() => expect(document.body.textContent).toContain("SVC-1"));
  expect(query).toHaveBeenCalledTimes(3);
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(document.body.textContent).toContain("can no longer read");
  expect(document.body.textContent).not.toContain("No permitted records match");
  const textarea = document.querySelector("textarea")!;
  textarea.value = "Synthetic browser comment";
  const submit = [...document.querySelectorAll("button")].find(button => button.textContent === "Submit comment")!;
  expect(submit.type).toBe("button");
  submit.click();
  await vi.waitFor(() => expect(comment).toHaveBeenCalledWith("job", "Synthetic browser comment", "1"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Comment submitted"));
  const next = [...document.querySelectorAll("button")].find(button => button.textContent === "Load next page" && !button.hidden)!;
  next.click();
  await vi.waitFor(() => expect(query).toHaveBeenCalledWith("service-jobs", "next"));
});
