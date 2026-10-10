// A static guard for the cross-chat taint invariant (callable-widget contract §4.8.9): a tainted
// chat cannot create or reach another chat through any agent-controlled channel. Today that holds
// because every path that creates a chat or delivers into one is a known, reviewed site. This scan
// pins those sites, so a new one fails here until someone reviews it against the invariant (and
// against chat-taint.test.ts's runtime enumeration) and adds it below.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as
    Record<string, string>;

// Blanks comments and string and template literals in one pass (keeping line structure), so a
// mention in a comment, message or prompt is not a call.
function code(source: string): string {
  return source.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      match => match.replace(/[^\n]/g, " "));
}

// `<file>:<Class>.<method>` for every call of `name(` in src/, excluding its definitions.
function callers(name: string): string[] {
  let found: string[] = [];
  let call = new RegExp(`(?<![\\w#])${name}\\(`);
  let definition = new RegExp(`^\\s*(?:async\\s+)?${name}\\(`);
  for (let [path, source] of Object.entries(SOURCES)) {
    let file = path.replace("../src/", "");
    let className = "(module)";
    let method = "(top level)";
    for (let line of code(source).split("\n")) {
      let classMatch = /^(?:export\s+)?class\s+(\w+)/.exec(line);
      if (classMatch) { className = classMatch[1]; method = "(class body)"; }
      let methodMatch = /^ {2}(?:static\s+)?(?:async\s+)?(#?\w+)\s*(?:<[^>]*>)?\(/.exec(line);
      if (methodMatch && !/^ {2}(?:if|for|while|switch|return)\b/.test(line)) method = methodMatch[1];
      let functionMatch = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
      if (functionMatch) { className = "(module)"; method = functionMatch[1]; }
      if (call.test(line) && !definition.test(line)) found.push(`${file}:${className}.${method}`);
    }
  }
  return found.toSorted();
}

describe("chat-creating and delivering call sites", () => {
  it("nextChatId() is called only by OverseerImpl.newChat and #createSpawnedChat", () => {
    expect(callers("nextChatId")).toEqual([
      "overseer.ts:OverseerDurableObject.#createSpawnedChat",
      "overseer.ts:OverseerImpl.newChat",
    ]);
  });

  it("deliverAgentCallback( is called only by AgentSelfLoopback and its forwarder", () => {
    expect(callers("deliverAgentCallback")).toEqual([
      "overseer.ts:AgentSelfLoopback.constructor",
      "overseer.ts:OverseerDurableObject.deliverAgentCallback",
    ]);
  });

  it("receiveExternalMessage( is called only by the external message gateway", () => {
    expect(callers("receiveExternalMessage")).toEqual([
      "external-message-gateway.ts:ExternalMessageGateway.submitExternalMessage",
    ]);
  });

  it("spawnAgent( and spawnCallableAgent( are reached only through the agent spawner binding", () => {
    expect([...callers("spawnAgent"), ...callers("spawnCallableAgent")]).toEqual([
      "overseer.ts:AgentSpawnerBindingImpl.spawn",
      "overseer.ts:AgentSpawnerBindingImpl.spawnCallable",
    ]);
  });
});

// Allowlist admission (contract §4.8.5) is a review item: an allowlisted gatekeeper must neither
// persist nor return a caller's stubs, since a tainted chat keeps using it. This checks the agent-
// facing API each of the three publishes (what getTypeScriptTypes() serves): the only capability-
// typed values anywhere in them are the Scheduled Tasks registration callbacks, which the kernel
// stores (bindHook) and no method returns. A new stub-typed parameter or result fails here.
const AGENT_APIS = import.meta.glob([
  "../../gatekeeper-scheduler/src/types.d.ts",
  "../../../custom-gatekeepers/gatekeeper-inferops/src/types.d.ts",
  "../../gatekeeper-context/src/library-gatekeeper.ts",
], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function agentApi(suffix: string): string {
  let [source] = Object.entries(AGENT_APIS).filter(([path]) => path.endsWith(suffix))
      .map(([, text]) => text);
  if (source === undefined) throw new Error(`missing ${suffix}`);
  // The Context Library serves a template literal, CONTEXT_LIBRARY_TYPES, rather than a .d.ts.
  let served = /const CONTEXT_LIBRARY_TYPES = `([\s\S]*?)`;/.exec(source);
  return suffix.endsWith("library-gatekeeper.ts") ? served![1] : source;
}

const CAPABILITY = /\b(RpcStub|RpcTarget|Fetcher|DurableObjectStub|Service|WorkerEntrypoint|ScheduledTaskHook)\b/;

function capabilityLines(api: string): string[] {
  return api.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, match => match.replace(/[^\n]/g, " "))
      .split("\n").map(line => line.trim()).filter(line => CAPABILITY.test(line));
}

describe("allowlisted gatekeepers' agent APIs", () => {
  it("take or return no stub, except the scheduler's stored registration callbacks", () => {
    // Each surface was found and holds its sessions' methods.
    expect(agentApi("gatekeeper-inferops/src/types.d.ts")).toContain("findBoards(");
    expect(agentApi("gatekeeper-context/src/library-gatekeeper.ts")).toContain("search(");
    expect(agentApi("gatekeeper-scheduler/src/types.d.ts")).toContain("list(): Promise<ScheduleSummary[]>");
    expect(capabilityLines(agentApi("gatekeeper-inferops/src/types.d.ts"))).toEqual([]);
    expect(capabilityLines(agentApi("gatekeeper-context/src/library-gatekeeper.ts"))).toEqual([]);
    expect(capabilityLines(agentApi("gatekeeper-scheduler/src/types.d.ts"))).toEqual([
      expect.stringMatching(/^export interface ScheduledTaskHook\b/),
      "callback: RpcStub<ScheduledTaskHook>,",
      "callback: RpcStub<ScheduledTaskHook>,",
      "callback: RpcStub<ScheduledTaskHook>,",
    ]);
  });
});
