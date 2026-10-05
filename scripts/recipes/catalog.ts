/** Synthetic recipe definitions. Domain gaps are part of the output, never implied capabilities. */
export const RECIPES = {
  "field-dispatch": {
    title: "Synthetic field dispatch worklist",
    cards: ["Inspect synthetic pump A", "Review crew assignment for work order B", "Confirm work order C completion"],
    boundaries: ["Tracks work-order status only; no crew assignment or availability enforcement", "No optimizer, maps, mobile offline queue or real field-service provider"],
  },
  "it-triage": {
    title: "Synthetic IT triage worklist",
    cards: ["Triage synthetic sign-in incident", "Review synthetic access request", "Resolve synthetic export failure"],
    boundaries: ["Tracks triage status only; no identity provisioning or real ITSM connector", "The optional Tickets connector is synthetic and must be enabled explicitly"],
  },
  "devops-release": {
    title: "Synthetic incident and release worklist",
    cards: ["Investigate synthetic service incident", "Review fixed-commit release candidate", "Record simulated release decision"],
    boundaries: ["Approval changes an issue status, never deploys a release", "No CI/CD trigger, rollback, cloud credentials or real coding-runner execution"],
  },
} as const;

/** Supported recipe identifiers; no external-agent platform is part of this catalog. */
export type RecipeName = keyof typeof RECIPES;

/** Refuse unknown recipe names before creating any files. */
export const parseRecipeName = (name: string): RecipeName => {
  if (!Object.hasOwn(RECIPES, name)) throw new Error(`Recipe must be one of: ${Object.keys(RECIPES).join(", ")}`);
  return name as RecipeName;
};
