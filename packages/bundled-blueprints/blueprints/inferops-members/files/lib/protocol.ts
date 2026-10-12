// The contract between this gadget's client and its Durable Object, plus the slice of the InferOps
// gatekeeper's agent-facing API (InferOpsMembersSession) the Durable Object calls. Imported
// type-only, so nothing of it ships.

/** One member of the workspace: a person or agent holding access there. */
export interface WorkspaceMember {
  principalId: string;
  /** "user" for a person, "service_account" for an agent. */
  type: "user" | "service_account";
  name: string;
  /** Their role in this workspace, such as "owner", "admin", "member" or "viewer". */
  role: string;
  /** Permissions explicitly denied to them in this workspace; a deny wins over the role. */
  deniedPermissions: string[];
}

/** The members of one workspace. Email addresses are not included. */
export interface WorkspaceMembers {
  workspace: { workspaceId: string; workspaceName: string; product: "inferops" | "infermind" };
  members: WorkspaceMember[];
}

/** The `members` binding: one InferOps workspace's member list, fixed by the connection. */
export interface InferOpsMembersSession {
  listMembers(): Promise<WorkspaceMembers>;
}

/**
 * One load. `unavailable` covers a list that is missing or refused, or whose sign-in ended (the
 * binding says which only in its message); `disabled` is the deployment's switch.
 */
export type LoadMembersResult =
  | { ok: true; workspace: WorkspaceMembers["workspace"]; members: WorkspaceMember[] }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "unavailable" | "disabled" | "error"; message: string };

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  loadMembers(): Promise<LoadMembersResult>;
}
