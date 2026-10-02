---
title: Personal ChatGPT connection
covers:
  - packages/workshop-backend/src/ai-models.ts
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/auth/config.ts
updated: 2026-10-01
---

# Personal ChatGPT connection

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](../design/chatgpt-connection.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/workshop-backend/src/ai-models.ts` | Current provider/model resolution and inference selection. |
| `packages/workshop-shared/src/api.ts` | Model configuration and redacted model credentials. |
| `packages/workshop-backend/src/auth/config.ts` | Workshop authentication policy. |

## Data and Control Flow

The current model configuration supports OpenAI API tokens and endpoint options. ai-models.ts uses the OpenAI Responses provider through pi-ai. This is not a ChatGPT subscription connection lifecycle. Inspection of the installed provider found max_output_tokens emission, which the documented subscription preview rejects. Existing model and spawner plumbing is the extension point; subscription support cannot be implemented by changing only the token field.

## Configuration

Current AiModelConfig includes apiToken, apiUrl and extraHeaders; redacted secrets are withheld. AUTH_GATEKEEPERS and DISABLE_PASSWORD_AUTH configure Workshop login, not subscription authorization.

## Divergences from Design

No native subscription account lifecycle or evidence that the target Cloudflare hosting is supported is established by current code. Provider request shaping and terminal stream handling need subscription-specific verification.

## Open Questions

- Official OSS documentation distinguishes locally hosted from remotely hosted applications; is a personal Workers install eligible, and which redirect/token-transfer topology is approved?
- Which stable host lifecycle and credential-storage mechanism fit a multi-tenant Worker without cross-user token reuse?

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.
