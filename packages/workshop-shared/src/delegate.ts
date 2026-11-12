// A delegate a person's Dot launches (FAC-134, capability 3; ADR 0020): a short-lived agent chat in
// the person's own operate session, launched only by their own approval of an action that declared
// it (`ActionDescription.delegate`), with a ceiling fixed at approval: the declared connection types
// the session's own connections may serve, and the declared tools within `DELEGATE_TOOLS`. Shared
// by the kernel, which checks and shows the declaration, and by gatekeepers, which declare one.

import { plainTitle } from "./widget-tools";

/** The bounds of a delegate's declaration, the same as InferOps' `inferos_delegate_launch` input. */
export const DELEGATE_LIMITS = {
  /** Connection types (gatekeeper vendor ids) one may name. */
  connections: 8,
  /** Tools one may name. */
  tools: 16,
  /** A title's length, in UTF-16 code units. */
  titleChars: 120,
  /** A prompt's length, in UTF-16 code units. */
  promptChars: 4000,
} as const;

/**
 * The tools a delegate may ever be offered: the operate chat's own (`OPERATE_AGENT_TOOLS`) without
 * those that would reach past its ceiling or act on the person's page: `requestConnection` (a new
 * connection), `operatePage`, `setWidgetView` and `proposePlacement` (the person's own canvas). A
 * declared tool outside this list is refused at submit; nothing adds one later.
 */
export const DELEGATE_TOOLS: readonly string[] = [
  "grep",
  "webFetch",
  "describeBinding",
  "executeCode",
  "listConsoleTools",
  "callConsoleTool",
  "findWidgets",
  "describeWidget",
  "readWidgetState",
];

/**
 * The tools a delegate gets when its declaration names none: reading, and its connections through
 * `executeCode`, whose writes still queue for the person's approval. No console command and no web.
 */
export const DELEGATE_DEFAULT_TOOLS: readonly string[] = [
  "grep",
  "describeBinding",
  "executeCode",
  "listConsoleTools",
  "findWidgets",
  "describeWidget",
  "readWidgetState",
];

/** A delegate as an action declares it, once checked (`parseDelegateDeclaration`). */
export type DelegateDeclaration = {
  /** One line of plain text (`plainTitle`). */
  title: string;
  /** What the delegate is asked to do, as the Dot wrote it: its first message. */
  prompt: string;
  /** The connection types it may use: gatekeeper vendor ids, each once. */
  connections: string[];
  /** The tools it may use, each in `DELEGATE_TOOLS`; `DELEGATE_DEFAULT_TOOLS` when absent. */
  tools?: string[];
};

const VENDOR = /^[a-z0-9][a-z0-9-]{0,63}$/;
// What a prompt may not hold: a format character (bidi overrides, zero-width), a line or paragraph
// separator, a lone surrogate, or a control character other than a line break or a tab.
const NOT_PROMPT_TEXT = /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|(?![\n\t])\p{Cc}/u;

const names = (value: unknown, what: string, max: number, allowed: (name: string) => boolean): string[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`A delegate names at most ${max} ${what}.`);
  if (value.some(name => typeof name !== "string" || !allowed(name))) throw new Error(`A delegate's ${what} aren't valid.`);
  if (new Set(value).size !== value.length) throw new Error(`A delegate names each of its ${what} once.`);
  return [...value] as string[];
};

/**
 * `value` as a delegate declaration (`ActionDescription.delegate`), or a thrown error naming what is
 * wrong, never a value: exactly a title, a prompt, connection types and optional tools. The title
 * is one line of plain text, checked before anything is trimmed (`plainTitle`); the prompt holds
 * no format or control character other than a line break or tab; the connections are gatekeeper
 * vendor ids and the tools names in `DELEGATE_TOOLS`, each once and within `DELEGATE_LIMITS`.
 * Refused, never flattened or narrowed: a declaration that doesn't check declares nothing. Whether
 * the session holds a connection of each type is checked at approval.
 */
export function parseDelegateDeclaration(value: unknown): DelegateDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("A declared delegate is an object.");
  let { title, prompt, connections, tools, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length > 0) throw new Error("A declared delegate has only a title, a prompt, connections and tools.");
  let plain = typeof title === "string" && title.length <= DELEGATE_LIMITS.titleChars ? plainTitle(title) : null;
  if (plain === null || plain.length === 0) throw new Error("A delegate's title is one line of plain text, at most 120 characters.");
  if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > DELEGATE_LIMITS.promptChars ||
      NOT_PROMPT_TEXT.test(prompt)) {
    throw new Error("A delegate's prompt is 1 to 4000 characters of text, with no control or format characters but line breaks and tabs.");
  }
  let declaration: DelegateDeclaration = {
    title: plain,
    prompt,
    connections: names(connections, "connections", DELEGATE_LIMITS.connections, name => VENDOR.test(name)),
  };
  if (tools !== undefined) {
    let checked = names(tools, "tools", DELEGATE_LIMITS.tools, name => DELEGATE_TOOLS.includes(name));
    if (checked.length === 0) throw new Error("A delegate that names its tools names at least one.");
    declaration.tools = checked;
  }
  return declaration;
}

/** The tools a delegate is offered: its declared ones, or `DELEGATE_DEFAULT_TOOLS`. */
export const delegateTools = (declaration: DelegateDeclaration): string[] =>
  [...(declaration.tools ?? DELEGATE_DEFAULT_TOOLS)];

/**
 * The kernel's own words for a declared delegate, the value of its reserved field: the title, the
 * connection types and tools it may use at most, and the prompt, every line of which is marked as
 * the Dot's (`> `), so no line of it can pass for one of the kernel's.
 */
export function delegateFieldValue(declaration: DelegateDeclaration): string {
  let connections = declaration.connections.length > 0 ? declaration.connections.join(", ") : "none";
  return [
    `"${declaration.title}": a delegate in your own operate session, with at most your own access there.`,
    `Connections it may use: ${connections}.`,
    `Tools it may use: ${delegateTools(declaration).join(", ")}.`,
    "It reports only whether it succeeded, failed or was cancelled, and can't launch another delegate.",
    "What your Dot asks it to do:",
    ...declaration.prompt.split("\n").map(line => `> ${line}`),
  ].join("\n");
}

/**
 * A delegate as its starter reads it in their own operate session (`Overseer.listDelegates`): what
 * it is, what it may use, and how it ended. Never what its chat said or returned.
 */
export type DelegateSummary = {
  delegateId: string;
  title: string;
  state: "running" | "succeeded" | "failed";
  /** Why it ended `failed`: `runtime-error`, `cancelled` (stopped), or `requester-revoked`. */
  reason?: string;
  /** The connection types it declared, and the tools it may use. */
  connections: string[];
  tools: string[];
  /** Its chat in this session, for opening it. */
  chatId: number;
  launchedAt: string;
  endedAt?: string;
};
