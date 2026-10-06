import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";

import {
  DEFAULT_INFERLAB_AUTH_ORIGIN,
  getDevServerConfig,
  getDevRouterAssets,
  getInferLabLoginVars,
  getWranglerPortFromBackendHost,
  inferLabLoginStartupError,
  isInferLabAuthOrigin,
  resolveCodingWorkbenchEnabled,
  resolveInferOpsEnabled,
  resolvePublicationFlag,
} from "./dev-server-config.ts";

describe("run-local asset topology", () => {
  it("uses production routing precedence and resolves assets from the router package", () => {
    const dir = resolve("packages/router");
    const production = parse(readFileSync(resolve(dir, "wrangler.jsonc"), "utf8"));
    const original = structuredClone(production);
    const assets = getDevRouterAssets(production, dir);
    assert.equal(assets.binding, "ASSETS");
    assert.equal(assets.directory, resolve("packages/workshop-frontend/dist"));
    assert.deepEqual(assets.run_worker_first, production.assets.run_worker_first);
    assert.ok(assets.run_worker_first?.includes("/gatekeeper/*"));
    assert.equal(assets.not_found_handling, "single-page-application");
    assert.deepEqual(production, original);
  });

  it("fails rather than silently serving assets through a different worker", () => {
    assert.throws(() => getDevRouterAssets({}, "/router"), /ASSETS/);
    assert.throws(() => getDevRouterAssets({ assets: { directory: "dist" } }, "/router"), /ASSETS/);
  });
});

describe("getWranglerPortFromBackendHost", () => {
  it("extracts a port from a localhost backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost:9000"), "9000");
  });

  it("extracts a port from an IPv6 backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("[::1]:9001"), "9001");
  });

  it("returns null when the backend host has no port", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost"), null);
  });

  it("rejects invalid ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid IPv6 ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("[::1]:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects port zero", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:0"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid hosts", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("http://localhost:9000"),
        /VITE_BACKEND_HOST must include a valid host/);
  });
});

describe("getDevServerConfig", () => {
  it("uses VITE_BACKEND_HOST as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig([], "localhost:9000"), {
      backendHost: "localhost:9000",
      wranglerPort: "9000",
    });
  });

  it("uses --port as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig(["--port", "8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  it("accepts --port=value", () => {
    assert.deepEqual(getDevServerConfig(["--port=8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  for (const args of [["--port"], ["--port", "nope"], ["--port=0"], ["--port=65536"]]) {
    it(`rejects invalid arguments: ${args.join(" ")}`, () => {
      assert.throws(() => getDevServerConfig(args), /--port must be an integer between 1 and 65535/);
    });
  }
});

describe("getInferLabLoginVars", () => {
  it("passes the shell's settings through while the flag is off", () => {
    assert.deepEqual(getInferLabLoginVars(false, {}), {
      AUTH_GATEKEEPERS: undefined, INFERLAB_AUTH_ORIGIN: undefined,
    });
    assert.deepEqual(getInferLabLoginVars(false, {
      AUTH_GATEKEEPERS: "inferops", INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io",
    }), { AUTH_GATEKEEPERS: "inferops", INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io" });
  });

  it("allowlists the InferOps vendor against the local InferLab stack by default", () => {
    assert.deepEqual(getInferLabLoginVars(true, {}), {
      AUTH_GATEKEEPERS: "inferops", INFERLAB_AUTH_ORIGIN: DEFAULT_INFERLAB_AUTH_ORIGIN,
    });
  });

  it("keeps other sign-in vendors and an explicit origin", () => {
    assert.deepEqual(getInferLabLoginVars(true, {
      AUTH_GATEKEEPERS: "google, github", INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io",
    }), { AUTH_GATEKEEPERS: "google,github,inferops", INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io" });
    assert.equal(getInferLabLoginVars(true, { AUTH_GATEKEEPERS: "InferOps" }).AUTH_GATEKEEPERS, "InferOps");
  });
});

describe("inferLabLoginStartupError", () => {
  it("passes when InferOps sign-in is not asked for, whatever else is set", () => {
    assert.equal(inferLabLoginStartupError({}, false), null);
    assert.equal(inferLabLoginStartupError({ AUTH_GATEKEEPERS: "google", DISABLE_PASSWORD_AUTH: "true" }, false), null);
    assert.equal(inferLabLoginStartupError({ INFERLAB_AUTH_ORIGIN: "nope" }, true), null);
  });

  it("fails clearly when password login is off and no gatekeeper could sign anyone in", () => {
    assert.match(inferLabLoginStartupError({ DISABLE_PASSWORD_AUTH: "true" }, true)!, /no way to sign in/);
    assert.match(inferLabLoginStartupError({ DISABLE_PASSWORD_AUTH: "true", AUTH_GATEKEEPERS: " , " }, true)!, /no way to sign in/);
    assert.equal(inferLabLoginStartupError({ DISABLE_PASSWORD_AUTH: "false" }, false), null);
  });

  it("fails clearly when the gatekeeper is off or the InferLab origin is missing or malformed", () => {
    assert.match(inferLabLoginStartupError({ AUTH_GATEKEEPERS: "inferops", INFERLAB_AUTH_ORIGIN: DEFAULT_INFERLAB_AUTH_ORIGIN }, false)!,
      /gatekeeper-inferops is not enabled/);
    assert.match(inferLabLoginStartupError({ AUTH_GATEKEEPERS: "google,InferOps" }, true)!, /INFERLAB_AUTH_ORIGIN is not set/);
    assert.match(inferLabLoginStartupError({ AUTH_GATEKEEPERS: "inferops", INFERLAB_AUTH_ORIGIN: "http://auth.example" }, true)!,
      /not a bare HTTPS origin/);
    assert.equal(inferLabLoginStartupError({ AUTH_GATEKEEPERS: "inferops", INFERLAB_AUTH_ORIGIN: "https://auth.example" }, true), null);
    // The resolved wrapper settings always pass: the flag fills in the local origin.
    assert.equal(inferLabLoginStartupError(getInferLabLoginVars(true, {}), true), null);
  });

  it("accepts the origins the gatekeeper accepts", () => {
    for (const ok of ["https://auth.inferlab.io", "https://auth.inferlab.io/", "http://localhost:8080", " http://127.0.0.1:8080 "]) {
      assert.equal(isInferLabAuthOrigin(ok), true, ok);
    }
    for (const bad of [undefined, "", "http://auth.inferlab.io", "https://auth.inferlab.io/sso", "https://u:p@auth.inferlab.io", "not a url"]) {
      assert.equal(isInferLabAuthOrigin(bad), false, String(bad));
    }
  });
});

describe("resolveInferOpsEnabled", () => {
  it("keeps a version 1 wrapper and the plain checkout on unless the shell turns it off", () => {
    for (const canvasSelected of [true, false]) {
      assert.equal(resolveInferOpsEnabled({ capability: null, canvasSelected, shell: undefined }), "true");
      assert.equal(resolveInferOpsEnabled({ capability: null, canvasSelected, shell: "true" }), "true");
      assert.equal(resolveInferOpsEnabled({ capability: null, canvasSelected, shell: "false" }), "false");
    }
    assert.throws(() => resolveInferOpsEnabled({ capability: null, canvasSelected: true, shell: "off" }),
      /INFEROPS_ENABLED must be "true" or "false"/);
  });

  it("switches a version 2 wrapper with its capability, whatever the shell says", () => {
    assert.equal(resolveInferOpsEnabled({ capability: true, canvasSelected: true, shell: "false" }), "true");
    assert.equal(resolveInferOpsEnabled({ capability: false, canvasSelected: true, shell: "true" }), "false");
    assert.equal(resolveInferOpsEnabled({ capability: false, canvasSelected: true, shell: undefined }), "false");
    // Off with the gatekeeper not installed is consistent; on without it is a conflict.
    assert.equal(resolveInferOpsEnabled({ capability: false, canvasSelected: false, shell: undefined }), "false");
    assert.throws(() => resolveInferOpsEnabled({ capability: true, canvasSelected: false, shell: undefined }),
      /INFEROPS_ENABLED is on, but inferos.canvas.json leaves gatekeeper-inferops out/);
  });
});

describe("resolveCodingWorkbenchEnabled", () => {
  it("keeps a version 1 wrapper and the plain checkout off unless the shell turns it on", () => {
    assert.equal(resolveCodingWorkbenchEnabled({ capability: null, inferOpsEnabled: "true", shell: undefined }), "false");
    assert.equal(resolveCodingWorkbenchEnabled({ capability: null, inferOpsEnabled: "true", shell: "false" }), "false");
    assert.equal(resolveCodingWorkbenchEnabled({ capability: null, inferOpsEnabled: "true", shell: "true" }), "true");
    assert.throws(() => resolveCodingWorkbenchEnabled({ capability: null, inferOpsEnabled: "true", shell: "on" }),
      /CODING_WORKBENCH_ENABLED must be "true" or "false"/);
  });

  it("switches a version 2 wrapper with its capability, whatever the shell says", () => {
    assert.equal(resolveCodingWorkbenchEnabled({ capability: true, inferOpsEnabled: "true", shell: "false" }), "true");
    assert.equal(resolveCodingWorkbenchEnabled({ capability: false, inferOpsEnabled: "true", shell: "true" }), "false");
  });

  it("refuses to start with coding on while the InferOps integration is off", () => {
    assert.equal(resolveCodingWorkbenchEnabled({ capability: false, inferOpsEnabled: "false", shell: undefined }), "false");
    for (const options of [{ capability: true, shell: undefined }, { capability: null, shell: "true" }]) {
      assert.throws(() => resolveCodingWorkbenchEnabled({ ...options, inferOpsEnabled: "false" }),
        /CODING_WORKBENCH_ENABLED is on, but the InferOps integration \(INFEROPS_ENABLED\) is off/);
    }
  });
});

describe("resolvePublicationFlag", () => {
  it("keeps a version 1 wrapper and the plain checkout off unless the shell turns it on", () => {
    for (const name of ["PUBLISH_CLOUDFLAREOS_WIDGET", "PUBLISH_CLOUDFLAREOS_APP"] as const) {
      assert.equal(resolvePublicationFlag(name, { capability: null, shell: undefined }), "false");
      assert.equal(resolvePublicationFlag(name, { capability: null, shell: "false" }), "false");
      assert.equal(resolvePublicationFlag(name, { capability: null, shell: "true" }), "true");
      assert.throws(() => resolvePublicationFlag(name, { capability: null, shell: "yes" }),
        new RegExp(`${name} must be "true" or "false"`));
    }
  });

  it("switches a version 2 wrapper with its capability, whatever the shell says", () => {
    assert.equal(resolvePublicationFlag("PUBLISH_CLOUDFLAREOS_APP", { capability: true, shell: "false" }), "true");
    assert.equal(resolvePublicationFlag("PUBLISH_CLOUDFLAREOS_APP", { capability: false, shell: "true" }), "false");
  });
});
