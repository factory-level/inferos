# Console-read wire contract

`POST /api/operate/agui/console` uses the same authenticated one-shot input,
prepared selectors and immutable chat history as `/api/operate/agui`. The original
endpoint remains page-only. The console endpoint persists a separate read policy:
`operatePage`, `listConsoleTools`, `callConsoleTool`; no writes or client tools.
`CONSOLE_TOOLS` still gates both discovery and invocation.

AG-UI 1.0 state `consoleRead` is a version-1 projection of the current published
console: its workspace/revision/view/screen references, registered read descriptors
and placed board references/layout. Descriptors name the existing C6 gateway
`callConsoleTool` and its frozen `widgetId`/`tool` arguments. Authored descriptions
stay inside C5b's untrusted frame, never a system prompt. The projection comes from
the same authorized C5b registry walk, after the selected chat's durable taint mark.
State is presentation, never a capability. Callers cannot submit it as authority.
The `capabilities` member uses the pinned `AgentCapabilities` schema: SSE, state
snapshots/deltas, page read and currently offered C6 gateway schemas; client tools,
resume, interrupts/approvals and multi-agent support are explicitly disabled.

`ACTIVITY_SNAPSHOT` with type `inferos.console-boards.v1` and a stable run-local
message ID replaces the current board layout. It contains only versioned widget
references and layout; consumers resolve board data with their own authority.
Unavailable/replaced selections clear the activity. No Wiki or authored UI is exposed.

The adapter refreshes authorization before releasing durable messages and on page
updates, and while a model is pending. A changed page invalidates the prior projection
immediately; stale asynchronous reads are discarded. Presence, where a board subject
exists, is a bounded snapshot of the existing authorized subject roster, not a new
presence protocol; its temporary subscription is disposed after each read.

Canonical tool events and message snapshots retain C6 names, arguments, correlated
results and framed errors from committed history. Historical results are records,
not callable descriptors. Replay never invokes them; a crash before the durable step
barrier may rerun a read. No reconnect/resume, approvals or multi-agent support is added.
