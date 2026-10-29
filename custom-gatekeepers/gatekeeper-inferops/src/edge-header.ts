// The shared-secret edge header InferLab's WAF lets through.
//
// A hosted InferOS Worker reaches InferLab from Cloudflare's shared egress addresses, which an
// IP-allowlisting edge (dev InferLab's Cloud Armor policy) cannot tell apart from anyone else's.
// When the deployment holds `INFEROPS_EDGE_SECRET`, every request to the InferLab origins this
// gatekeeper is configured with carries it as `x-inferos-edge`, and the edge's allow rule matches
// on it (inferops `infra/waf`, `waf:inferosEdgeSecret`).
//
// - Only the configured origins (`INFERLAB_AUTH_ORIGIN`, `INFEROPS_BASE_URL`) get it, compared by
//   exact origin; any other URL is fetched untouched.
// - A request that carries it never follows a redirect, so the header cannot travel to wherever a
//   `Location` points.
// - It is an edge credential, not an identity: InferOps authentication, permissions and RLS apply
//   behind it unchanged. It is never logged; nothing here logs at all.

/** The request header InferLab's edge allow rule matches. */
export const INFEROPS_EDGE_HEADER = "x-inferos-edge";

/** The deployment vars the header depends on. */
export type InferOpsEdgeEnv = {
  INFEROPS_EDGE_SECRET?: string;
  INFERLAB_AUTH_ORIGIN?: string;
  INFEROPS_BASE_URL?: string;
};

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

/**
 * The `fetch` every InferLab/InferOps request goes through. With `INFEROPS_EDGE_SECRET` set it adds
 * {@link INFEROPS_EDGE_HEADER} to requests for the configured InferLab origins (and only those) and
 * turns a followed redirect into a manual one; otherwise it is plain `fetch`. The global is read
 * per call, so a test that stubs it is honoured.
 */
export function inferLabFetch(env: InferOpsEdgeEnv): typeof fetch {
  const secret = env.INFEROPS_EDGE_SECRET?.trim();
  const origins = new Set(
    [originOf(env.INFERLAB_AUTH_ORIGIN), originOf(env.INFEROPS_BASE_URL)].filter(o => o !== null));
  return (input, init) => {
    let target: string | null;
    try {
      target = new URL(requestUrl(input)).origin;
    } catch {
      target = null;
    }
    if (!secret || target === null || !origins.has(target)) return fetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set(INFEROPS_EDGE_HEADER, secret);
    const redirect = init?.redirect === "error" ? "error" : "manual";
    return fetch(input, { ...init, headers, redirect });
  };
}
