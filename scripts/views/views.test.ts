import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRegistry, readRegistry, runViewsCommand, viewUrl, type View } from "./views.ts";

const view = (route: string): View => ({
  id: "x", title: "X", kind: "route", parent: null, route, reach: "", component: "X", files: ["a.tsx"],
  components: [], styling: "", selector: null, flags: [], notes: "",
});

test("the view registry matches the frontend's routes and component files", () => {
  // A new route or component needs a view (or a nonViewFiles entry); `pnpm views check` names it.
  assert.deepEqual(checkRegistry(readRegistry()), []);
});

test("urls drop TanStack's un-nesting underscore and require every route param", () => {
  assert.equal(viewUrl(view("/workspace_/$id/inferops-canvas"), "http://localhost:8787", { id: "3" }),
    "http://localhost:8787/workspace/3/inferops-canvas");
  assert.equal(viewUrl(view("*"), "http://localhost:3000", {}), "http://localhost:3000/");
  assert.throws(() => viewUrl(view("/gatekeepers_/$appId"), "http://localhost:8787", {}), /--param appId=/);
});

test("every registered view can be shown, and its subtree's files listed", () => {
  for (const { id } of readRegistry().views) {
    assert.match(runViewsCommand(["show", id]).output, new RegExp(`^${id.replaceAll(".", "\\.")}  `));
    assert.ok(runViewsCommand(["files", id, "--deep"]).output.length > 0);
  }
  assert.throws(() => runViewsCommand(["show", "no.such.view"]), /No view "no\.such\.view"/);
  assert.throws(() => runViewsCommand(["list", "--kind", "widget"]), /Unknown kind/);
});
