---
title: The Dot runs on InferOps' conversation runtime, with OpenDots as a reference only
status: proposed
date: 2026-11-03
---

# 0013. The Dot runs on InferOps' conversation runtime, with OpenDots as a reference only

**Amended 2026-11-03.** The first version of this record (2026-11-02, [#302](https://github.com/factory-level/inferos/pull/302)) proposed pinned OpenDots in a per-person Node container, with self-hosted CopilotKit Intelligence once it was licensed. The owner then decided on 2026-11-03: "we're not using copilotkit intelligence", hosted or self-hosted. Without Intelligence, OpenDots has no conversation store and no runtime route. This version replaces the whole decision. The first version stays readable in the history of this file.

## Context

Each person gets a personal Dot based on CopilotKit/OpenDots ([agent operations](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/agent-operations.md)). The design's minimum integration: "InferOS chat invokes an authenticated personal Dot, which uses scoped InferLab gatekeeper capabilities." It also says runtime conversations and personal working state can stay subsystem state.

The owner's constraints:

- No CopilotKit Intelligence.
- The model provider is Anthropic, on a key with a spend limit of 60 USD a month across all agents.
- InferOps stays authoritative. InferOS reaches it only through the gatekeeper.

Testers report the owner describing Dot as a background adaptation for our own models, with no in-app entry point. This record relies on that only where it says so.

Read at OpenDots `8091324942b86789ed0da7facbee855145d933b0` (MIT), inferos `03d65fac1f47016d65eda1d38316494629a53a90` and inferops `b56fa96960d978967f4c3898feb926c2915b9528`.

**What OpenDots needs Intelligence for.** It isn't one adapter:

- `Platform` constructs `CopilotKitIntelligence` and injects it into `CopilotRuntime` on `/api/copilotkit`. Readiness, conversation creation (`createThread`) and history (`getThreadMessages`) all depend on it (`src/server/platform.ts:49-190`).
- Headless voice and scheduled turns require `mode=intelligence` (`src/server/headless.ts:18-42`).
- Creating a task refuses without an Intelligence thread (`src/server/app.ts:127-148`).
- Page conversations and save-to-page read thread history from it (`src/server/page-service.ts:46-145`).
- `DotAgent` passes the Intelligence key and URL as its learned-skill backend (`src/server/dot-agent.ts:104-131`).

**What would survive.** These keep the SQLite store's tables: spaces, Dots, thread bindings, task mappings, captures, pages and connections (`src/server/workspace.ts`). The runner's task leases would survive too (`src/server/runner.ts`). But the store holds IDs and metadata, not messages. It knows one owner, and `tasks` and `memories` have no owner column. So keeping OpenDots means writing a conversation store, a runtime route and a per-person partition: most of what makes it a runtime.

**What was compared:**

| Candidate | Threads and job state | Agent loop | Per-person scope | Model key path | Proven here |
| --- | --- | --- | --- | --- | --- |
| **InferOps chatbot domain + `shared-agentic` (chosen)** | Postgres `chatbot_conversation`, `chatbot_message` and `chatbot_run`, under RLS by tenant, workspace and principal (`domain/ts/chatbot/backend/conversations.ts`) | Mastra `Agent` streaming AG-UI, tools run through a signed run-token broker (`domain/ts/chatbot/backend/agent.ts`, `live-routes.ts`) | Every read and write filters on the principal. Another person gets "not found" | `agentic.chatApiKey` from the SOPS secret layer | **Yes**, through a real `kill -9` (below) |
| InferOS's own agent sessions (`workshop-backend`) | Durable Object storage | The workshop agent, with a Haiku 5.5 allowlist and a daily turn cap proposed in [#305](https://github.com/factory-level/inferos/pull/305) | Per workspace owner | Cloudflare AI Gateway provider keys (#305) | No. Agent deployments are unwired (`docs/architecture/agent-deployments.md`), and Dot would reach InferOps data only through gatekeeper actions |
| OpenDots, Intelligence replaced behind `CopilotKitIntelligence` | Its SQLite file, plus a store we'd write | TanStack loop in `DotAgent`, with CopilotKit's `BuiltInAgent` | One owner per process | `OPENAI_*` variables | No. It's a fork of the layer listed above |
| `@inferlab/agui` alone | None. It's a wire protocol only (`lib/ts/agui/CLAUDE.md`) | None | — | — | — |

## Decision

| # | Decision | Status |
| --- | --- | --- |
| 1 | **Dot's threads and run state live in InferOps' chatbot tables, in Postgres under RLS.** A conversation belongs to one person in one workspace. InferOS stores a conversation reference at most, never messages | Proposed. Proven locally (below) |
| 2 | **InferOps' `shared-agentic` runs the loop:** Mastra, with tools only through the run-token broker, so every call is the person's own grant at the server. Write tools land live or as proposals according to the server, never the agent | Proposed. The loop and broker are proven. Since FAC-132 (inferops), every write tool is only ever proposed, and its owner confirms it |
| 3 | **InferOS reaches Dot through the gatekeeper,** with new InferOps capabilities for creating, reading and running a Dot conversation (`defineCapability`). That's an inferops pull request first, then the gatekeeper. The browser never talks to the model or to `shared-agentic` | Proposed. Being built for FAC-133: the capabilities in inferops [#2618](https://github.com/factory-level/inferops/pull/2618) and [#2619](https://github.com/factory-level/inferops/pull/2619), as `chatbot.conversation_create`, `_get`, `_run` and `_cancel` and `chatbot.proposal_list`, `_confirm` and `_decline` (the capability library names verbs `<resource>.<verb>`); the gatekeeper's `chatbot/dot` resource ([inferops-gatekeeper.md](../architecture/inferops-gatekeeper.md)); the Dot screen next. A proposal is decided in InferOS' approval queue, not a second one |
| 4 | **OpenDots is a reference only.** Nothing is vendored, copied or installed. The pin stays recorded as the revision read. Its ideas are design input: spaces and pages, leased background tasks, approval handoff for connection tools. Without a copy, there's no notice to keep | Proposed |
| 5 | **No CopilotKit package.** None is installed in InferOps: `@ag-ui/mastra` 1.1.6 lists `@copilotkit/runtime` only as an optional peer, and `bun.lock` doesn't resolve it. So there's no hosted gateway to reach and no CopilotKit telemetry. If one is ever added, it needs its own record, with telemetry off and no key without local URLs | Proposed. Checked in the lockfile and `node_modules` |
| 6 | **The model is Claude Haiku 5.5 by default,** matching FAC-152 (#305). `agentic.chatModel` moves from `anthropic/claude-haiku-4-5` to it in an inferops pull request | Proposed. Not changed yet. Whether Mastra's model router knows the id is untested |
| 7 | **Bounds on cost (below)** are part of the runtime, not settings. They're an inferops change | Proposed. Not built |
| 8 | **Excluded at first:** voice, computers, learning and channels. None exist in this runtime | Proposed |

### The model key

- **Where InferOps reads it:** `agentic.chatApiKey`. Deployed, that's the SOPS layer `config/<env>.sops.json`, KMS-encrypted and decrypted in memory at boot. Locally, it's the `ANTHROPIC_API_KEY` mapping. Nobody issues or copies a key for this record.
- **InferOS never holds Dot's key.** It calls Dot through the gatekeeper. InferOS's own agents keep their key in AI Gateway provider keys (#305).
- **One limit for both:** the proposed way is two keys, one per runtime, in one Anthropic workspace whose monthly spend limit is 60 USD. Each runtime can then be revoked on its own. Putting one key in both stores works too, but it doubles where that key can leak. **This is the owner's choice, and setting the limit is the owner's step.**
- **What a key changes:** the local fake model is replaced by Anthropic through Mastra's model router. Conversation content, selected context and tool results then go to Anthropic. Without a key, the run route answers 503.

### Cost and bounds

Prices are Claude Haiku 5.5's: 0.10 USD per million input tokens and 0.50 USD per million output, for prompts up to 100K tokens. Beyond that, it's 0.50 and 2.50. Token counts are estimated at four characters a token. None of this was measured against Anthropic.

- **A typical run:** two model steps, one tool call and one answer. About 40K input tokens and 1K output in total, so about 0.005 USD. If Dot had all 60 USD, that's about 12,000 runs a month.
- **The worst case with today's limits:**
  - Every step re-sends 40 history messages of up to 12,000 characters each, plus 170,000 characters of context.
  - That's about 165K tokens a step, priced at the long-prompt rate.
  - Eight steps comes to about 0.70 USD a run. About 85 such runs spend the month.
- **Proposed bounds:**
  - **Per run:**
    - at most 4 steps;
    - at most 1,024 output tokens a step;
    - history trimmed to 20 messages of 4,000 characters each, and context to 60,000 characters, so each prompt stays under 100K tokens.
    - That makes the worst run about 0.025 USD. The existing 120-second timeout stays.
  - **Per day:** 40 runs per person per UTC day, the same as #305's turn cap. The worst day is about 1 USD a person, and a typical day about 0.20 USD.
  - **Per month:** a ledger in InferOps, written from each run's usage. The run already emits `chat.usage`. Dot stops at 30 USD, half the budget, leaving the rest for InferOS's agents. The Anthropic workspace limit stays the only hard dollar bound.

## Proof

Evidence is **local only**, on one Linux machine. **No CI evidence and no deployed evidence.**

- **What ran:**
  - inferops `b56fa96960d978967f4c3898feb926c2915b9528` in a worktree, on a fresh, migrated and seeded database `inferlab_47`;
  - the real API (`app/ts/shared-api/src/main.ts`, stub sign-in) on port 12780;
  - a stand-in for `shared-agentic` on port 12700. It serves the real `handleConversationRun` with a local fake model in process: on its first call the model asks for `find_resources`, and once it sees the tool result it answers.
- **What didn't:** no key, no network beyond localhost, and the stand-in harness isn't committed.
- **Who signed in:** `member@acme.dev`, in the Knowledge workspace.

| Acceptance | Result |
| --- | --- |
| Starts | **Yes.** The API was serving in 9 s, and the stand-in at once |
| Authenticates | **Yes.** No token: 401. Another person's token on this conversation: "Conversation not found", and their list doesn't include it. A workspace that isn't Knowledge: 403. A forged run token at the tool broker: 403. A wrong dispatch key at the agent: 401 |
| Completes a tool call | **Yes.** `find_resources` ran through the broker under the person's scope, and the second model step saw its result. It returned an empty list, because the local seed has no indexed knowledge |
| Reads persisted thread state after `kill -9` | **Yes.** Both processes killed with `kill -9` and restarted. The conversation read back identical, except its `updatedAt` |
| Reads persisted run state after `kill -9` | **Yes, with gaps (below).** A run killed mid-answer read back as `running`, with its partial text up to the last checkpoint |

Output, with tokens left out:

```text
conversation=75a656a7-6d0d-42d5-ba4b-6c995672a7dc  run=653489d7…  http=200
events: RUN_STARTED TOOL_CALL_START TOOL_CALL_ARGS TOOL_CALL_END TOOL_CALL_RESULT TEXT_MESSAGE_START TEXT_MESSAGE_CONTENT x2 CUSTOM x3 RUN_FINISHED
fake-model call=1 sawToolResult=false
fake-model call=2 sawToolResult=true
db: run 653489d7… complete; messages: user complete, assistant complete
--- kill -9 API and agent, restart
conversation identical after kill -9 and restart
--- second turn, slow model; kill -9 both after 8 s, restart
db before kill: run e9b52fb1… running; assistant running "word0 word1 word2 word3 word4"
db after restart: run e9b52fb1… running; assistant running "word0 … word5"
new turn while it reads running: refused, "A response is already running"
read after 3 minutes: run interrupted; assistant interrupted "word0 … word5"
third turn: http=200, tool call and answer completed
```

What crossed the `kill -9`, and what didn't:

- **Crossed:** the whole completed conversation and its run row, and the killed turn's user message plus its partial answer up to the last one-second checkpoint.
- **Not crossed:**
  - The killed turn isn't resumed or retried.
  - Its tool call is kept only in the stream, not as a stored message.
  - The `shared-agentic` process holds no state, so nothing was lost there.
- **The conversation stays busy for 3 minutes.** A run left `running` refuses new turns until a read finds it older than 3 minutes and marks it `interrupted` (`conversations.ts:53`).
- **"Job state" here means run rows.** Dot's background jobs aren't built. They would be `defineJob` runs, which weren't exercised.

**Second criterion:** runtime dependencies, persistence ownership and the deployment path are written above. Voice, computers and learning stay excluded. InferOps' existing `shared-agentic` and API services are the deployment, with no new infrastructure.

## Consequences

- No license, no Kubernetes cluster, no Redis, no OIDC provider and no per-person container. The first version's cost and infrastructure questions go away. Dot runs on services InferOps already deploys, so it adds no GCP cost beyond the extra load.
- One store for Dot's conversations: they're backed up, exported and deleted with the company's other InferOps data, and the anonymizer covers them.
- **To build, in inferops first, each its own pull request:**
  1. a Dot lane for the run route, which today requires a Knowledge workspace (`live-routes.ts:79`);
  2. the gatekeeper capabilities in rule 3 (FAC-133, being built);
  3. write tools through the server's live-or-proposed decision (FAC-132 built them as proposals the owner confirms, as a `chatbot_proposal` record rather than the `requiresApproval` interrupt);
  4. the bounds and ledger, with the Haiku 5.5 default;
  5. background runs as `defineJob`, which needs a decision on whose authority a run uses when the person isn't present.
- **Found in the proof, for inferops:**
  - "Conversation not found" and "A response is already running" come back as 500, not 404 and 409. The chatbot's own error handler doesn't take effect.
  - The usage event names the configured model, not the one that ran.
- OpenDots' AG-UI version gap (`@ag-ui/core` 0.0.59 against InferOps' 1.0.2) no longer matters, because OpenDots doesn't run.
- FAC-127, FAC-128, FAC-132, FAC-133, FAC-135 and FAC-139 were written around OpenDots and Intelligence, and need rewording against this record. FAC-133 is built against this record, not OpenDots. The design's own words still name CopilotKit/OpenDots (inferops `docs/human/journeys/operator/dot/ask-dot.md`, its Interfaces line): that change belongs in a proposal there.

## Alternatives Considered

- **Self-hosted or hosted Intelligence:** ruled out by the owner on 2026-11-03.
- **OpenDots with our own conversation store behind `CopilotKitIntelligence`:** a fork of OpenDots' conversation layer and its headless and page paths, plus a per-person partition it doesn't have. It keeps a second store to back up and export. Not chosen, because InferOps already has the store, loop and scope.
- **InferOS's own agent sessions:** closest to the key path in #305, and native to the shell. But agent deployments are unwired, InferOps data would cross the gatekeeper on every tool call anyway, and nothing here proved its state across a crash. It stays the right home for InferOS's configured agents, which aren't Dot.
- **A new Dot service:** more infrastructure for the same three tables and loop.

## Related

- Design: [`agent-operations.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/agent-operations.md), [`ask-dot.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/journeys/operator/dot/ask-dot.md)
- inferos [#305](https://github.com/factory-level/inferos/pull/305): Haiku 5.5 and the daily turn cap for InferOS's agents
- InferOps [ADR 0009](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0009-company-environment-and-isolation-topology.md) and [ADR 0011](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0011-workflow-authority-envelopes.md), both proposed
- [ADR 0011](0011-system-workflow-authority.md), [ADR 0012](0012-run-correlation-and-outcomes.md)
