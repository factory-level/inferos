---
title: InferOS platform baseline
covers:
  - packages/workshop-backend
  - packages/workshop-frontend
  - packages/workshop-shared
  - packages/router
updated: 2026-10-09
---

# InferOS platform baseline

## Overview

InferOS is a Cloudflare Workers application with a browser SPA and sandboxed Gadgets. This page describes the native mechanisms every pillar builds on, separately from the [intended pillars](../design/platform-pillars.md). Each topic page records what its pillar has implemented; the [implementation roadmap](../wiki/implementation-roadmap.md) tracks merged work against the MVP walkthrough in [#1](https://github.com/factory-level/inferos/issues/1).

## Components

| Path | Responsibility |
| --- | --- |
| `packages/router` | Public assets and path routing to backend/gatekeepers |
| `packages/workshop-frontend` | Client-side React application and sandboxed iframe hosting |
| `packages/workshop-shared` | Cap’n Web and gatekeeper contracts |
| `packages/workshop-backend` | Kernel, native agents, persistent state and capability issuance |
| `packages/gatekeeper-*` | Configured external-service Workers; gatekeeper-kit is a library |
| `custom-gatekeepers/gatekeeper-*` | This fork's own gatekeepers, currently `gatekeeper-inferops` |

## Data and Control Flow

The browser connects to the kernel over persistent Cap’n Web RPC. Gadgets execute within sandbox boundaries and use explicitly granted bindings. Gatekeepers mediate external data and actions; observed reads and approval queues are existing mechanisms. Blueprint artifacts carry code and required bindings, not credentials or live state. Admin policy controls offered resources and auto-provisioning, while sign-in policy stays in environment configuration.

InferOps is a separate transactional application. InferOS reaches it only through the fork's InferOps gatekeeper, with each person's own InferLab session ([InferOps gatekeeper](inferops-gatekeeper.md)), and shows boards through the Kanban blueprint and the canvas ([InferOps canvas](inferops-canvas.md)) and the operate session ([Operate mode](operate-mode.md)). AI Trader's registry is reusable evidence, not installed code. See the paired topic documents for inspected paths and gaps.

### Chat Markdown rendering

Every chat surface that shows agent- or tool-originated text renders it through `MarkdownMessage` (`packages/workshop-frontend/src/features/chat/messages/MarkdownMessage.tsx`): assistant messages and their reasoning (`ThinkingTraceRow`), action and observation descriptions (approval cards and `ToolGroupRow`), compaction summaries, and the provisional streamed text and reasoning. User messages use it too. It renders with `react-markdown` and `remark-gfm` under `skipHtml`, so raw HTML (`<img>`, `<picture>`/`<source>`, `srcset`, inline `style` with `url()`, `<video poster>`) never reaches the DOM, and no override emits a `style` attribute.

Such Markdown makes no network request without an operator click. A Markdown image (inline or reference-style) never becomes an `<img>`: an `img` override renders an inert placeholder with the alt text and, for an http(s) URL, the URL's hostname. Only an http(s) URL, checked by `safeExternalUrl`, also makes the placeholder a link that opens the image in a new tab with `rel="noopener noreferrer"`; the image is never loaded into the page, even after the click. A `data:`, `javascript:`, relative or other non-http(s) URL leaves a placeholder with no action. An image inside a link stays inert, so the enclosing link (itself filtered by `safeExternalUrl`) remains the only action. `features/chat/messages/MarkdownMessage.test.tsx` and `ChatInterface.imageEgress.test.tsx` check each surface against spies on `fetch`, `Image`, the `src`/`srcset` setters and `setAttribute`.

The InferMind Wiki widget (`WikiMarkdown`) also uses `skipHtml` and renders an image as its alt text only ([InferOps canvas](inferops-canvas.md)). The top-bar notice and announcement banner render admin-configured Markdown, not agent or tool text.

## Configuration

Worker cloudflare.config.ts files generate committed wrangler.jsonc files. Router/backend service bindings and deployment input metadata determine installability. The development runner uses Wrangler/workerd; see [local development](local-development.md).

## Divergences from Design

Partly implemented, all without live acceptance: the InferOps gatekeeper (per-person accounts, governed reads and writes), the canvas and Kanban, attributed board activity, the operate session, local lifecycle commands, and ChatGPT plan usage through a local companion only. Not implemented: a Cloudflare-hosted ChatGPT connection, reusable authoring qualification, the complete consuming-repository skill suite, wrapper topology and cloud parity, and the InferMind Wiki host. The research wiki is a documented decision aid, not implemented vertical functionality.

## Open Questions

Follow-up, not yet done: the host page's only CSP is `frame-src srcdoc:` (`packages/workshop-frontend/index.html`), so nothing but the chat Markdown placeholder stops a future code path from loading an arbitrary image. An `img-src` policy would need these origins, inventoried on 2026-10-09 by grepping `packages/workshop-frontend/src` for `<img`, `srcSet` and CSS `url(`:

- Person and account avatars from sign-in providers and the deployment: `components/Avatar.tsx:33`, `components/PersonAvatar.tsx:72`, `components/UserMenu.tsx:27`, `Activity.tsx:849`, `SettingsPage.tsx:396`, `gatekeeper-modal/AccountChooser.tsx:27`, and the local onboarding preview at `OnboardingWizard.tsx:418`.
- Vendor and gatekeeper logos and icons, whose URLs gatekeepers declare: `BlueprintLandingPage.tsx:1263`, `components/BlueprintCard.tsx:66`, `components/auth/OAuthButtons.tsx:161`, `components/ConnectConnectorModal.tsx:190` and `:217`, `GatekeeperModal.tsx:982`, `:1061` and `:1098`, `AdminPage.tsx:887` and `:941`, `components/GatekeeperIcon.tsx:32`, `gatekeeper-modal/AccountChooser.tsx:29`, `routes/gatekeepers.tsx:68`, `features/chat/messages/CapsuleMention.tsx:14`, and the CSS `url()` logos and icon masks in `components/AppShell/SidebarGatekeeperApps.tsx:10` and `features/chat/composer/inline-items/ComposerMirror.tsx:18`.
- Blueprint screenshots and previews, same-origin or `blob:`: `BlueprintLandingPage.tsx:1168` and `:1196`, `BlueprintModal.tsx:390`, `BlueprintsPage.tsx:168`, `components/BlueprintPreviewImage.tsx:22`.
- Chat attachments as `blob:` object URLs: `features/chat/attachments/ChatAttachmentThumbnail.tsx:31`, `features/chat/attachments/AttachmentPreviewModal.tsx:95`, `features/chat/composer/attachments/ComposerAttachmentTray.tsx:23`.
- The deployment's site logo: `components/SiteLogo.tsx:24`.

Vendor logos and avatars come from third-party hosts that are not known at build time, so the policy's shape (an allowlist, a same-origin image proxy, or `data:`/`blob:` plus the deployment origin) is undecided.

See each [draft pillar](../design/platform-pillars.md) and the [roadmap](../wiki/implementation-roadmap.md).

The consumer bootstrap, parser and skills are described in [consumer configuration](consumer-configuration.md); applied profiles and styling ([#35](https://github.com/factory-level/inferos/issues/35)) are still outstanding.
