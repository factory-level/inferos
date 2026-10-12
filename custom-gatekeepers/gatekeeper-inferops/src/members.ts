// Workspace members (MVP-18): what a members binding may show, and the deployment switch for it.
//
// - Projection. InferOps' `member.list` already answers only the bound workspace's grant holders,
//   with each one's role and explicit denies there. A binding passes on the principal id, kind,
//   name, role and denies of each member, in InferOps' order, and the workspace's id, name and
//   product. The email is never passed on: not its value, and no marker that one was left out.
//   Names and ids are still personal information; this is a narrower view, not an anonymous one.
// - Refusal. A list that is missing or not readable (no grant, no `member:read`, an explicit deny)
//   is one NOT_FOUND, as tables are (http-inferops.ts), so a URL cannot probe which.
// - The switch (`INFEROPS_MEMBERS_ENABLED`) is off unless set to "true", and needs InferOps itself
//   on. Like the other switches it is checked on every call, so a binding or session that exists
//   when it is turned off is refused from its next call and resumes when it is turned back on.

import { InferOpsError, type InferOpsClient, type WorkspaceMembersRead } from "./inferops-client";
import { assertInferOpsEnabled, guarded, inferOpsEnabled } from "./enablement";
import type { WorkspaceMembers } from "./types";

/** The message every call refused by the members switch carries after its `DISABLED: ` code. */
export const MEMBERS_DISABLED_MESSAGE = "InferOps workspace members are turned off for this deployment.";

type MembersEnv = Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "INFEROPS_MEMBERS_ENABLED">;

/** Whether workspace-member bindings are on: only `"true"`, and only while InferOps itself is on. */
export function membersEnabled(env: MembersEnv): boolean {
  return env.INFEROPS_MEMBERS_ENABLED === "true" && inferOpsEnabled(env);
}

/** Throw `DISABLED` while InferOps or workspace members are off, naming whichever is. */
export function assertMembersEnabled(env: MembersEnv): void {
  assertInferOpsEnabled(env);
  if (!membersEnabled(env)) throw new InferOpsError("DISABLED", MEMBERS_DISABLED_MESSAGE);
}

/** A client for a members binding: every call (`forget` aside) is refused while either switch is off. */
export function whileMembersEnabled(env: MembersEnv, open: () => InferOpsClient): InferOpsClient {
  return guarded(() => assertMembersEnabled(env), open);
}

/** The one answer for a member list that is missing or not readable, whatever the reason. */
export function membersNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such member list is available to you.");
}

/** What a caller may see of one `member.list` answer: no email, nothing else added. */
export function projectMembers(read: WorkspaceMembersRead): WorkspaceMembers {
  const { workspaceId, workspaceName, product } = read.workspace;
  return {
    workspace: { workspaceId, workspaceName, product },
    members: read.members.map(({ principalId, type, name, role, deniedPermissions }) => ({
      principalId, type, name, role, deniedPermissions: [...deniedPermissions],
    })),
  };
}
