// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

// gatekeeper-email's entrypoint: a WorkerEntrypoint whose optional email() handler is present.
type EmailEntrypoint = CloudflareWorkersModule.WorkerEntrypoint &
    Required<Pick<CloudflareWorkersModule.WorkerEntrypoint, "email">>;

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  /** Deployer-controlled switch; custom service bindings alone do not enable extension routes. */
  CUSTOM_CLOUDFLARE_CODE?: string;
  /** Present in production (wrangler.jsonc assets stanza); absent in dev. */
  ASSETS?: Fetcher;
  /** Dormant until custom domains + Email Routing exist; the handler ships anyway. */
  GATEKEEPER_EMAIL?: Service<EmailEntrypoint>;
  [key: string]: unknown;
}

/**
 * The opener policy every Workshop document carries. Static-asset navigations get it from the
 * frontend's `public/_headers` (Workers Static Assets applies it); the documents this Worker serves
 * itself (gatekeeper connect and error pages, extension pages, its own 404s) get it here. Under
 * `same-origin` a popup opened from a sandboxed Gadget frame gets no opener into the Workshop.
 */
const OPENER_POLICY = ["Cross-Origin-Opener-Policy", "same-origin"] as const;

/**
 * `response` with {@link OPENER_POLICY} set when it is an HTML document, replacing any opener
 * policy the serving Worker chose: the page shares the Workshop's origin, so it shares its policy.
 * Anything else (RPC, WebSocket upgrades, JSON, images, bodiless redirects) passes through as is.
 */
function withOpenerPolicy(response: Response): Response {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("text/html") && !type.startsWith("application/xhtml+xml")) return response;
  const document = new Response(response.body, response);
  document.headers.set(...OPENER_POLICY);
  return document;
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: [OPENER_POLICY] });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/extensions" || url.pathname.startsWith("/extensions/")) {
      const id = url.pathname.split("/")[2];
      if (env.CUSTOM_CLOUDFLARE_CODE !== "true" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id ?? "")) {
        return notFound();
      }
      const service = env[`CONSUMER_${id.replaceAll("-", "_").toUpperCase()}`];
      if (!service || typeof service !== "object" || !("fetch" in service) || typeof service.fetch !== "function") {
        return notFound();
      }
      // These are explicitly public deployer-owned routes. The Worker owns endpoint authentication.
      return withOpenerPolicy(await service.fetch(req));
    }

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return withOpenerPolicy(await (env[key] as Fetcher).fetch(req));
      }
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/blueprint-screenshot" ||
        url.pathname.startsWith("/blueprint-screenshot/")) {
      return withOpenerPolicy(await env.WORKSHOP_BACKEND.fetch(req));
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    // Asset responses carry the opener policy already, from `_headers`.
    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    // Dev only: with no assets binding here, everything else goes to the backend.
    //
    // In `run-local` mode this router has the same ASSETS binding and route precedence as
    // production. In normal dev mode there are no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    return withOpenerPolicy(await env.WORKSHOP_BACKEND.fetch(req));
  },

  async email(message, env) {
    if (!env.GATEKEEPER_EMAIL) {
      message.setReject("No email gatekeeper is installed on this instance.");
      return;
    }
    await env.GATEKEEPER_EMAIL.email(message);
  },
} satisfies ExportedHandler<Env>;
