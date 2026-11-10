// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";
import type {
  DotConversation, DotConversationSession, DotProgress, InferOpsDotSession, ProgressTarget,
} from "../files/lib/protocol.ts";

const PROPOSAL = {
  id: "p1", tool: "issue_create", input: "{\"title\":\"Fix\"}", status: { outcome: "waiting" as const },
  receipt: { actionId: "7" }, createdAt: "2026-11-10T12:00:00.000Z", expiresAt: "2026-11-10T12:15:00.000Z",
};

/** A Dot binding over one in-memory conversation per id, recording what it is asked. */
function fakeDot(options: { askError?: Error; openError?: Error } = {}) {
  const conversations = new Map<string, DotConversation>();
  const asked: string[] = [];
  let started = 0;
  const session = (id: string): DotConversationSession => ({
    id: async () => id,
    read: async () => conversations.get(id)!,
    ask: async (prompt, ask) => {
      if (options.askError) throw options.askError;
      asked.push(prompt);
      const events: DotProgress[] = [{ type: "text", delta: "Do" }, { type: "text", delta: "ne." }, { type: "proposal", proposal: PROPOSAL }];
      for (const event of events) ask?.onProgress?.(event);
      const conversation = conversations.get(id)!;
      conversation.messages.push(
        { id: `u${asked.length}`, role: "user", content: prompt, status: "complete", createdAt: "" },
        { id: `a${asked.length}`, role: "assistant", content: "Done.", status: "complete", createdAt: "" });
      conversation.proposals = [PROPOSAL];
      return { runId: "r1", status: "complete", reply: "Done.", proposals: [PROPOSAL] };
    },
    cancel: async () => {},
  });
  const dot: InferOpsDotSession = {
    startConversation: async () => {
      const id = `c${++started}`;
      conversations.set(id, { id, title: "New conversation", messages: [], nextCursor: null, running: false, proposals: [] });
      return session(id);
    },
    openConversation: async id => {
      if (options.openError) throw options.openError;
      if (!conversations.has(id)) throw new Error("NOT_FOUND: No such Dot conversation of yours.");
      return session(id);
    },
  };
  return { dot, asked, conversations, started: () => started };
}

/** A Durable Object state whose storage keeps values in memory, and only under the one key the gadget may use. */
function state() {
  const kept = new Map<string, unknown>();
  const kv = {
    get: (key: string) => kept.get(key),
    put: (key: string, value: unknown) => {
      if (key !== "conversation") throw new Error(`the Dot gadget may keep only its conversation id, not ${key}`);
      kept.set(key, value);
    },
    delete: (key: string) => kept.delete(key),
  };
  return { ctx: { storage: { kv } } as unknown as DurableObjectState, kept };
}

const collect = () => {
  const events: DotProgress[] = [];
  const target: ProgressTarget = { progress: event => { events.push(event); } };
  return { events, target };
};

describe("InferOps Dot server", () => {
  it("reports a missing binding instead of throwing", async () => {
    const { ctx } = state();
    const gadget = new Gadget(ctx, {});
    expect(await gadget.open()).toMatchObject({ ok: false, reason: "not-connected" });
    expect(await gadget.ask("Hi", collect().target)).toMatchObject({ ok: false, reason: "not-connected" });
  });

  it("starts a conversation on the first question, keeps only its id, and relays the answer as it comes", async () => {
    const fake = fakeDot();
    const { ctx, kept } = state();
    const gadget = new Gadget(ctx, { dot: fake.dot });
    expect(await gadget.open()).toEqual({ ok: true, conversation: null });
    const { events, target } = collect();
    const result = await gadget.ask("What changed today?", target);
    expect(events.map(e => e.type)).toEqual(["text", "text", "proposal"]);
    expect(result).toMatchObject({ ok: true, status: "complete" });
    expect(kept).toEqual(new Map([["conversation", "c1"]]));
    // What the client sees: messages and each change's status, never a receipt or raw arguments.
    const conversation = result.ok ? result.conversation : null;
    expect(conversation?.proposals).toEqual([{ id: "p1", tool: "issue_create", status: { outcome: "waiting" } }]);
    expect(JSON.stringify(conversation)).not.toContain("receipt");
    // The next question continues the same conversation.
    await gadget.ask("And yesterday?", collect().target);
    expect(fake.started()).toBe(1);
    expect((await gadget.open()).ok && (await gadget.open() as { conversation: { messages: unknown[] } }).conversation.messages).toHaveLength(4);
  });

  it("forgets a conversation that is gone, and starts over on request", async () => {
    const fake = fakeDot();
    const { ctx, kept } = state();
    kept.set("conversation", "gone");
    const gadget = new Gadget(ctx, { dot: fake.dot });
    expect(await gadget.open()).toEqual({ ok: true, conversation: null });
    expect(kept.has("conversation")).toBe(false);
    await gadget.ask("Hi", collect().target);
    await gadget.startOver();
    expect(kept.has("conversation")).toBe(false);
    await gadget.ask("Hi again", collect().target);
    expect(fake.started()).toBe(2);
  });

  it("answers each refusal by its kind, in the gatekeeper's own words", async () => {
    const cases: [string, string][] = [
      ["FORBIDDEN: Your Dot needs your own InferLab sign-in: this connection is shared and is no one's Dot.", "refused"],
      ["UNAVAILABLE: Your Dot can't run now. Try again later.", "unavailable"],
      ["CONFLICT: Another turn of this conversation is still running.", "busy"],
      ["DISABLED: The InferOps Dot is turned off for this deployment.", "disabled"],
      ["boom", "error"],
    ];
    for (const [message, reason] of cases) {
      const { ctx } = state();
      const gadget = new Gadget(ctx, { dot: fakeDot({ askError: new Error(message) }).dot });
      const result = await gadget.ask("Hi", collect().target);
      expect(result, message).toMatchObject({ ok: false, reason });
      expect((result as { message: string }).message, message).not.toMatch(/^[A-Z_]+: /);
    }
  });

  it("keeps the conversation when reopening it fails for any other reason than its being gone", async () => {
    const { ctx, kept } = state();
    kept.set("conversation", "c9");
    const gadget = new Gadget(ctx, { dot: fakeDot({ openError: new Error("UNAVAILABLE: Your Dot can't run now. Try again later.") }).dot });
    expect(await gadget.open()).toMatchObject({ ok: false, reason: "unavailable" });
    expect(kept.get("conversation")).toBe("c9");
  });
});
