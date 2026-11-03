// The one company this InferOS deployment belongs to (inferops ADR 0009 T6, FAC-160).
//
// InferOps is the authority: its token exchange refuses the `inferos` client a session in any
// company but the one its `auth.sso.inferosCompanies` names for this deployment's origin. This is
// the gatekeeper's second check. With `INFEROPS_COMPANY` set to a tenant id, a sign-in, connect or
// reconnect whose session is in another company is refused and signed out, and a stored
// connection from another company is never used. `internal` (InferLab's own deployment, reserved
// tenants only) leaves the decision to InferOps, which holds the reserved list. Unset (local
// development) does the same. The binding only refuses: it grants nothing.

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `INFEROPS_COMPANY` names. `unset` and `internal` defer to InferOps. */
export type DeploymentCompany =
  | { kind: "unset" }
  | { kind: "internal" }
  | { kind: "tenant"; tenantId: string };

/** The settings this check reads. */
export type DeploymentCompanyEnv = { INFEROPS_COMPANY?: string };

/** Shown when a session belongs to another company. Names neither company. */
export const OTHER_COMPANY =
  "This InferOS belongs to another company. In InferLab, choose the company this InferOS is for, " +
  "then sign in again.";

/** Shown when `INFEROPS_COMPANY` is set but malformed; sign-in is off until it is fixed. */
export const COMPANY_MISCONFIGURED =
  "This deployment's InferOps company setting is invalid, so InferLab sign-in is off. Ask its " +
  "administrator to check INFEROPS_COMPANY.";

/** The deployment's company, or null when `INFEROPS_COMPANY` is set but malformed. */
export function deploymentCompany(env: DeploymentCompanyEnv): DeploymentCompany | null {
  const raw = env.INFEROPS_COMPANY?.trim();
  if (!raw) return { kind: "unset" };
  if (raw === "internal") return { kind: "internal" };
  return TENANT_ID.test(raw) ? { kind: "tenant", tenantId: raw.toLowerCase() } : null;
}

/** Whether a session in `tenantId` may be used here. Only a named tenant id refuses anything. */
export function companyAdmits(company: DeploymentCompany, tenantId: string): boolean {
  return company.kind !== "tenant" || company.tenantId === tenantId.toLowerCase();
}
