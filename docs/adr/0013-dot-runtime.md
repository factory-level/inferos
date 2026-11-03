---
title: The Dot runs on pinned OpenDots in a per-company Node container, with Intelligence self-hosted once it's licensed
status: proposed
date: 2026-11-02
---

# 0013. The Dot runs on pinned OpenDots in a per-company Node container, with Intelligence self-hosted once it's licensed

## Context

Each person gets a personal Dot based on CopilotKit/OpenDots ([agent operations](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/agent-operations.md)). The design leaves the runtime and the Intelligence deployment to implementation, and says Cloudflare hosting alone doesn't establish compatibility.

The owner decided on 2026-11-02: "Yes we're installing opendots but running our own intelligence." So OpenDots is installed at a pinned commit, Intelligence is self-hosted, and hosted Intelligence isn't used.

Read at OpenDots `8091324942b86789ed0da7facbee855145d933b0` (MIT), inferos `314ef907eddf846a8c40d78a92b13f22126d59b3`, inferops `e2b12995b4c2b76c7b4fea5e644c3cd13a07318c`, and CopilotKit's self-hosting pages on 2026-11-02. Nothing here is built, and this record adds no code.

What bears on the choice:

- **OpenDots has two stores.** Its Node server keeps pages, Dots, thread bindings, tasks, runs and connections in one SQLite file through `node:sqlite` (`src/server/store.ts`, `workspace.ts`). Conversation messages, tool calls and run events live only in Intelligence (`README.md:194`). There's no standalone conversation store: without Intelligence, `/api/copilotkit/*` answers 503 and a conversation can't be created (`src/server/platform.ts`).
- **It knows one owner.** `thread_bindings` has an `ownerId`, set once per process from `OWNER_ID`, and `tasks` has no owner at all. Access is one shared `OWNER_TOKEN`, or none on loopback (`src/server/app.ts`).
- **Self-hosted Intelligence is licensed.** CopilotKit's page requires "a valid CopilotKit Intelligence license key", on the Team self-hosted or Enterprise plan through their account team. It needs Kubernetes 1.28 or later, Helm, an ingress controller, PostgreSQL 14 or later, Redis 7 or later and an OIDC identity provider. The chart is at `oci://ghcr.io/copilotkit/charts/intelligence`, with anonymous pulls allowed for the released chart.
- **The local evaluation isn't a production path.** It's a preview: a CopilotKit account, a renewable 30-day license, at least 4 CPUs, 12 GiB RAM and 40 GiB of disk. CopilotKit supports Docker Desktop on macOS, and calls Linux unverified.

## Decision

| # | Decision | Status |
| --- | --- | --- |
| 1 | **Pin OpenDots at `8091324942b86789ed0da7facbee855145d933b0`,** moved only by a reviewed change. No upstream code is vendored here | Proposed |
| 2 | **Run it as a Node 24 container outside Cloudflare Workers:** upstream's `app` image target, one instance per company, as ADR 0009's proposed default 4 in InferOps requires until FAC-128 proves a partition. InferOS reaches it over an authenticated server-side link | Proposed. Tested as a local Node process, not as a container |
| 3 | **Give each instance one persistent volume for its SQLite file, with one writer.** The file is subsystem state, and the instance owns it. It's no shared store and no copy of InferOps records | Proposed. Where the volume lives is **undecided** (below) |
| 4 | **Self-host Intelligence with the pinned Helm chart, in the company environment.** One deployment per company until FAC-128 says otherwise | **Blocked: needs a license.** No version is pinned, because none could be run |
| 5 | **The instance refuses to start without both Intelligence URLs.** Given a key and no URLs, OpenDots connects to the hosted gateway (`docs/SETUP.md`), which the owner ruled out. An adapter has to enforce this | Proposed |
| 6 | **Close upstream's other ways out:** `DO_NOT_TRACK=1` and `COPILOTKIT_TELEMETRY_DISABLED=true`, `WEB_SEARCH_PROVIDER=disabled` until a provider is chosen, and installs with `--ignore-scripts` | Proposed. The local run shows no remote connection with these set |
| 7 | **Excluded at first:** voice, computers, Automatic Learning, Slack and Composio. Leave their settings unset, keep `skillDeliveryEnabled` off, and keep Dots' learning container empty | Proposed. Unset settings are shown off in the run below; learning delivery isn't tested |

**Proposed default for the owner:** obtain the 30-day evaluation license to finish the proof on a machine with room, and ask CopilotKit about a self-hosted license before any deployment is planned. The price isn't known to us.

**Undecided, and this record depends on them:** ADR 0009 default 4 and its company environment, ADR 0011's authority contexts, and where a persistent volume and a Kubernetes cluster live. InferOps has no Dot host today, its `infra/foundation` names no Kubernetes cluster, and nothing here chooses one.

## Proof

Evidence is **local only**, on one Linux machine: Node 24.14.0, a clean environment, a scratch `HOME`, no credentials, and bound to `127.0.0.1`. **No CI evidence and no deployed evidence.** The model was a local fake, and no real model was called.

| Acceptance | Result |
| --- | --- |
| Starts | **Yes**, the built server, without Intelligence |
| Authenticates | **Yes** for OpenDots' one owner token. That's not per-person sign-in, which is FAC-127 |
| Completes a tool call | **Partly.** A `DotAgent` turn ran `create_space_page` through a local fake model, in process. Intelligence and the runtime route weren't involved |
| Reads persisted job state after restart | **Yes** for the SQLite side |
| Reads persisted thread state after restart | **Not proven.** The thread binding survived, but messages live in Intelligence, which didn't run |

The first criterion of FAC-126 is **not met**: it needs a running Intelligence.

Output, with the token left out and the random ids shortened:

```text
listening: 127.0.0.1:4790
GET /api/state, no token: 401
GET /api/state, wrong token: 401
GET /api/state, owner token: 200
GET /api/copilotkit/info: 503 {"error":"Setup required: INTELLIGENCE_API_KEY (or CPK_INTELLIGENCE_API_KEY)."}
POST page: 201
POST task, no Intelligence: 503 {"error":"Setup required: INTELLIGENCE_API_KEY (or CPK_INTELLIGENCE_API_KEY), OPENAI_API_KEY, OPENAI_MODEL."}
remote connections from the server: 0
--- kill -9
--- one Dot turn against the local fake model, same database
events: RUN_STARTED TOOL_CALL_START TOOL_CALL_ARGS TOOL_CALL_END TOOL_CALL_RESULT TEXT_MESSAGE_CHUNK RUN_FINISHED
task created: 52fd… queued
--- second start, same database
tasks after restart: [ 'A job that must survive a restart [failed]' ]
pages after restart: [ 'Made through the API', 'Made by a tool call' ]
thread bindings after restart: [ 'proof-thread Proof' ]
remote connections from the server: 0
```

The task was written directly to the store, because the API refuses one without Intelligence. It reads `failed` after the restart because the server's runner picked it up, and a task needs an Intelligence conversation to run. So its state persisted, and its work didn't run.

Also at the pin, in the same environment: `npm ci --ignore-scripts` and `npm run build` succeeded. Upstream's tests passed 345 of 346. `tests/telemetry.test.ts` timed out once at 5 s under load, and passed 8 of 8 when run alone.

## Consequences

- FAC-127, FAC-128, FAC-132, FAC-133, FAC-135, FAC-136 and FAC-137 can use this shape, and none can finish a real conversation until Intelligence runs. FAC-139 depends on this choice.
- A Kubernetes cluster, Postgres, Redis and an OIDC provider become new infrastructure for each company's environment, or a shared one if FAC-128 allows it. That cost hasn't been sized.
- Conversation history has to be backed up in Intelligence and application state in SQLite, separately (`docs/SETUP.md`). A company's export and deletion have to reach both.
- `node:sqlite` prints an `ExperimentalWarning` on Node 24.14.0, so a Node upgrade is a thing to test.
- AG-UI differs: OpenDots locks `@ag-ui/core` 0.0.59 and InferOps uses 1.0.2. Adapter conformance has to cover that, and this record doesn't.
- OpenDots has `@copilotkit/*` at 1.75.0 with caret ranges in `package.json`, so builds must use its lockfile.
- Upstream's `Dockerfile` runs `npm ci` with install scripts on. The image needs `--ignore-scripts`, and the container path is still to be tested.

## Alternatives Considered

- **Hosted Intelligence:** ruled out by the owner.
- **Host OpenDots in Cloudflare Workers unchanged:** it's a long-running Node server using `node:sqlite` and `@hono/node-server`, with a background runner and a local file. It wasn't tried. The design already says the shell doesn't establish compatibility.
- **Replace Intelligence behind `CopilotKitIntelligence` and `IntelligenceAgent`:** no license needed, but it's a fork of the conversation layer OpenDots is built on, and it isn't what the owner decided. Not sized.
- **Treat the local evaluation as the runtime:** it's a preview, and CopilotKit says it isn't a production installation.
- **One shared OpenDots across companies now:** denied by ADR 0009 default 4 until a second-company test passes.

## Related

- Design: [`agent-operations.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/agent-operations.md), [`ask-dot.md`](https://github.com/factory-level/inferops/blob/develop/docs/human/journeys/operator/dot/ask-dot.md)
- InferOps [ADR 0009](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0009-company-environment-and-isolation-topology.md), [ADR 0011](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0011-workflow-authority-envelopes.md), both proposed
- [ADR 0011](0011-system-workflow-authority.md), [ADR 0012](0012-run-correlation-and-outcomes.md)
- [CopilotKit self-hosting](https://docs.copilotkit.ai/intelligence/self-hosting), [local evaluation](https://docs.copilotkit.ai/intelligence/self-hosting-local)
