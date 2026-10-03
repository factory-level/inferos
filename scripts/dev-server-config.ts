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
 * The reason sign-in cannot start, or null when it can. Checked before the dev server starts: with
 * password login off, some gatekeeper has to be allowlisted (the backend would otherwise keep
 * password login on rather than lock everyone out, silently overriding the setting), and with
 * `inferops` allowlisted, the gatekeeper has to run and has to know the InferLab origin, or the
 * login page would silently offer fewer ways in and no error would say why.
 */
export function inferLabLoginStartupError(settings: {
  AUTH_GATEKEEPERS?: string; INFERLAB_AUTH_ORIGIN?: string; DISABLE_PASSWORD_AUTH?: string;
}, gatekeeperEnabled: boolean): string | null {
  const vendors = authGatekeeperVendors(settings.AUTH_GATEKEEPERS);
  if (settings.DISABLE_PASSWORD_AUTH === "true" && vendors.length === 0) {
    return "DISABLE_PASSWORD_AUTH=true leaves no way to sign in: list a sign-in gatekeeper in " +
      `AUTH_GATEKEEPERS (for InferOps identity, ${INFERLAB_LOGIN_VENDOR}) or unset DISABLE_PASSWORD_AUTH`;
  }
  if (!vendors.includes(INFERLAB_LOGIN_VENDOR)) return null;
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

/** The custom gatekeeper that serves InferOps boards, switched by `INFEROPS_ENABLED`; it also serves sign-in. */
export const INFEROPS_GATEKEEPER = INFERLAB_LOGIN_GATEKEEPER;

/**
 * The `INFEROPS_ENABLED` var the InferOps gatekeeper gets, which it checks on
 * every binding and data call (`enablement.ts`). The var is always set here, so the gatekeeper's
 * "unset counts as on" rule only applies to deployments this server did not configure.
 *
 * `inferos.canvas.json` still decides whether the gatekeeper is installed (it selects every custom
 * gatekeeper by default). Installed and off, it keeps running: its sign-in still works, existing
 * bindings and queued moves are kept, and every binding and data call is refused with DISABLED, so
 * a board card says InferOps is off rather than that it lost its connection.
 *
 * - A version 2 wrapper switches it with the capability, whatever the shell says. Turning the
 *   capability on while `inferos.canvas.json` leaves the gatekeeper out is a conflict and fails.
 * - A version 1 wrapper, or this checkout with no wrapper, behaves as before: on, unless the shell
 *   sets `INFEROPS_ENABLED=false` to try the off state locally.
 */
export function resolveInferOpsEnabled(options: {
  /** The wrapper's version 2 capability, or null for a version 1 wrapper or no wrapper. */
  capability: boolean | null;
  /** Whether `inferos.canvas.json` selects the gatekeeper. */
  canvasSelected: boolean;
  /** The shell's `INFEROPS_ENABLED`, used only without a version 2 wrapper. */
  shell: string | undefined;
}): "true" | "false" {
  const { capability, canvasSelected, shell } = options;
  if (capability === null) {
    if (shell !== undefined && shell !== "true" && shell !== "false") {
      throw new Error('INFEROPS_ENABLED must be "true" or "false"');
    }
    return shell === "false" ? "false" : "true";
  }
  if (capability && !canvasSelected) {
    throw new Error(`INFEROPS_ENABLED is on, but inferos.canvas.json leaves ${INFEROPS_GATEKEEPER} out; ` +
      `enable it with pnpm canvas gatekeeper enable ${INFEROPS_GATEKEEPER}, or turn the capability off`);
  }
  return capability ? "true" : "false";
}

/**
 * The `CODING_WORKBENCH_ENABLED` var the InferOps gatekeeper gets, which it checks on every
 * coding-dispatch binding and call (`coding-workbench.ts`). Always set here.
 *
 * - A version 2 wrapper switches it with the capability, whatever the shell says. The config parser
 *   already refuses it without `INFEROPS_ENABLED`.
 * - A version 1 wrapper, or this checkout with no wrapper, leaves it off unless the shell sets
 *   `CODING_WORKBENCH_ENABLED=true` to try it locally. Any other shell value fails startup.
 * - It is never on while the InferOps integration is off: the gatekeeper would refuse everything
 *   anyway, so asking for it then is a configuration error rather than a silent no-op.
 */
export function resolveCodingWorkbenchEnabled(options: {
  /** The wrapper's version 2 capability, or null for a version 1 wrapper or no wrapper. */
  capability: boolean | null;
  /** The resolved `INFEROPS_ENABLED`. */
  inferOpsEnabled: "true" | "false";
  /** The shell's `CODING_WORKBENCH_ENABLED`, used only without a version 2 wrapper. */
  shell: string | undefined;
}): "true" | "false" {
  const { capability, inferOpsEnabled, shell } = options;
  if (capability === null && shell !== undefined && shell !== "true" && shell !== "false") {
    throw new Error('CODING_WORKBENCH_ENABLED must be "true" or "false"');
  }
  const on = capability ?? shell === "true";
  if (on && inferOpsEnabled !== "true") {
    throw new Error("CODING_WORKBENCH_ENABLED is on, but the InferOps integration (INFEROPS_ENABLED) is off");
  }
  return on ? "true" : "false";
}
