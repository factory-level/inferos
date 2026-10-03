import { resolve } from "node:path";
import type { WranglerConfig } from "./release/manifest-lib.ts";

/** Keep run-local asset ownership and route precedence identical to the production router. */
export function getDevRouterAssets(router: WranglerConfig, routerDirectory: string): NonNullable<WranglerConfig["assets"]> {
  if (!router.assets?.directory || router.assets.binding !== "ASSETS") {
    throw new Error("The production router must declare its ASSETS binding and asset directory");
  }
  return { ...router.assets, directory: resolve(routerDirectory, router.assets.directory) };
}

/**
 * The port a `VITE_BACKEND_HOST` names, as a string, or null when it names no port. Throws on a
 * value that is not a bare `host[:port]`.
 */
export function getWranglerPortFromBackendHost(backendHost: string): string | null {
  const trimmed = backendHost.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) {
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    if (/(^.*\]:|^[^:]+:)[^:]+$/.test(trimmed)) {
      throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
    }
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  if (!url.port) return null;

  const port = Number(url.port);
  if (port < 1) {
    throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
  }

  return url.port;
}

/**
 * Resolve where the dev server's backend lives: an explicit `--port` wins, else
 * `VITE_BACKEND_HOST`, else `localhost:8787`.
 */
export function getDevServerConfig(args: readonly string[], envBackendHost?: string): {
  backendHost: string;
  wranglerPort: string | null;
} {
  let commandLinePort: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--port" && !arg.startsWith("--port=")) continue;

    if (commandLinePort !== null) {
      throw new Error("--port may only be specified once.");
    }

    const value = arg === "--port" ? args[++i] : arg.slice("--port=".length);
    if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 65535) {
      throw new Error("--port must be an integer between 1 and 65535.");
    }
    commandLinePort = String(Number(value));
  }

  if (commandLinePort !== null) {
    return {
      backendHost: `localhost:${commandLinePort}`,
      wranglerPort: commandLinePort,
    };
  }

  const backendHost = envBackendHost?.trim() || "localhost:8787";
  return {
    backendHost,
    wranglerPort: getWranglerPortFromBackendHost(backendHost),
  };
}

/** The gatekeeper that serves "Sign in with InferLab", and its vendor id in AUTH_GATEKEEPERS. */
export const INFERLAB_LOGIN_GATEKEEPER = "gatekeeper-inferops";
/** The InferOps vendor id, as AUTH_GATEKEEPERS names it. */
export const INFERLAB_LOGIN_VENDOR = "inferops";
/** Where `bun run dev up` serves InferLab central-auth locally. */
export const DEFAULT_INFERLAB_AUTH_ORIGIN = "http://localhost:8080";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether `value` is an origin the gatekeeper will accept as INFERLAB_AUTH_ORIGIN: a bare HTTPS
 * origin, or HTTP on a loopback host. Mirrors `inferLabAuthOrigin` in the gatekeeper, which cannot
 * be imported here (it depends on `cloudflare:workers`).
 */
export function isInferLabAuthOrigin(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return false; }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return secure && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
}

/** The vendor ids an AUTH_GATEKEEPERS value lists, lowercased. */
export function authGatekeeperVendors(value: string | undefined): string[] {
  return (value ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * The reason InferOps sign-in cannot start, or null when it can. Checked before the dev server
 * starts: with `inferops` allowlisted for sign-in, the gatekeeper has to run and has to know the
 * InferLab origin, or the login page would silently offer fewer ways in (none, with password login
 * off) and no error would say why.
 */
export function inferLabLoginStartupError(settings: {
  AUTH_GATEKEEPERS?: string; INFERLAB_AUTH_ORIGIN?: string;
}, gatekeeperEnabled: boolean): string | null {
  const vendors = authGatekeeperVendors(settings.AUTH_GATEKEEPERS);
  if (!vendors.includes(INFERLAB_LOGIN_VENDOR)) {
    // Not asked for. Another sign-in mode has to be on; the backend keeps password login on when
    // no gatekeeper is allowlisted, so there is no silent lock-out to catch here.
    return null;
  }
  if (!gatekeeperEnabled) {
    return `AUTH_GATEKEEPERS lists ${INFERLAB_LOGIN_VENDOR}, but ${INFERLAB_LOGIN_GATEKEEPER} is not enabled; ` +
      `enable it with pnpm canvas enable ${INFERLAB_LOGIN_GATEKEEPER}`;
  }
  if (!isInferLabAuthOrigin(settings.INFERLAB_AUTH_ORIGIN)) {
    return `AUTH_GATEKEEPERS lists ${INFERLAB_LOGIN_VENDOR}, but INFERLAB_AUTH_ORIGIN is ` +
      `${settings.INFERLAB_AUTH_ORIGIN?.trim() ? "not a bare HTTPS origin (or HTTP on localhost)" : "not set"}; ` +
      `set it to the InferLab central-auth origin, or remove ${INFERLAB_LOGIN_VENDOR} from AUTH_GATEKEEPERS`;
  }
  return null;
}

/**
 * Resolves the sign-in settings for a consumer's `features.inferlabLogin`. Enabling it adds the
 * InferOps vendor to the backend's AUTH_GATEKEEPERS allowlist, keeping any vendors the shell already
 * lists, and points the gatekeeper at the shell's INFERLAB_AUTH_ORIGIN or the local InferLab stack.
 * Disabled, both pass through from the shell unchanged, so hand-set variables still work in-repo.
 */
export function getInferLabLoginVars(enabled: boolean, shell: {
  AUTH_GATEKEEPERS?: string; INFERLAB_AUTH_ORIGIN?: string;
}): { AUTH_GATEKEEPERS?: string; INFERLAB_AUTH_ORIGIN?: string } {
  if (!enabled) {
    return { AUTH_GATEKEEPERS: shell.AUTH_GATEKEEPERS, INFERLAB_AUTH_ORIGIN: shell.INFERLAB_AUTH_ORIGIN };
  }
  const vendors = (shell.AUTH_GATEKEEPERS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!authGatekeeperVendors(shell.AUTH_GATEKEEPERS).includes(INFERLAB_LOGIN_VENDOR)) vendors.push(INFERLAB_LOGIN_VENDOR);
  return {
    AUTH_GATEKEEPERS: vendors.join(","),
    INFERLAB_AUTH_ORIGIN: shell.INFERLAB_AUTH_ORIGIN?.trim() || DEFAULT_INFERLAB_AUTH_ORIGIN,
  };
}
