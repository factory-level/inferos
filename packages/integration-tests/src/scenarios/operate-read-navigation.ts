// Scenario `operate-read-navigation` version 1: one programmed Operate read/navigation interaction,
// played through the real Workshop's AG-UI endpoint by the stock `@ag-ui/client`. The contract is
// `operate-read-navigation.md` beside this file; this module holds its data, and the runner is
// `__tests__/operate-read-scenario.test.ts`.
//
// Only the model's replies and the InferOps/InferLab provider answers are programmed. Sign-in, the
// bearer session, AG-UI preparation and admission, the board permission check, navigation, the
// session log and chat history all run the real Workshop and InferOps gatekeeper code.

import { boardUrl } from "../inferops-fake.js";
import type { ChatCompletionStep } from "../mock-model.js";

/** Bump `version` whenever a fixture input or an expected result below changes. */
export const SCENARIO = { id: "operate-read-navigation", version: 1 } as const;

/** The synthetic board every navigation names, served by the fake InferOps. */
export const SCENARIO_BOARD = boardUrl("operations", "ENG");

/** The InferOps workspace the connected fixture person holds. */
export const SCENARIO_WORKSPACE = "operations";

/** Text replies are prefixed so every transcript and report shows they came from the script. */
export const MOCK_PREFIX = "[mock model]";

/** The single user message of every run. */
export const PROMPT = { id: "prompt", role: "user", content: "Read the board I just opened." } as const;

/** The fixture each case starts from: a new account, workspace and Operate session. */
export const INITIAL_STATE = { sessionSeq: 0, events: 0, chats: 0, board: null } as const;

/** Model steps for one read/navigation run: read the page, then answer. */
export const READ_STEPS: readonly ChatCompletionStep[] = [
  { toolCall: { id: "scenario-read-page", name: "operatePage", arguments: {} } },
  { text: `${MOCK_PREFIX} The ENG board is open on your page.` },
];

/** Model steps for the interrupted run; the kernel finishes after the client leaves. */
export const INTERRUPTED_STEPS: readonly ChatCompletionStep[] = [
  { text: `${MOCK_PREFIX} Finished after the client disconnected.` },
];

/** What a completed read/navigation run must show, identical from every fresh fixture. */
export const EXPECTED_READ = {
  firstEvent: "RUN_STARTED",
  lastEvent: "RUN_FINISHED",
  requiredEvents: ["STATE_SNAPSHOT", "MESSAGES_SNAPSHOT", "TOOL_CALL_START", "TOOL_CALL_ARGS",
    "TOOL_CALL_END", "TOOL_CALL_RESULT", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END"],
  toolCallId: "scenario-read-page",
  reply: `${MOCK_PREFIX} The ENG board is open on your page.`,
  sessionSeq: 1,
  offeredTools: ["operatePage"],
  replayError: "RUN_ALREADY_RESERVED",
} as const;

/** The refusal: an unconnected person opening the board, refused before any chat or model work. */
export const EXPECTED_REFUSAL = { status: 403, error: "READ_RUN_REFUSED" } as const;

/**
 * The interruption: the client aborts after the run starts. No terminal event crosses the wire; the
 * stock client reports its own local `RUN_ERROR` with code `abort`, and the kernel turn completes once.
 */
export const EXPECTED_INTERRUPTION = {
  wireTerminalEvents: [],
  clientError: { type: "RUN_ERROR", code: "abort" },
  reply: `${MOCK_PREFIX} Finished after the client disconnected.`,
  modelRequests: 1,
  replayError: "RUN_ALREADY_RESERVED",
} as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Refuse any target that is not a plain-HTTP loopback Workshop. */
export function assertLoopbackTarget(target: URL): URL {
  if (target.protocol !== "http:" || !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error(`Scenario ${SCENARIO.id} runs only against a loopback Workshop, not ${target.origin}`);
  }
  return target;
}

/** One case's outcome as the report records it. */
export type ScenarioCase = {
  name: string;
  outcome: "PASS" | "FAIL";
  observed: Record<string, unknown>;
  failure?: string;
};

/** The bounded, credential-free report a run writes. */
export type ScenarioReport = {
  scenario: typeof SCENARIO;
  revision: { commit: string; dirty: boolean | null };
  source: "mock";
  liveProviderProof: false;
  target: "wrangler createTestHarness on loopback";
  boundaries: { mocked: string[]; real: string[] };
  fixtures: Record<string, unknown>;
  cases: ScenarioCase[];
  verdict: "PASS" | "FAIL";
};

/** Which parts of the run are programmed and which are the real code paths. */
export const BOUNDARIES = {
  mocked: [
    "model replies (scripted OpenAI-compatible stream, prefixed " + MOCK_PREFIX + ")",
    "InferOps and InferLab provider answers (InferOpsFake synthetic board and sign-in)",
    "synthetic password accounts; no per-person live identity",
  ],
  real: [
    "Workshop password sign-in and bearer session",
    "POST /api/operate/agui/prepare and POST /api/operate/agui (AG-UI 1.0)",
    "@ag-ui/client HttpAgent 1.0.2, unmodified",
    "InferOps gatekeeper Worker connection and board permission check",
    "Operate session navigation, its event log and chat history persistence",
    "run admission, replay refusal and the read-only tool policy",
  ],
};
