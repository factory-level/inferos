# gatekeeper-tickets

**Status: conformant.** The second connection package, after the InferOps reference. It was generated
with `pnpm gatekeepers:scaffold tickets` and then filled in: a synthetic support-ticket service whose
queues hold tickets that move between `open`, `pending` and `closed`. It exists to prove the package
pattern on something other than InferOps. There is no real Tickets service, so it never becomes
`reference`.

| Status | Meaning | Where it runs |
| --- | --- | --- |
| `scaffold` | Generated, not reviewed | Local development, when selected explicitly |
| `conformant` | Agent-facing contract reviewed; the shared conformance suite passes against the fake provider | Local development, when selected explicitly |
| `reference` | Reviewed against a real provider contract | Releases; the default selection |
| `production` | Accepted live | Releases; the default selection |

Being `conformant`, this package is left out of the release manifest (so the deploy wizard never
offers it) and out of the default custom-gatekeeper selection (`customGatekeepers: "all"` in
`inferos.canvas.json`). It needs no `NO_DEFAULT_CRED_INPUTS` entry for that reason.

## What an agent can do

One binding is one queue, `tickets://demo/queue/<queue>` (the seed has `support` and `billing`).

| Call | Kind | Notes |
| --- | --- | --- |
| `listTickets()` | read, observed | Every ticket in the bound queue |
| `readTicket(id)` | read, observed | A ticket of another queue is refused exactly as an unknown id |
| `setStatus(id, status, expectedRevision)` | approved write | Refused at proposal for a closed ticket or a no-op; refused at apply when the ticket moved on |

## Layout

| Path | What it is |
| --- | --- |
| `src/tickets.ts` | Vendor, account, verifier, the queue gatekeeper and the agent's session |
| `src/types.d.ts` | The agent-facing contract |
| `src/client.ts` | The typed client, over the fake provider only |
| `src/fake-provider.ts` | The synthetic service: revisions, idempotency keys and revocation enforced |
| `__tests__/conformance-adapter.ts` | Maps the shared conformance suite onto the queue gatekeeper (all 11 cases run) |
| `__tests__/tickets.test.ts` | The status rules the shared suite does not state |
| `connection.json` | The package contract, validated by `scripts/connection-package.schema.json` |

## Develop

```sh
pnpm --filter @inferos/gatekeeper-tickets test:run
pnpm canvas gatekeeper enable gatekeeper-tickets   # bind it in pnpm dev-server
```

## SOP

### Setup

Nothing to configure: accounts are auto-provisioned with their own copy of the seed data. Enable it
for local development with the canvas command above, then add a `tickets://demo/queue/support`
resource to a workspace.

### Operate

An agent reads tickets freely (each read is shown as an observation) and proposes status changes.
Before approving, check that the ticket and the target status in the title are the ones you expect:
closing is final through this connector.

### Recover

- `UNAVAILABLE` at apply: the change stays pending; approve it again. The retry sends the same
  idempotency key, so it cannot change the ticket twice.
- `STALE_REVISION` at apply: someone changed the ticket after the proposal. Reject the action and
  ask the agent to read the ticket again.
- After revoking the account its data is gone; bindings fail with `UNAUTHORIZED`, and pending
  changes cannot apply. Remove and re-add the resource to start over with fresh seed data.

### Troubleshooting

- `NOT_FOUND` for a ticket you can see elsewhere: it belongs to another queue than the binding's.
- `INVALID_STATE`: the ticket is closed, or already has that status.
