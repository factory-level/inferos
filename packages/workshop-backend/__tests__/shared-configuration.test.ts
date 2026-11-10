// Shared configuration (SHARED_CONFIGURATION_GATEKEEPER): where a deployment names the vendor that
// decides it, building in a workspace other people use, sharing a workspace and publishing from it
// take that vendor's yes from the caller's own connected account. A person's own unshared workspace
// and their operate session are unaffected, and a deployment that names no vendor is unchanged.
import { describe, expect, it, vi } from "vitest";
import { getSharedConfigurationGatekeeper } from "../src/auth/config.js";
import { requireSharedConfiguration } from "../src/overseer.js";
import { holdsSharedConfiguration, holdsWorkflowInvoke } from "../src/user.js";
import { openFakeOverseer } from "./fixtures.js";

const REFUSED = "You don't have permission to share or publish configuration other people use.";
const GATED = { SHARED_CONFIGURATION_GATEKEEPER: "inferops" };

type Answer = boolean | Error;
/** What the caller's account answers: one answer, or one per action and moment. */
type Answers = Answer | ((action: string) => Answer);
/** A connected-account record as the user DO keeps one, for the account loop. */
type AccountRecord = Parameters<typeof holdsSharedConfiguration>[0] extends Iterable<infer R> ? R : never;

/** Opens a workspace through the real open(), with the caller's account answering `answer`. */
async function open(opts: {
  env?: object; shared?: boolean; answer?: Answers; collaborator?: boolean; storage?: object;
}) {
  let asked: string[] = [];
  let answerFor = vi.fn(async (action: string) => {
    asked.push(action);
    let given = opts.answer ?? false;
    let answer = typeof given === "function" ? given(action) : given;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  let sharing = {
    createShareLink: vi.fn(() => ({ key: "key", linkId: "link" })),
    newShareLinkKey: vi.fn(() => ({ key: "key" })),
    addCollaborator: vi.fn(),
  };
  // A collaborator opens as someone other than the owner, whom the sharing graph gives "build".
  let overseer = await openFakeOverseer(opts.storage ?? {}, {
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
          // Finding a person by address asks whether the account it names is bound (ADR 0019).
          isSubjectBound: async () => false,
          recordSharedGadgetOpen: async () => {},
          holdsSharedConfiguration: answerFor,
        }),
      },
      // No one holds an address as their current, vouched one here.
      userDirectory: { getByName: () => ({ accountForEmail: async () => null }) },
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

  it("leaves publishing a console in a person's own unshared workspace to them", async () => {
    let { overseer, asked } = await personal(false);
    // Past the check, the forged workspace has no console store to publish from.
    let error = await overseer.publishConsole("console", "1").catch((e: unknown) => e);
    expect(String(error)).not.toContain(REFUSED);
    expect(asked).toEqual([]);
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

// Opened with build, then the authority changes: what reaches other people asks again.
async function shared(answers: { build: Answer; publish: Answer }, storage: object = {}) {
  let opened = false;
  let session = await open({
    env: GATED, shared: true, storage,
    answer: action => {
      if (!opened && action === "build") return true;
      return action === "build" ? answers.build : answers.publish;
    },
  });
  opened = true;
  expect(kind(session.overseer)).toBe("OverseerClientInterface");
  return session;
}

describe("a build session in a shared workspace", () => {

  // FAC-99: publication is the company Admin's. A builder without publish (a build collaborator the
  // service says no to for publish; in InferOps an Operator has neither, see the FAC-95 case below) and another company's Admin (to whom the deployment's service answers no:
  // gatekeeper-inferops account.test.ts, "answers for nothing in a deployment that names another
  // company") are refused before the console store is touched.
  it("refuses a console publication by a builder without publish, or by another company's Admin (FAC-99)", async () => {
    let operator = await open({
      env: GATED, shared: true, collaborator: true, answer: action => action === "build",
    });
    expect(kind(operator.overseer)).toBe("OverseerClientInterface");
    operator.asked.length = 0;
    await expect(operator.overseer.publishConsole("console", "1")).rejects.toThrow(REFUSED);
    expect(operator.asked).toEqual(["publish"]);
    let otherCompany = await shared({ build: true, publish: false });
    otherCompany.asked.length = 0;
    await expect(otherCompany.overseer.publishConsole("console", "1")).rejects.toThrow(REFUSED);
    expect(otherCompany.asked).toEqual(["publish"]);
  });

  // FAC-95: the workspace's settings are building. An Operator (a collaborator the service says no to
  // for build) gets the read-only session, which refuses them; another company's member, to whom the
  // deployment's service answers no for build, is refused at the write, before storage is touched.
  it("refuses the workspace's settings to an Operator, and to another company's member (FAC-95)", async () => {
    let operator = await open({ env: GATED, shared: true, collaborator: true, answer: false });
    expect(kind(operator.overseer)).toBe("UseOverseerInterface");
    await expect(operator.overseer.setWorkspaceConfiguration("0", { "baseUi.alerts": true })).rejects.toThrow(/Unauthorized/);
    await expect(operator.overseer.getWorkspaceConfiguration()).rejects.toThrow(/Unauthorized/);
    await expect(operator.overseer.traceConfiguration(null)).rejects.toThrow(/Unauthorized/);
    let otherCompany = await shared({ build: false, publish: false });
    otherCompany.asked.length = 0;
    await expect(otherCompany.overseer.setWorkspaceConfiguration("0", { "baseUi.alerts": true })).rejects.toThrow(REFUSED);
    expect(otherCompany.asked).toEqual(["build"]);
  });

  it("refuses publishing, installs and blueprint changes without publish, before anything runs", async () => {
    let { overseer, asked } = await shared({ build: true, publish: false });
    asked.length = 0;
    await expect(overseer.publishConsole("console", "1")).rejects.toThrow(REFUSED);
    await expect(overseer.installBlueprint("blueprint", {})).rejects.toThrow(REFUSED);
    await expect(overseer.upgradeInstall(2)).rejects.toThrow(REFUSED);
    await expect(overseer.updateBlueprint("blueprint", { title: "t" })).rejects.toThrow(REFUSED);
    await expect(overseer.deleteBlueprint("blueprint")).rejects.toThrow(REFUSED);
    expect(asked).toEqual(["publish", "publish", "publish", "publish", "publish"]);
  });

  it("refuses a merge or a kind change once build is gone, though the session opened with it", async () => {
    let { overseer, asked } = await shared({ build: false, publish: false });
    asked.length = 0;
    await expect(overseer.mergeChanges(1)).rejects.toThrow(REFUSED);
    await expect(overseer.setKind("app")).rejects.toThrow(REFUSED);
    expect(asked).toEqual(["build", "build"]);
  });

  it("refuses deleting a console, retrying a blueprint, binding or publishing an artifact without publish", async () => {
    let { overseer, asked } = await shared({ build: true, publish: false });
    asked.length = 0;
    await expect(overseer.deleteConsole("console", "1")).rejects.toThrow(REFUSED);
    await expect(overseer.retryBlueprintPublish("blueprint")).rejects.toThrow(REFUSED);
    await expect(overseer.bindArtifactRevision("widget/w@1" as never, {})).rejects.toThrow(REFUSED);
    await expect(overseer.publishArtifactRevision(1 as never, "skill", "w", 1, [], null,
      { digest: "0".repeat(64), harness: "test@1", checks: [], completedAt: new Date(0) } as never))
      .rejects.toThrow(REFUSED);
    expect(asked).toEqual(["publish", "publish", "publish", "publish"]);
  });

  it("refuses hooks, auto-approval rules, connections, title and test-only once build is gone", async () => {
    let { overseer, asked } = await shared({ build: false, publish: true });
    asked.length = 0;
    let calls: Array<() => Promise<unknown>> = [
      () => overseer.setTitle("t"),
      () => overseer.setTestOnly(true),
      () => overseer.enableHook(1),
      () => overseer.disableHook(1),
      () => overseer.deleteHook(1),
      () => overseer.setAutoApprovedActionKind(1 as never, { tag: "edit", label: "Edits" }),
      () => overseer.removeAutoApprovedActionKind(1 as never, "edit"),
      () => overseer.newGatekeeper(1, "inferops://acme.operations/project/board/ENG"),
      () => overseer.newAiModelGatekeeper("model"),
      () => overseer.newAgentSpawnerGatekeeper({ displayName: "agent", modelId: null, env: {} }),
      () => overseer.updateAgentSpawner(1 as never, { displayName: "agent", modelId: null, env: {} }, { instructions: "x" }),
      () => overseer.getAgentSpawner(1 as never),
      () => overseer.setAgentSpawnerEnv(1 as never, { displayName: "agent", modelId: null, env: {} }, {}),
      () => overseer.newArtifactPublisherGatekeeper(),
      () => overseer.setTriggerControl(1, null),
      () => overseer.acceptConnectionRequest("request", { gatekeeperId: 1 as never }),
    ];
    for (let call of calls) await expect(call()).rejects.toThrow(REFUSED);
    expect(asked).toEqual(calls.map(() => "build"));
  });

  it("refuses approving an action once build is gone, and an artifact publisher's without publish", async () => {
    let pending = { id: 1, type: "action", state: "pending", gatekeeperId: 7, caller: { from: "user" } };
    let storage = (publisher: boolean) => ({
      actions: { get: () => pending },
      gatekeepers: { get: () => ({ creationSpec: { type: publisher ? "artifactPublisher" : "custom" } }) },
    });
    let action = await shared({ build: false, publish: true }, storage(false));
    action.asked.length = 0;
    await expect(action.overseer.approveAction(1)).rejects.toThrow(REFUSED);
    expect(action.asked).toEqual(["build"]);
    let publisher = await shared({ build: true, publish: false }, storage(true));
    publisher.asked.length = 0;
    await expect(publisher.overseer.approveAction(1)).rejects.toThrow(REFUSED);
    expect(publisher.asked).toEqual(["publish"]);
  });

  it("refuses when InferOps can't answer", async () => {
    let { overseer } = await shared({ build: new Error("down"), publish: new Error("down") });
    await expect(overseer.mergeChanges(1)).rejects.toThrow("down");
    await expect(overseer.publishConsole("console", "1")).rejects.toThrow("down");
  });
});

/** A workspace for the check alone, recording what its user's account is asked. */
function workspace(opts: { env?: object; shared: boolean; answer: Answer }) {
  let asked: string[] = [];
  return {
    asked,
    workspace: {
      env: (opts.env ?? GATED) as Cloudflare.Env,
      isSharedConfiguration: async () => opts.shared,
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          holdsSharedConfiguration: async (action: string) => {
            asked.push(action);
            if (opts.answer instanceof Error) throw opts.answer;
            return opts.answer;
          },
        }),
      },
    } as never,
  };
}

describe("requireSharedConfiguration", () => {

  it("asks nobody when off, or for a shared-only check in an unshared workspace", async () => {
    let off = workspace({ env: {}, shared: true, answer: false });
    await requireSharedConfiguration(off.workspace, "user", "publish", "always");
    let unshared = workspace({ shared: false, answer: false });
    await requireSharedConfiguration(unshared.workspace, "user", "build", "shared");
    expect([...off.asked, ...unshared.asked]).toEqual([]);
  });

  it("asks for sharing even in an unshared workspace, and refuses a no", async () => {
    let { workspace: ws, asked } = workspace({ shared: false, answer: false });
    await expect(requireSharedConfiguration(ws, "user", "publish", "always")).rejects.toThrow(REFUSED);
    expect(asked).toEqual(["publish"]);
  });

  it("passes a yes, and refuses a failed check with its own message", async () => {
    await requireSharedConfiguration(workspace({ shared: true, answer: true }).workspace, "user", "build", "shared");
    await expect(requireSharedConfiguration(
      workspace({ shared: true, answer: new Error("down") }).workspace, "user", "build", "shared"))
      .rejects.toThrow("down");
  });
});

/** The boards the accounts' workflow:invoke question was asked about. */
const askedBoards: string[] = [];
const BOARD = "inferops://acme.operations/project/board/OPS";

/** What one account answers: a company-scoped answer, or a failure. */
type AccountAnswer = { holds: unknown; scope: string | null } | Error;
const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

/** One connected InferOps account answering `answer`; `extra` overrides its record. */
const account = (id: number, answer: AccountAnswer, extra: Partial<AccountRecord> = {}): AccountRecord => ({
  id,
  vendorId: "inferops",
  description: {} as AccountRecord["description"],
  account: {
    holdsSharedConfiguration: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
    holdsWorkflowInvoke: async (resourceUrl: string) => {
      askedBoards.push(resourceUrl);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as AccountRecord["account"],
  ...extra,
});
const yes = (scope: string) => ({ holds: true, scope });
const no = (scope: string | null) => ({ holds: false, scope });

describe("the person's own accounts", () => {
  it("is a no without an account of that vendor", async () => {
    expect(await holdsSharedConfiguration([], "inferops", "build")).toBe(false);
    expect(await holdsSharedConfiguration([account(1, yes(COMPANY_A), { vendorId: "google" })], "inferops", "build"))
      .toBe(false);
  });

  it("takes a yes within the one company, and skips an account whose credentials expired", async () => {
    expect(await holdsSharedConfiguration([account(1, no(COMPANY_A)), account(2, yes(COMPANY_A))], "inferops", "publish"))
      .toBe(true);
    expect(await holdsSharedConfiguration([account(1, yes(COMPANY_A), { credentialsExpired: true })], "inferops", "publish"))
      .toBe(false);
  });

  it("refuses an Admin of company A who is only a member of company B, when both answer", async () => {
    // A deployment that names no tenant id: both connections speak, for different companies.
    await expect(holdsSharedConfiguration([account(1, yes(COMPANY_A)), account(2, no(COMPANY_B))], "inferops", "build"))
      .rejects.toThrow("more than one organization");
    await expect(holdsSharedConfiguration([account(1, no(COMPANY_B)), account(2, yes(COMPANY_A))], "inferops", "publish"))
      .rejects.toThrow("more than one organization");
  });

  it("refuses that person in B's deployment and allows them in A's, when the deployment names its company", async () => {
    // In B's deployment the A connection answers for nothing; in A's, the B connection does.
    expect(await holdsSharedConfiguration([account(1, no(null)), account(2, no(COMPANY_B))], "inferops", "build"))
      .toBe(false);
    expect(await holdsSharedConfiguration([account(1, yes(COMPANY_A)), account(2, no(null))], "inferops", "build"))
      .toBe(true);
  });

  it("never takes a yes that names no company", async () => {
    expect(await holdsSharedConfiguration([account(1, { holds: true, scope: null })], "inferops", "build")).toBe(false);
    expect(await holdsSharedConfiguration([account(1, { holds: true, scope: "" })], "inferops", "build")).toBe(false);
  });

  it("fails the whole check when any account can't answer", async () => {
    await expect(holdsSharedConfiguration([account(1, new Error("down")), account(2, yes(COMPANY_A))], "inferops", "build"))
      .rejects.toThrow("Couldn't check");
  });

  it("only a literal yes counts", async () => {
    expect(await holdsSharedConfiguration([account(1, { holds: "yes", scope: COMPANY_A })], "inferops", "build"))
      .toBe(false);
  });
});

describe("workflow:invoke through the person's own accounts (FAC-102)", () => {
  it("asks each account about the workflow's board only", async () => {
    askedBoards.length = 0;
    await holdsWorkflowInvoke([account(1, yes(COMPANY_A))], "inferops", BOARD);
    expect(askedBoards).toEqual([BOARD]);
  });

  it("combines answers exactly as shared configuration does", async () => {
    expect(await holdsWorkflowInvoke([], "inferops", BOARD)).toBe(false);
    expect(await holdsWorkflowInvoke([account(1, no(COMPANY_A)), account(2, yes(COMPANY_A))], "inferops", BOARD)).toBe(true);
    expect(await holdsWorkflowInvoke([account(1, yes(COMPANY_A), { credentialsExpired: true })], "inferops", BOARD)).toBe(false);
    expect(await holdsWorkflowInvoke([account(1, { holds: true, scope: null })], "inferops", BOARD)).toBe(false);
    await expect(holdsWorkflowInvoke([account(1, yes(COMPANY_A)), account(2, no(COMPANY_B))], "inferops", BOARD))
      .rejects.toThrow("more than one organization");
  });

  it("refuses with its own words when an account can't answer", async () => {
    await expect(holdsWorkflowInvoke([account(1, new Error("down")), account(2, yes(COMPANY_A))], "inferops", BOARD))
      .rejects.toThrow("Couldn't check whether you may run workflows. Try again.");
  });
});
