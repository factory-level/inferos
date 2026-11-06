import type { GadgetStub, ServiceJob, ServiceQueryName, ServiceQueryPage } from "./protocol.ts";
declare const gadget: GadgetStub;

/** Render one service widget, or the combined view when no query is selected. */
export function mountServiceDashboard(selected?: ServiceQueryName) {
const style = document.createElement("style");
style.textContent = `
:root{color-scheme:light dark;font:14px/1.5 system-ui;color:CanvasText;background:Canvas}
*{box-sizing:border-box}body{margin:0;padding:20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:0 0 12px}.meta{color:GrayText;font-size:13px}
main{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-top:20px}article{padding:16px;border:1px solid ButtonBorder;border-radius:10px;background:Canvas}
article:first-child{grid-row:span 2}button,input,textarea{font:inherit}button{padding:6px 12px;cursor:pointer}button:disabled{cursor:wait}ul{padding:0;list-style:none}li{border-bottom:1px solid ButtonBorder;padding:12px 0}.job-title{font-weight:600}.relations{font-size:12px}.status{min-height:24px}textarea{width:100%;min-height:72px;margin:8px 0}form{margin:8px 0}summary{cursor:pointer}.error{color:CanvasText;font-weight:600}
@media print{button,form,details{display:none!important}main{display:block}article{break-inside:avoid;border:0}body{padding:0}}
@media(max-width:700px){main{grid-template-columns:1fr}article:first-child{grid-row:auto}body{padding:12px}}
`;
document.head.append(style);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag); if (text) node.textContent = text; return node;
}
const header = el("header");
const title = el("div"); title.append(el("h1", "Service dashboard"), el("p", "Current permitted records in the connected project."));
const refresh = el("button", "Refresh all"); header.append(title, refresh);
const main = el("main"); if (selected) { main.style.display = "block"; refresh.textContent = "Refresh"; } document.body.append(header, main);
const definitions: Array<[ServiceQueryName, string]> = [
  ["service-jobs", "Service jobs"], ["service-job-status-counts", "Status counts"], ["service-job-recent-activities", "Recent activity"],
];

function jobRow(job: ServiceJob) {
  const row = el("li"); const heading = el("p", `${job.identifier} · ${job.title}`); heading.className = "job-title";
  row.append(heading, el("p", job.state.name));
  const relations = el("p", [...job.customers, ...job.sites, ...job.contacts].map(item => item.label).join(" · ") || "No permitted related records");
  relations.className = "relations"; row.append(relations);
  if (job.relatedTruncated) row.append(el("p", "Additional related records are available in InferOps."));
  const details = el("details"); details.append(el("summary", "Add comment"));
  const form = el("form"); const body = el("textarea"); body.required = true; body.maxLength = 20_000; body.setAttribute("aria-label", `Comment on ${job.identifier}`);
  const submit = el("button", "Submit comment"); submit.type = "button"; const status = el("p"); status.setAttribute("role", "status"); form.append(body, submit, status);
  submit.addEventListener("click", async () => {
    // Gadget iframes intentionally omit allow-forms; invoke the capability without native submission.
    if (!body.reportValidity()) return;
    submit.disabled = true;
    try {
      const result = await gadget.comment(job.id, body.value, job.headSeq);
      status.textContent = result.ok ? "Comment submitted. Review the pending action, then refresh." : "Comment was refused or the record changed. Refresh and try again.";
      if (result.ok) body.value = "";
    } catch { status.textContent = "Comment could not be submitted. Refresh before trying again."; }
    finally { submit.disabled = false; }
  });
  details.append(form); row.append(details); return row;
}

function rows(page: ServiceQueryPage): HTMLElement {
  const list = el("ul");
  if (page.rows.length === 0) { list.append(el("li", "No permitted records match.")); return list; }
  if (page.name === "service-jobs") page.rows.forEach(job => list.append(jobRow(job)));
  else if (page.name === "service-job-status-counts") page.rows.forEach(count => list.append(el("li", `${count.group}: ${count.count}`)));
  else page.rows.forEach(activity => list.append(el("li", `${activity.body ?? activity.kind} · ${new Date(activity.createdAt).toLocaleString()}`)));
  return list;
}

const loaders = definitions.filter(([name]) => selected === undefined || name === selected).map(([name, heading]) => {
  const article = el("article"); article.dataset.widget = name;
  const title = el("h2", heading); const status = el("p"); status.setAttribute("role", "status");
  const content = el("div"); const more = el("button", "Load next page"); more.hidden = true;
  article.append(title, status, content, more); main.append(article);
  let generation = 0; let cursor: string | null = null;
  const load = async (next = false) => {
    const current = ++generation; status.textContent = "Loading…"; status.className = "status"; more.disabled = true;
    if (!next) { content.replaceChildren(); cursor = null; more.hidden = true; }
    try {
      const result = await gadget.query(name, next ? cursor ?? undefined : undefined);
      if (current !== generation) return;
      if (!result.ok) {
        content.replaceChildren(); more.hidden = true; status.className = "status error";
        status.textContent = result.reason === "not-connected" ? "Connect a service project to load this widget." : result.reason === "denied" ? "This connection can no longer read these records." : "Records could not be loaded. Refresh to retry.";
        return;
      }
      content.replaceChildren(rows(result.page)); cursor = result.page.nextCursor; more.hidden = cursor === null;
      status.textContent = cursor ? "More records available. Showing one page." : "End of results.";
    } catch { if (current === generation) { content.replaceChildren(); status.textContent = "Records could not be loaded. Refresh to retry."; status.className = "status error"; } }
    finally { if (current === generation) more.disabled = false; }
  };
  more.addEventListener("click", () => { void load(true); });
  return () => load();
});
async function reload() { refresh.disabled = true; await Promise.all(loaders.map(load => load())); refresh.disabled = false; }
refresh.addEventListener("click", () => { void reload(); });
void reload();

}
