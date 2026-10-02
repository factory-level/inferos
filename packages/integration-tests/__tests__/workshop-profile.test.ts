import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { initialConsumerConfig } from "../../../scripts/consumer/config.js";
import { ADMIN_USERNAME, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, signUp } from "../src/rpc-client.js";

it("initializes once under concurrent requests and preserves subsequent administrator resets", async () => {
  const network = new NetworkInterceptor();
  network.install();
  const harness = await startHarness({ gatekeepers: [] });
  try {
    using api = connect(harness.url);
    using ordinary = await signUp(api, "ordinaryprofile");
    expect(await ordinary.getAdminApi()).toBeNull();
    using authenticated = await signUp(api, ADMIN_USERNAME);
    using admin = await authenticated.getAdminApi();
    if (!admin) throw new Error("Missing administrator capability");
    await expect(admin.initializeProfile({ siteName: "x".repeat(41), instanceInstructions: "" })).rejects.toThrow(/Site name too long/);
    await expect(admin.initializeProfile({ siteName: "Valid", instanceInstructions: "x".repeat(8001) })).rejects.toThrow(/Instructions too long/);
    // @ts-expect-error Exercise validation of an untyped RPC caller.
    await expect(admin.initializeProfile({ siteName: "Valid", instanceInstructions: "", defaultTheme: "sepia" })).rejects.toThrow();
    const profile = { siteName: "Operations", instanceInstructions: "Use granted InferOps resources.", defaultTheme: "dark" as const };
    const results = await Promise.all([admin.initializeProfile(profile), admin.initializeProfile(profile)]);
    expect(results.toSorted()).toEqual(["already-initialized", "initialized"]);
    expect(await admin.getSettings()).toMatchObject(profile);
    expect((await api.getServerConfig()).defaultTheme).toBe('dark');
    await admin.setDefaultTheme('light');
    await admin.setSiteName("");
    await admin.setInstanceInstructions("");
    // A fresh RPC connection must see the persisted marker, not infer initialization from values.
    using anotherPublic = connect(harness.url);
    using anotherAuthenticated = await logIn(anotherPublic, ADMIN_USERNAME);
    using anotherAdmin = await anotherAuthenticated.getAdminApi();
    if (!anotherAdmin) throw new Error("Missing administrator capability after reconnect");
    expect(await anotherAdmin.initializeProfile(profile)).toBe("already-initialized");
    expect(await anotherAdmin.getSettings()).toMatchObject({ siteName: "", instanceInstructions: "" });
    expect((await anotherPublic.getServerConfig()).defaultTheme).toBe('light');
  } finally {
    await harness.server.close();
    network.uninstall();
    expect(network.getUnmockedCalls()).toEqual([]);
  }
});

it.each(['fresh', 'branding', 'theme'] as const)("profile operator respects existing customization: %s", async existing => {
  const customized = existing !== 'fresh';
  const network = new NetworkInterceptor();
  network.install();
  const harness = await startHarness({ gatekeepers: [] });
  const root = await mkdtemp(join(tmpdir(), "inferos-profile-"));
  try {
    using api = connect(harness.url);
    const token = await api.createAccount(ADMIN_USERNAME, "Local profile test", new Uint8Array(32));
    if (!token) throw new Error("Could not create local test administrator");
    const authenticated = await api.authenticate(token);
    using admin = await authenticated.getAdminApi();
    if (!admin) throw new Error("Missing administrator capability");
    if (existing === 'branding') await admin.setSiteName("Administrator choice");
    if (existing === 'theme') await admin.setDefaultTheme('light');
    const config = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
    config.local.port = Number(harness.url.port);
    config.styling.theme = 'dark';
    await writeFile(join(root, "inferos.config.json"), JSON.stringify(config));
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      [resolve(import.meta.dirname, "../../workshop-backend/scripts/initialize-consumer-profile.ts"), root],
      { env: { ...process.env, INFEROS_ADMIN_SESSION: token }, timeout: 20_000 });
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, result: customized ? "preserved" : "initialized", profile: "inferops-operations" });
    expect(stdout + stderr).not.toContain(token);
    expect(await admin.getSettings()).toMatchObject(existing === 'branding'
      ? { siteName: "Administrator choice", instanceInstructions: "", defaultTheme: 'system' }
      : existing === 'theme'
        ? { siteName: '', instanceInstructions: '', defaultTheme: 'light' }
        : { siteName: config.styling.siteName, defaultTheme: 'dark', instanceInstructions: expect.stringContaining("InferOps as the transactional source of truth") });
    await admin.setSiteName("");
    expect(await admin.initializeProfile({ siteName: "Profile", instanceInstructions: "" })).toBe("already-initialized");
  } finally {
    await rm(root, { recursive: true, force: true });
    await harness.server.close();
    network.uninstall();
    expect(network.getUnmockedCalls()).toEqual([]);
  }
});
