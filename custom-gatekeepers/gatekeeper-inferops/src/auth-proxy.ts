// The InferLab sign-in proxy: central-auth's persona sign-in pages, served from a hostname of this
// deployment for browsers InferLab's edge does not admit.
//
// Dev InferLab's edge (Cloud Armor) admits only allowlisted addresses plus requests carrying the
// `x-inferos-edge` secret, so a browser elsewhere (an external test agent) cannot open
// central-auth's `/authorize` page. With `INFERLAB_AUTHORIZE_ORIGIN` set, the gatekeeper sends the
// sign-in popup there instead, and requests arriving at that origin are forwarded to
// `INFERLAB_AUTH_ORIGIN` through `inferLabFetch`, which adds the edge header.
//
// - The authorize origin must sit behind the same Cloudflare Access application as the deployment:
//   it exposes the persona picker, which anyone who reaches it can use.
// - Only the three browser legs of central-auth are forwarded (`GET /authorize`,
//   `POST /authorize/persona`, `GET /logout`). The InferLab origin also serves the whole API, so
//   every other path is a 404 here.
// - Only a fixed set of request headers is forwarded, with Access's `CF_Authorization` cookie
//   removed. `Origin` and `Referer` naming the authorize origin are rewritten to the InferLab origin,
//   so central-auth's same-origin check on the persona form holds; anything else passes unchanged
//   and is refused there as before.
// - Redirects are never followed. A `Location` on the InferLab origin is rewritten to the
//   authorize origin; any other one (the `/oauth` callback) is passed through. `Set-Cookie` loses
//   any `Domain` attribute, so a cookie lands on the authorize host only.
// - Code exchange, refresh and logout of a stored session never come through here: the gatekeeper
//   calls `INFERLAB_AUTH_ORIGIN` directly.

import { inferLabFetch } from "./edge-header";
import { inferLabAuthOrigin, inferLabAuthorizeOrigin, type InferLabLoginEnv } from "./inferlab-login";

/** The central-auth paths the proxy forwards, each with the one method it accepts. */
const FORWARDED: ReadonlyMap<string, string> = new Map([
  ["/authorize", "GET"],
  ["/authorize/persona", "POST"],
  ["/logout", "GET"],
]);

/** Request headers a sign-in page needs; nothing else reaches InferLab. */
const FORWARDED_REQUEST_HEADERS = [
  "accept", "accept-language", "content-type", "cookie", "origin", "referer", "user-agent",
];

/** Cloudflare Access's session cookie for the authorize host: InferLab has no use for it. */
const ACCESS_COOKIE = "CF_Authorization";

function withoutCookie(header: string, name: string): string {
  return header.split(";").map(part => part.trim())
    .filter(part => part && part.split("=")[0]?.trim() !== name).join("; ");
}

function rewriteOrigin(value: string, from: string, to: string): string {
  if (value === from) return to;
  return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
}

function withoutDomain(setCookie: string): string {
  return setCookie.split(";").filter(part => !/^\s*domain\s*=/i.test(part)).join(";");
}

/**
 * Serves a request addressed to the authorize origin by forwarding it to InferLab, or returns null
 * when the request is for some other origin, or when either origin is unset or invalid.
 */
export async function handleInferLabAuthProxy(request: Request, env: InferLabLoginEnv)
    : Promise<Response | null> {
  const authorize = inferLabAuthorizeOrigin(env);
  const upstream = inferLabAuthOrigin(env);
  const url = new URL(request.url);
  if (!authorize || !upstream || authorize === upstream || url.origin !== authorize) return null;
  if (FORWARDED.get(url.pathname) !== request.method) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    let value = request.headers.get(name);
    if (value === null) continue;
    if (name === "cookie") value = withoutCookie(value, ACCESS_COOKIE);
    if (name === "origin" || name === "referer") value = rewriteOrigin(value, authorize, upstream);
    if (value) headers.set(name, value);
  }

  const response = await inferLabFetch(env)(`${upstream}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });

  const out = new Headers(response.headers);
  const location = out.get("location");
  if (location) {
    let target: URL | null;
    try {
      target = new URL(location, upstream);
    } catch {
      target = null;
    }
    if (target?.origin === upstream) {
      out.set("location", `${authorize}${target.pathname}${target.search}${target.hash}`);
    }
  }
  const cookies = response.headers.getSetCookie();
  out.delete("set-cookie");
  for (const cookie of cookies) out.append("set-cookie", withoutDomain(cookie));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
