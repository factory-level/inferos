// The demo data: synthetic installations, figures, support issues and runbook text, deterministic,
// chosen so that every region state the page draws is reachable from the picker. No real person,
// customer, account or installation is described. A few strings in installation A carry markup on
// purpose, so the page is seen to draw it as text.
import type {
  BoardData, DemoInstallation, ModelledOn, Region, RunbookData, RunbookMissing, SupportIssue, SupportPage, TileData,
} from "./protocol.ts";

/** Every installation's page is read at the same deterministic moment. */
export const READ_AT = "2026-10-12T12:00:00.000Z";
const DAY_START = "2026-10-12T00:00:00.000Z";

const installation = (n: number, installationName: string): DemoInstallation => ({
  installationId: `00000000-0000-4000-8000-0000000df${String(n).padStart(3, "0")}`,
  installationName,
});

const people = (asOf: string, count: number | null): Region<TileData> => ({
  state: "reported", source: "demo-fixture", modelledOn: "activity/v1", asOf,
  data: { window: { from: DAY_START, to: asOf }, count },
});
const runsFailed = (asOf: string, count: number | null): Region<TileData> => ({
  state: "reported", source: "demo-fixture", modelledOn: "project_issue_runs", asOf,
  data: { window: { from: new Date(Date.parse(asOf) - 24 * 3_600_000).toISOString(), to: asOf }, count },
});
const board = (asOf: string, data: BoardData): Region<BoardData> =>
  ({ state: "reported", source: "demo-fixture", modelledOn: "inferops.project-board", asOf, data });
const runbook = (asOf: string, data: RunbookData): Region<RunbookData, RunbookMissing> =>
  ({ state: "reported", source: "demo-fixture", modelledOn: "inferops.wiki", asOf, data });
const denied = (modelledOn: ModelledOn) => ({ state: "denied", source: "demo-fixture", modelledOn }) as const;
const unavailable = (modelledOn: ModelledOn, message: string) =>
  ({ state: "unavailable", source: "demo-fixture", modelledOn, message }) as const;

const MARKUP = `<img src=x onerror=alert(1)>`;

const SUP_14: SupportIssue = {
  identifier: "SUP-14", title: "Demo: export to CSV drops the last row", priority: "high", targetDate: null,
  blockedReason: null,
};
const SUP_9: SupportIssue = {
  identifier: "SUP-9", title: "Demo: sign-in loops for the demo tenant", priority: "urgent", targetDate: "2026-10-14",
  blockedReason: "Waiting for the demo gatekeeper to restart (synthetic)",
};
const SUP_12: SupportIssue = {
  identifier: "SUP-12", title: `Demo: report title shows ${MARKUP} literally`, priority: "medium", targetDate: null,
  blockedReason: null,
};
const SUP_7: SupportIssue = {
  identifier: "SUP-7", title: "Demo: password reset email wording", priority: "none", targetDate: null,
  blockedReason: null,
};

const columns = (triage: SupportIssue[], todo: SupportIssue[], doing: SupportIssue[], done: SupportIssue[]) => [
  { name: "Triage", group: "backlog" as const, issues: triage },
  { name: "To do", group: "unstarted" as const, issues: todo },
  { name: "In progress", group: "started" as const, issues: doing },
  { name: "Resolved", group: "completed" as const, issues: done },
];
const PROJECT = { identifier: "SUP", name: "Customer support (demo)" };

const RUNBOOK_A: RunbookData = {
  slug: "support-runbook",
  title: "Support runbook (demo)",
  version: 7,
  editedAt: "2026-10-09T15:20:00.000Z",
  sections: [
    {
      heading: "First response",
      blocks: [
        { kind: "paragraph", text: "Answer every new support issue within one working hour (demo guidance)." },
        { kind: "steps", items: [
          "Read the issue and confirm which installation it is about.",
          `Copy the error text exactly, even if it contains markup such as ${MARKUP}.`,
          "Set a priority and move the issue out of Triage.",
        ] },
      ],
    },
    {
      heading: "Escalation",
      blocks: [
        { kind: "steps", items: [
          "If an issue is urgent, say so on the SUP board.",
          "Note what was tried in the issue before escalating.",
          "Ask the on-call engineer named in the demo rota.",
          "Record the outcome on the SUP board when it is resolved.",
        ] },
      ],
    },
    {
      heading: "Known issues",
      blocks: [{ kind: "paragraph", text: "The demo gatekeeper may need a restart after a configuration change." }],
    },
  ],
};

export const DEMO_INSTALLATIONS: ReadonlyArray<{
  installation: DemoInstallation;
  page: Omit<SupportPage, "installation" | "readAt">;
}> = [
  {
    // Everything reporting, fresh. Real zeros: runs failed, and the empty To do column.
    installation: installation(1, "Demo Installation A"),
    page: {
      peopleActiveToday: people("2026-10-12T11:30:00.000Z", 6),
      runsFailed24h: runsFailed("2026-10-12T11:30:00.000Z", 0),
      board: board("2026-10-12T11:55:00.000Z", {
        project: PROJECT,
        columns: columns(
          [{ ...SUP_14, blockedReason: `Customer pasted ${MARKUP} into the report` }],
          [],
          [SUP_9, SUP_12],
          [SUP_7],
        ),
      }),
      runbook: runbook("2026-10-12T11:55:00.000Z", RUNBOOK_A),
    },
  },
  {
    // Partial: a figure not reported, a stale tile and board, and no runbook page.
    installation: installation(2, "Demo Installation B"),
    page: {
      peopleActiveToday: people("2026-10-12T11:30:00.000Z", null),
      runsFailed24h: runsFailed("2026-10-12T09:00:00.000Z", 2),
      board: board("2026-10-12T10:00:00.000Z", { project: PROJECT, columns: columns([SUP_14], [], [SUP_9], []) }),
      runbook: { state: "missing", source: "demo-fixture", modelledOn: "inferops.wiki", slug: "support-runbook" },
    },
  },
  {
    // Quiet: everything reported and fresh, nothing happened, and the runbook has nothing to read.
    installation: installation(3, "Demo Installation C"),
    page: {
      peopleActiveToday: people("2026-10-12T11:30:00.000Z", 0),
      runsFailed24h: runsFailed("2026-10-12T11:30:00.000Z", 0),
      board: board("2026-10-12T11:55:00.000Z", { project: PROJECT, columns: columns([], [], [], []) }),
      runbook: runbook("2026-10-12T11:55:00.000Z", {
        slug: "support-runbook", title: "Support runbook (demo)", version: 1, editedAt: "2026-10-01T09:00:00.000Z",
        sections: [],
      }),
    },
  },
  {
    // No access (a fixture state: it shows how a refusal is presented, and proves no authorization).
    installation: installation(4, "Demo Installation D"),
    page: {
      peopleActiveToday: denied("activity/v1"),
      runsFailed24h: denied("project_issue_runs"),
      board: denied("inferops.project-board"),
      runbook: denied("inferops.wiki"),
    },
  },
  {
    // Nothing reachable.
    installation: installation(5, "Demo Installation E"),
    page: {
      peopleActiveToday: unavailable("activity/v1", "The demo activity source is offline (synthetic error)."),
      runsFailed24h: unavailable("project_issue_runs", "The demo run source is offline (synthetic error)."),
      board: unavailable("inferops.project-board", "The demo board source is offline (synthetic error)."),
      runbook: unavailable("inferops.wiki", "The demo Wiki is offline (synthetic error)."),
    },
  },
];
