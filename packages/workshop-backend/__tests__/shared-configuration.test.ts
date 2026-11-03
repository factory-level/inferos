// Shared configuration (SHARED_CONFIGURATION_GATEKEEPER): where a deployment names the vendor that
// decides it, building in a workspace other people use, sharing a workspace and publishing from it
// take that vendor's yes from the caller's own connected account. A person's own unshared workspace
// and their operate session are unaffected, and a deployment that names no vendor is unchanged.
import { describe, expect, it, vi } from "vitest";
import { getSharedConfigurationGatekeeper } from "../src/auth/config.js";
import { holdsSharedConfiguration } from "../src/user.js";
import { openFakeOverseer } from "./fixtures.js";

const REFUSED = "You don't have permission to share or publish configuration other people use.";
const GATED = { SHARED_CONFIGURATION_GATEKEEPER: "inferops" };

type Answer = boolean | Error;
/** A connected-account record as the user DO keeps one, for the account loop. */
type AccountRecord = Parameters<typeof holdsSharedConfiguration>[0] extends Iterable<infer R> ? R : never;

/** Opens a workspace through the real open(), with the caller's account answering `answer`. */
async function open(opts: {
  env?: object; shared?: boolean; answer?: Answer; collaborator?: boolean;
}) {
  let asked: string[] = [];
  let answerFor = vi.fn(async (action: string) => {
    asked.push(action);
    let answer = opts.answer ?? false;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  let sharing = {
    createShareLink: vi.fn(() => ({ key: "key", linkId: "link" })),
    newShareLinkKey: vi.fn(() => ({ key: "key" })),
    addCollaborator: vi.fn(),
  };
  // A collaborator opens as someone other than the owner, whom the sharing graph gives "build".
  let overseer = await openFakeOverseer({}, {
    role: opts.collaborator ? "use" : "build",
    impl: {
      ...(opts.collaborator ? { authorizeCollaborator: async () => "build" } : {}),
      env: opts.env ?? {},
      isSharedConfiguration: async () => opts.shared ?? true,
      getSharingManager: async () => sharing,
      logger: { warn: () => {}, error: () => {}, info: () => {} },
      users: {
        idFromString: (id: string) => id,
        idFromName: (name: string) => name,
        get: () => ({
          whoami: async () => ({ id: "profile-id", name: "Test User" }),
          whoamiIfExists: async () => null,
          recordSharedGadgetOpen: async () => {},
          holdsSharedConfiguration: answerFor,
        }),
      },
    },
  });
  return { overseer, asked, sharing };
}

const kind = (overseer: object) => overseer.constructor.name;

describe("SHARED_CONFIGURATION_GATEKEEPER", () => {
  it("is off unless set, and names a vendor in lower case", () => {
    expect(getSharedConfigurationGatekeeper({} as Cloudflare.Env)).toBeNull();
    expect(getSharedConfigurationGatekeeper({ SHARED_CONFIGURATION_GATEKEEPER: " " } as Cloudflare.Env)).toBeNull();
    expect(getSharedConfigurationGatekeeper({ SHARED_CONFIGURATION_GATEKEEPER: "InferOps" } as Cloudflare.Env))
      .toBe("inferops");
  });
});

describe("opening a shared workspace with build access", () => {
  it("is unchanged where the deployment names no vendor: the owner builds, nobody is asked", async () => {
    let { overseer, asked } = await open({ shared: true, answer: false });
    expect(kind(overseer)).toBe("OverseerClientInterface");
    expect(asked).toEqual([]);
  });

  it("opens read-only for the owner when the vendor says no", async () => {
    let { overseer, asked } = await open({ env: GATED, shared: true, answer: false });
    expect(kind(overseer)).toBe("UseOverseerInterface");
    expect(asked).toEqual(["build"]);
  });

  it("opens read-only for a build collaborator when the vendor says no", async () => {
    let { overseer, asked } = await open({ env: GATED, shared: true, answer: false, collaborator: true });
    expect(asked).toEqual(["build"]);
    expect(kind(overseer)).toBe("UseOverseerInterface");
  });

  it("lets a build collaborator build when the vendor says yes", async () => {
    let { overseer } = await open({ env: GATED, shared: true, answer: true, collaborator: true });
    expect(kind(overseer)).toBe("OverseerClientInterface");
  });

  it("builds when the vendor says yes", async () => {
    let { overseer, asked } = await open({ env: GATED, shared: true, answer: true });
    expect(kind(overseer)).toBe("OverseerClientInterface");
    expect(asked).toEqual(["build"]);
  });

  it("opens read-only when the vendor can't answer", async () => {
    let { overseer } = await open({ env: GATED, shared: true, answer: new Error("InferOps is down") });
    expect(kind(overseer)).toBe("UseOverseerInterface");
  });

  it("leaves a person's own unshared workspace theirs to build, without asking", async () => {
    let { overseer, asked } = await open({ env: GATED, shared: false, answer: false });
    expect(kind(overseer)).toBe("OverseerClientInterface");
    expect(asked).toEqual([]);
  });
});

// An unshared workspace, so the session builds; sharing it is what makes it shared.
const personal = (answer: Answer) => open({ env: GATED, shared: false, answer });

describe("sharing and publishing", () => {
  it("refuses to add a collaborator, make a share link or mint a link key when the vendor says no", async () => {
    let { overseer, asked, sharing } = await personal(false);
    await expect(overseer.addCollaborator("someone@example.com", "use")).rejects.toThrow(REFUSED);
    await expect(overseer.createShareLink("use")).rejects.toThrow(REFUSED);
    await expect(overseer.newShareLinkKey("link")).rejects.toThrow(REFUSED);
    expect(asked).toEqual(["publish", "publish", "publish"]);
    expect(sharing.createShareLink).not.toHaveBeenCalled();
    expect(sharing.newShareLinkKey).not.toHaveBeenCalled();
    expect(sharing.addCollaborator).not.toHaveBeenCalled();
  });

  it("refuses to publish a console before reading it when the vendor says no", async () => {
    let { overseer, asked } = await personal(false);
    await expect(overseer.publishConsole("console", "1")).rejects.toThrow(REFUSED);
    expect(asked).toEqual(["publish"]);
  });

  it("refuses when the vendor can't answer, with its own message", async () => {
    let { overseer } = await personal(new Error("Couldn't check"));
    await expect(overseer.createShareLink("use")).rejects.toThrow("Couldn't check");
  });

  it("shares when the vendor says yes", async () => {
    let { overseer, sharing } = await personal(true);
    await expect(overseer.createShareLink("use")).resolves.toEqual({ key: "key", linkId: "link" });
    expect(sharing.createShareLink).toHaveBeenCalledOnce();
    // No such user: the gate passed and the lookup answered.
    await expect(overseer.addCollaborator("nobody@example.com", "use")).resolves.toBeNull();
  });

  it("asks nobody where the deployment names no vendor", async () => {
    let { overseer, asked, sharing } = await open({ shared: false, answer: false });
    await expect(overseer.createShareLink("use")).resolves.toEqual({ key: "key", linkId: "link" });
    expect(sharing.createShareLink).toHaveBeenCalledOnce();
    expect(asked).toEqual([]);
  });
});

/** One connected InferOps account answering `answer`; `extra` overrides its record. */
const account = (id: number, answer: Answer, extra: Partial<AccountRecord> = {}): AccountRecord => ({
  id,
  vendorId: "inferops",
  description: {} as AccountRecord["description"],
  account: {
    holdsSharedConfiguration: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as AccountRecord["account"],
  ...extra,
});

describe("the person's own accounts", () => {
  it("is a no without an account of that vendor", async () => {
    expect(await holdsSharedConfiguration([], "inferops", "build")).toBe(false);
    expect(await holdsSharedConfiguration([account(1, true, { vendorId: "google" })], "inferops", "build"))
      .toBe(false);
  });

  it("takes the first yes, and skips an account whose credentials expired", async () => {
    expect(await holdsSharedConfiguration([account(1, false), account(2, true)], "inferops", "publish"))
      .toBe(true);
    expect(await holdsSharedConfiguration([account(1, true, { credentialsExpired: true })], "inferops", "publish"))
      .toBe(false);
  });

  it("counts an account that can't answer as no, and throws when none could", async () => {
    expect(await holdsSharedConfiguration([account(1, new Error("down")), account(2, false)], "inferops", "build"))
      .toBe(false);
    expect(await holdsSharedConfiguration([account(1, new Error("down")), account(2, true)], "inferops", "build"))
      .toBe(true);
    await expect(holdsSharedConfiguration([account(1, new Error("down"))], "inferops", "build"))
      .rejects.toThrow("Couldn't check");
  });

  it("only a literal yes counts", async () => {
    let truthy = account(1, false);
    (truthy.account as unknown as { holdsSharedConfiguration: () => Promise<unknown> })
      .holdsSharedConfiguration = async () => "yes";
    expect(await holdsSharedConfiguration([truthy], "inferops", "build")).toBe(false);
  });
});
