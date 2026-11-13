// A console that belongs to no workspace (ADR 0021): one Durable Object holds the console, its
// pages, its draft and publication, and who it is shared with. It names no workspace and none
// names it; a workspace remains where apps, widgets and agent workflows are built.
//
// It reuses the workspace's own stores unchanged (WorkspaceCanvasStore, WorkspaceConsoleStore,
// SharingManager) over storage of its own that has the same shape. The collections only a
// workspace fills (gadgets, flows, bound hooks) stay empty here, so everything that needs one is
// refused before a store sees it: the `inferos.gadget` widget kind, and a console's registered
// widgets, host boards, bound views and flows.

import { DurableObject } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { collection, createTypedStorage, singleton } from "@gadgets/typed-storage";
import {
  OPEN_GADGET_ERROR_CODES, createOpenGadgetError,
  type AiChatAuthorInfo, type CollaboratorInfo, type CollaboratorRole, type ConsoleAuthoring,
  type ConsoleReading, type ConsoleSummary,
} from "@gadgets/workshop-shared/api";
import type { CanvasContent, CanvasDefinition, CanvasOperation } from "@gadgets/workshop-shared/canvas";
import type { CanvasPage, CanvasPageOperation } from "@gadgets/workshop-shared/canvas-model";
import type {
  ConsoleDraftProblem, ConsoleSource, OperateConsole, OperateConsoleContent,
} from "@gadgets/workshop-shared/operate-console";
import type { OperateFlow } from "@gadgets/workshop-shared/operate-flow";
import type { WorkspaceConfiguration } from "@gadgets/workshop-shared/workspace-settings";
import { collaboratorAccountName } from "./account-subject";
import { readCanvasCatalog } from "./canvas-catalog";
import { WorkspaceCanvasStore, type StoredCanvasPage } from "./canvas-store";
import {
  WorkspaceConsoleStore, consoleScreenKey, type ConsoleScreenSnapshot,
} from "./console-store";
import { createWorkshopLogger } from "./observability";
import type { OverseerStorage, WorkpieceRecord } from "./overseer";
import {
  SharingManager, watchSharingAuthzInputs, type CollaboratorRecord, type ShareKeyRecord,
} from "./sharing";
import type { UserDurableObject } from "./user";
import type { UserDirectoryDurableObject } from "./user-directory";

const logger = createWorkshopLogger("workshop.console-object");

/** What every refused write of something only a workspace holds says. */
export const CONSOLE_WORKSPACE_ONLY =
  "Widgets, host boards, bound views and flows built in a workspace are not available on this console yet.";

/** Who a console belongs to: fixed when it is created, and never changed. */
export type ConsoleOwner = {
  /** The owner's user Durable Object id. */
  userId: string;
  /** The owner's profile, whose `id` is their account name. */
  profile: AiChatAuthorInfo;
  /**
   * The company the owner was working in when they created the console. Recorded for a later rule;
   * nothing reads it yet.
   */
  company: string;
};

/** A bound hook as a workspace stores it; a console holds none. */
type BoundHook = Parameters<OverseerStorage["boundHooks"]["put"]>[0];

function makeConsoleStorage(storage: DurableObjectStorage) {
  let typed = createTypedStorage(storage, {
    singletons: {
      owner: singleton<ConsoleOwner | null>(null),
      // This console's id in `consoles`, which the store mints.
      consoleId: singleton<string | null>(null),
      workspaceConfiguration: singleton<WorkspaceConfiguration | null>(null),
      authzGeneration: 0,
    },
    collections: {
      // The same shapes as the workspace's (see makeOverseerStorage), which the stores require.
      consoles: collection<OperateConsole>()({ primaryKey: "id" }),
      canvases: collection<CanvasDefinition>()({ primaryKey: "id" }),
      canvasPages: collection<StoredCanvasPage>()({ primaryKey: record => record.page.id }),
      consoleScreens: collection<ConsoleScreenSnapshot>()({
        primaryKey: record => consoleScreenKey(record.consoleId, record.screenId),
      }),
      // Always empty: only a workspace holds gadgets, flows and bound hooks.
      gadgets: collection<WorkpieceRecord>()({
        primaryKey: "id",
        uniqueIndexes: { byBindingName(record: WorkpieceRecord) { return record.bindingName ?? null; } },
      }),
      flows: collection<OperateFlow>()({ primaryKey: "id" }),
      boundHooks: collection<BoundHook>()({ primaryKey: "id" }),
      collaborators: collection<CollaboratorRecord>()({ primaryKey: record => record.profile.id }),
      // Share links are not offered on a console; the sharing manager's storage still names them.
      shareKeys: collection<ShareKeyRecord>()({
        primaryKey: "id",
        nonUniqueIndexes: { byAlias(record: ShareKeyRecord) { return record.alias ?? null; } },
      }),
    },
  });
  watchSharingAuthzInputs(typed);
  return typed;
}

type ConsoleObjectStorage = ReturnType<typeof makeConsoleStorage>;

/** What a console's capabilities need of the object that holds it. */
type ConsoleHome = {
  id: string;
  storage: ConsoleObjectStorage;
  durableStorage: DurableObjectStorage;
  env: Cloudflare.Env;
  users: DurableObjectNamespace<UserDurableObject>;
  directory: DurableObjectNamespace<UserDirectoryDurableObject>;
};

/** The console's owner, refused once it was deleted or before it was created. */
function ownerOf(home: ConsoleHome): ConsoleOwner {
  let owner = home.storage.owner.get();
  if (!owner) throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
  return owner;
}

function sharingOf(home: ConsoleHome): SharingManager {
  return new SharingManager(home.storage, ownerOf(home).profile.id, () => false);
}

/** The caller's role now, or a refusal: read at every call, so a removal takes effect at once. */
function requireRole(home: ConsoleHome, profileId: string, needed: CollaboratorRole): CollaboratorRole {
  let role = sharingOf(home).getEffectiveRole(profileId);
  if (!role || (needed === "build" && role !== "build")) {
    throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
  }
  return role;
}

/** The stores' environment: the deployment's, with the catalog narrowed to what a console holds. */
function storeEnv(env: Cloudflare.Env): Cloudflare.Env {
  let catalog = readCanvasCatalog(env);
  return { ...env, CANVAS_CATALOG: JSON.stringify({ ...catalog, blueprints: [],
    widgetKinds: catalog.widgetKinds.filter(kind => kind !== "inferos.gadget") }) };
}

function canvasStore(home: ConsoleHome): WorkspaceCanvasStore {
  return new WorkspaceCanvasStore(home.durableStorage, home.storage, storeEnv(home.env));
}

function consoleStore(home: ConsoleHome): WorkspaceConsoleStore {
  return new WorkspaceConsoleStore(home.durableStorage, home.storage, storeEnv(home.env));
}

function consoleIdOf(home: ConsoleHome): string {
  let id = home.storage.consoleId.get();
  if (!id) throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
  return id;
}

function summaryOf(home: ConsoleHome, console: OperateConsole, role: CollaboratorRole): Omit<ConsoleSummary, "created"> {
  return { id: home.id, title: console.title, role, published: console.published !== null };
}

/**
 * Refreshes the console's listing for its owner and everyone it is shared with. A listing is
 * presentation only (opening checks access again), so a failure is logged and nothing is undone.
 */
async function refreshListings(home: ConsoleHome): Promise<void> {
  let stored = consoleStore(home).get(consoleIdOf(home), "draft");
  if (!stored) return;
  let people = [
    { user: home.users.get(home.users.idFromString(ownerOf(home).userId)), role: "build" as CollaboratorRole },
    ...sharingOf(home).listCollaborators().map(collaborator => ({
      user: home.users.get(home.users.idFromName(collaborator.profile.id)), role: collaborator.role ?? "use",
    })),
  ];
  let results = await Promise.allSettled(people.map(person => person.user.recordConsole(summaryOf(home, stored, person.role))));
  for (let result of results) {
    if (result.status === "rejected") {
      logger.warn("failed to list a console for someone it is shared with", {
        event: "console.listing.refresh.failed", error: result.reason,
      });
    }
  }
}

@validateRpc()
class ConsoleReadingImpl extends RpcTarget implements ConsoleReading {
  constructor(private home: ConsoleHome, private profileId: string) { super(); }

  #store(): WorkspaceConsoleStore {
    requireRole(this.home, this.profileId, "use");
    return consoleStore(this.home);
  }

  async getConsole(): Promise<OperateConsole | null> {
    return this.#store().get(consoleIdOf(this.home), "published");
  }
  async getConsoleScreen(screenId: string): Promise<CanvasDefinition | null> {
    return this.#store().screen(consoleIdOf(this.home), screenId, "published");
  }
  async getConsolePage(screenId: string): Promise<CanvasPage | null> {
    return this.#store().page(consoleIdOf(this.home), screenId, "published");
  }
}

@validateRpc()
class ConsoleAuthoringImpl extends RpcTarget implements ConsoleAuthoring {
  constructor(private home: ConsoleHome, private userId: string, private profileId: string) { super(); }

  #canvases(): WorkspaceCanvasStore {
    requireRole(this.home, this.profileId, "build");
    return canvasStore(this.home);
  }
  #consoles(): WorkspaceConsoleStore {
    requireRole(this.home, this.profileId, "build");
    return consoleStore(this.home);
  }
  #requireOwner(): void {
    if (ownerOf(this.home).profile.id !== this.profileId) throw new Error("Only the console's owner can do that.");
  }
  get #id(): string { return consoleIdOf(this.home); }

  async listCanvases(): Promise<CanvasDefinition[]> { return this.#canvases().list(); }
  async getCanvas(id: string): Promise<CanvasDefinition | null> { return this.#canvases().get(id); }
  async getCanvasPage(id: string): Promise<CanvasPage | null> { return this.#canvases().getPage(id); }
  async createCanvas(content: CanvasContent): Promise<CanvasDefinition> { return this.#canvases().create(content); }
  async editCanvas(id: string, expectedRevision: string, operations: CanvasOperation[]): Promise<CanvasDefinition> {
    return this.#canvases().edit(id, expectedRevision, operations);
  }
  async editCanvasPage(id: string, expectedRevision: string, operations: CanvasPageOperation[]): Promise<CanvasPage> {
    return this.#canvases().editPage(id, expectedRevision, operations);
  }
  async deleteCanvas(id: string, expectedRevision: string): Promise<void> {
    this.#canvases().delete(id, expectedRevision);
  }

  async getConsole(source: ConsoleSource): Promise<OperateConsole | null> {
    return this.#consoles().get(this.#id, source);
  }
  async getConsoleScreen(screenId: string, source: ConsoleSource): Promise<CanvasDefinition | null> {
    return this.#consoles().screen(this.#id, screenId, source);
  }
  async getConsolePage(screenId: string, source: ConsoleSource): Promise<CanvasPage | null> {
    return this.#consoles().page(this.#id, screenId, source);
  }

  async replaceConsole(expectedRevision: string, content: OperateConsoleContent): Promise<OperateConsole> {
    let store = this.#consoles();
    if (content.widgets?.length || content.hostBoards?.length || content.boundViews?.length || content.flows?.length) {
      throw new Error(CONSOLE_WORKSPACE_ONLY);
    }
    let saved = store.replace(this.#id, expectedRevision, content);
    await refreshListings(this.home);
    return saved;
  }

  async validateConsoleDraft(): Promise<ConsoleDraftProblem[]> {
    let store = this.#consoles();
    let draft = store.get(this.#id, "draft");
    if (!draft) throw new Error("Console not found");
    return store.draftProblems(this.#id, draft.revision, new Map());
  }

  async publishConsole(expectedRevision: string): Promise<OperateConsole> {
    let store = this.#consoles();
    let user = this.home.users.get(this.home.users.idFromString(this.userId));
    if (!await user.holdsSharedConfiguration("publish")) {
      throw new Error("You don't have permission to publish shared configuration.");
    }
    let profile = await user.whoami();
    // Access is read again after the awaits above, in the same step as the write.
    requireRole(this.home, this.profileId, "build");
    let published = store.publish(this.#id, expectedRevision, undefined, undefined, { id: profile.id, name: profile.name });
    await refreshListings(this.home);
    return published;
  }

  async listCollaborators(): Promise<CollaboratorInfo[]> {
    this.#consoles();
    return sharingOf(this.home).listCollaborators();
  }

  async addCollaborator(username: string, role: CollaboratorRole): Promise<CollaboratorInfo | null> {
    this.#consoles();
    this.#requireOwner();
    let accountName = await collaboratorAccountName({ users: this.home.users, directory: this.home.directory }, username);
    if (accountName === null) return null;
    let profile = await this.home.users.get(this.home.users.idFromName(accountName)).whoamiIfExists();
    if (!profile) return null;
    this.#requireOwner();
    let added = sharingOf(this.home).addCollaborator({ caller: { profileId: this.profileId, isOwner: true }, profile, role });
    await refreshListings(this.home);
    return added;
  }

  async removeCollaborator(profileId: string): Promise<void> {
    this.#consoles();
    this.#requireOwner();
    sharingOf(this.home).removeCollaborator({ profileId: this.profileId, isOwner: true }, profileId, []);
    try {
      await this.home.users.get(this.home.users.idFromName(profileId)).forgetConsole(this.home.id);
    } catch (error) {
      logger.warn("failed to stop listing a console for someone removed from it", {
        event: "console.listing.forget.failed", error,
      });
    }
  }
}

/** One console that belongs to no workspace: see the file comment. */
export class ConsoleDurableObject extends DurableObject<Cloudflare.Env> {
  #home: ConsoleHome;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#home = {
      id: ctx.id.toString(),
      storage: makeConsoleStorage(ctx.storage),
      durableStorage: ctx.storage,
      env,
      users: ctx.exports.UserDurableObject,
      directory: ctx.exports.UserDirectoryDurableObject,
    };
  }

  /**
   * Creates the console for `owner`, once: one blank page, and a draft whose only view shows it
   * (a console must show at least one screen). Reached only from Worker code that has
   * authenticated `owner` (AuthenticatedApi.newConsole).
   */
  async initialize(owner: ConsoleOwner, title: string): Promise<Omit<ConsoleSummary, "created">> {
    let home = this.#home;
    if (home.storage.owner.get()) throw new Error("This console already exists.");
    return this.ctx.storage.transactionSync(() => {
      home.storage.owner.put(owner);
      let page = canvasStore(home).create({
        title: "Overview", sections: [{ id: crypto.randomUUID(), title: "Overview", columns: 2, widgets: [] }],
      });
      let created = consoleStore(home).create({
        title, fullChat: "available", views: [{ id: "overview", title: "Overview", type: "screen", screen: page.id }],
      });
      home.storage.consoleId.put(created.id);
      return summaryOf(home, created, "build");
    });
  }

  /** The caller's listing of this console, or a refusal when it does not admit them. */
  async summaryFor(profileId: string): Promise<Omit<ConsoleSummary, "created">> {
    let role = requireRole(this.#home, profileId, "use");
    let stored = consoleStore(this.#home).get(consoleIdOf(this.#home), "draft");
    if (!stored) throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
    return summaryOf(this.#home, stored, role);
  }

  /** See AuthenticatedApi.openConsoleReading(). The caller has authenticated `profileId`. */
  async openReading(profileId: string): Promise<ConsoleReading> {
    requireRole(this.#home, profileId, "use");
    return new ConsoleReadingImpl(this.#home, profileId);
  }

  /** See AuthenticatedApi.openConsoleAuthoring(). The caller has authenticated both ids. */
  async openAuthoring(userId: string, profileId: string): Promise<ConsoleAuthoring> {
    requireRole(this.#home, profileId, "build");
    return new ConsoleAuthoringImpl(this.#home, userId, profileId);
  }
}
