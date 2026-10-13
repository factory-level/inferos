# InferOps Workflow policy

Shows one InferOps project's published content-workflow policy, read-only:
- the policy's revision, whether it is published, and when;
- its lanes in order;
- its top-level rules, fragments, lane bindings (with their guards) and transitions, each subject
  and action exactly as written.

Rule reasons, agent notes and the publisher are never shown. InferOps stays authoritative: this
gadget stores nothing of its own and reads the policy through its binding on every load. It shows
the published document; it does not work out who may do what.

## Binding

The gadget needs one binding named exactly **`policy`**: an InferOps project workflow policy from the
`inferops` gatekeeper, whose agent-facing type is `InferOpsWorkflowPolicySession`.
- **Resource URL:** `inferops://<tenant>.<workspace>/project/workflow/<KEY>`, where `<workspace>`
  must be one of your InferOps workspaces and `<KEY>` a project in it. Use
  `inferops://demo.local/project/workflow/DEMO` for the demo project.

To wire it up from chat:
1. If your env has no suitable InferOps workflow policy, call `requestConnection` with vendorId
   `inferops` and that resource URL.
2. Bind it into this gadget with `setGadgetBinding`, binding name `policy`.

What it can reach:
- **The URL only names the project.** The connection decides what the gadget can reach, and InferOps
  answers only what you may read there under your own access. The gadget cannot switch projects.
- **The connection is private:** a gadget that uses it cannot be shared with collaborators, and it is
  not available in an operate chat.
- **The switch:** the deployment's workflow-policy switch must be on.

Without the binding the gadget shows a "No InferOps workflow policy connected" notice.

## How it works

- **server.js** (`Gadget`) has one call, `loadPolicy()` → `policy.readWorkflowPolicy()`. It returns
  either `{ok: true, head}` or `{ok: false, reason}`, with `reason` one of:
  - `not-connected`;
  - `unavailable` (missing, refused, or the sign-in ended);
  - `disabled` (workflow policies turned off);
  - `error`.

  It stores nothing. Its `ExportHandler` offers no export formats.
- **client.js** draws the head first: project id, workflow, revision, published or not, when, and the
  source compiled hash. That hash is InferOps' hash of its compiled policy, metadata only and not a
  hash of what is shown. Then come the lanes, rules, fragments, lane bindings and transitions, in the
  order InferOps gives them.
  - **Only named fields are drawn,** and names and values are text, never markup.
  - **Each load clears what was shown,** and only the answer to the latest load is drawn.
  - **A refusal clears the policy.**
  - **The only control is Reload:** there is no edit, publish, validate or export.
- **Personal information:** principal ids named in the policy stay; they are personal information.

## Source

In the repository this is TypeScript under
`packages/bundled-blueprints/blueprints/inferops-workflow-policy/files/`:
- `client.ts` and `server.ts`;
- `lib/protocol.ts`, the shared types;
- `lib/policy.ts`, the pure rules.

They are bundled into the `client.js` and `server.js` this gadget runs.
