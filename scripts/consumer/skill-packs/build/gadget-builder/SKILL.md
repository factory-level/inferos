---
name: gadget-builder
description: Plan and build a small Workshop gadget, such as a dashboard, tracker or form, from a plain-language request. Use when asked to make, change or extend an app, widget or tool in the workspace.
---

# Gadget builder

1. **Restate the goal** in one sentence, and list the data the gadget needs and where each piece comes from. Data comes only from granted bindings: a resource reference is not authorization. If a source isn't connected, ask the user to connect it rather than mocking it silently.
2. **Start from the deployment's blueprints** when one fits, instead of writing from scratch.
3. **Keep the interface simple**: one primary action per screen, clear empty and error states, and no decorative clutter.
4. **Bind gatekeepers explicitly.** Give the gadget's persistent code only the bindings it calls.
5. **Separate proposed from applied changes.** Writes that go through a gatekeeper wait for approval, and the UI must say so.
6. **Check it** before calling it done. Open the gadget, try the main flow once, and report what you verified and what you did not.

$ARGUMENT
