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

### Cross-origin opener policy

Every Workshop document is served with `Cross-Origin-Opener-Policy: same-origin`. The owner decided this on 2026-10-09 for MVP-26. Gadget frames on operate and canvas pages run with `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` (`GadgetUI.tsx`) so that a Gadget's `target="_blank"` links work. Without this policy, a popup a frame opened kept `opener.top` and could post to the Workshop page and its other frames. Under `same-origin` the Workshop sits in a browsing context group of its own. A popup opened from a cross-origin frame (a sandboxed Gadget's opaque origin) is placed in another group: `window.open()` returns `null`, the popup's `opener` is `null`, and no reference between them survives. `same-origin-allow-popups` keeps those references, so it does not help here. A Gadget's `target="_blank"` links still open.

The header reaches documents by three routes:

- **Static-asset navigations** (the app shell, every client route through the single-page-application fallback, and assets) take it from `packages/workshop-frontend/public/_headers` (`/*`). Vite copies that file into `dist/`, and Workers Static Assets applies it. Under single-page-application handling no asset path is a 404, so a missing path gets the shell with the header.
- **Worker-served documents** come from the router (`packages/router/src/index.ts`): the `/gatekeeper/*` connect and error pages (including gatekeeper-kit's handoff page), `/extensions/*` pages, the router's own 404s, and in dev whatever the backend serves when there is no `ASSETS` binding. The router sets the header on any `text/html` or `application/xhtml+xml` response it returns, and replaces whatever policy the serving Worker chose, because the page shares the Workshop's origin. RPC, WebSocket upgrades, JSON and bodiless redirects pass through unchanged. Asset responses already carry the header and are not rewritten.
- **The Vite dev and preview servers** set it through `server.headers` and `preview.headers` in `packages/workshop-frontend/vite.config.ts`.

Nothing in the repository reads `window.opener`. Connect and sign-in popups are disowned before they are navigated (`openDisownedPopup` in `connectHandoff.ts`), and gatekeeper-kit's connect pages carry no opener or message transport. Both flows complete under the policy: the nonce is kept in the popup's own sessionStorage, and the handoff page still closes itself. The tab can see two differences. Its popup handle reads `closed` as soon as the popup leaves the Workshop origin; `OAuthButtons` already treats that as "not necessarily cancelled". And `openConnectWindow` can no longer close a stale connect popup, so a second connect click opens a new popup beside the first. Popup names are fresh per flow, so the first was never reused, and in Chromium 153 its close was already ignored. See [the connect handoff](../connect-handoff.md#why-not-postmessage-an-opener-or-a-broadcastchannel).

Verification: `router.test.ts` covers the router rewrite; `vite.config.test.ts` covers the dev and preview config and the `_headers` rule; and `router-parity.test.ts` runs the production router over real HTTP with a fixture `_headers` that must equal the shipped one. That run checks the shell, deep links, the fallback for a missing asset, the router's 404s, the gatekeeper's invalid-link page and handoff page, and `/api`. `pnpm run-local` serves `dist/` through the same Wrangler asset worker. `scripts/preview/smoke.ts` checks the header on a deployed instance (`opener-policy`). The popup behaviour was checked in Chromium 153 only (Playwright, outside the repository, which has no browser tests). Firefox and WebKit are unverified: the connect flow relies on the popup's sessionStorage surviving the browsing-context-group switch, which has not been checked there, and who runs that check is not yet decided.

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

The opener policy in deployments built by the release pipeline is also an open question:

- Deployments built by the release pipeline ship `_headers` as an ordinary asset in the router's asset manifest (`scripts/release/manifest-lib.ts` carries only `not_found_handling` and `run_worker_first`). Whether the deploy service turns it into header rules, as `wrangler deploy` does, is unverified. Until it does, `smoke.ts`'s `opener-policy` check is the way to confirm a deployed instance. If it does not, the fallback is to route document navigations through the router with `run_worker_first` patterns so `withOpenerPolicy` sets the header; that costs a Worker invocation per navigation and needs an owner decision before it is adopted.

See each [draft pillar](../design/platform-pillars.md) and the [roadmap](../wiki/implementation-roadmap.md).

The consumer bootstrap, parser and skills are described in [consumer configuration](consumer-configuration.md); applied profiles and styling ([#35](https://github.com/factory-level/inferos/issues/35)) are still outstanding.
