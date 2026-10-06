// The UI bundle of the demo's fixture gadgets: plain JS that GadgetUI runs inside its sandboxed
// iframe (after its Cap'n Web prelude, which defines `gadget`). It renders static, self-contained
// markup chosen by the gadget's title, honouring the parent's light/dark preference.

const STYLE = `
:root { color-scheme: light dark; --bg:#f7f7f8; --card:#fff; --line:#e4e4e7; --text:#18181b; --muted:#71717a;
  --accent:#f6821f; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg:#111113; --card:#1c1c1f; --line:#2e2e33; --text:#f4f4f5; --muted:#a1a1aa; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
main { max-width: 1080px; margin: 0 auto; padding: 24px; }
header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
h1 { font-size:22px; margin:0; letter-spacing:-0.4px; } h2 { font-size:15px; margin:0 0 10px; }
.muted { color:var(--muted); font-size:12px; }
.grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom:16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
.kpi { font-size:28px; font-weight:600; letter-spacing:-0.6px; } .delta { font-size:12px; }
.up { color:var(--ok); } .down { color:var(--bad); }
table { width:100%; border-collapse:collapse; } td, th { text-align:left; padding:8px 6px; border-top:1px solid var(--line); font-size:13px; }
th { color:var(--muted); font-weight:500; border-top:none; }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
.pill.ok { background:color-mix(in srgb, var(--ok) 15%, transparent); color:var(--ok); }
.pill.warn { background:color-mix(in srgb, var(--warn) 18%, transparent); color:var(--warn); }
.pill.bad { background:color-mix(in srgb, var(--bad) 15%, transparent); color:var(--bad); }
.bars { display:flex; align-items:flex-end; gap:6px; height:120px; }
.bars div { flex:1; background:linear-gradient(var(--accent), color-mix(in srgb, var(--accent) 40%, transparent)); border-radius:4px 4px 0 0; }
.cols { display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.col h2 { display:flex; justify-content:space-between; } .ticket { margin-top:8px; }
.ticket b { display:block; font-weight:500; margin-bottom:4px; }
label.item { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-top:1px solid var(--line); cursor:pointer; }
label.item:first-of-type { border-top:none; } input { accent-color: var(--accent); margin-top:3px; }
label.item.done span { text-decoration: line-through; color: var(--muted); }
article p { margin: 0 0 12px; } article h2 { margin-top: 20px; } li { margin: 4px 0; }
`

const dashboard = `
<header><h1>Ops dashboard</h1><span class="muted">Updated 2 min ago · production · us-east &amp; eu-west</span></header>
<div class="grid">
  <div class="card"><div class="muted">Requests / min</div><div class="kpi">48.2k</div><div class="delta up">▲ 6.1% vs last hour</div></div>
  <div class="card"><div class="muted">Error rate</div><div class="kpi">0.42%</div><div class="delta down">▲ 0.18 pts</div></div>
  <div class="card"><div class="muted">p95 latency</div><div class="kpi">312 ms</div><div class="delta up">▼ 24 ms</div></div>
  <div class="card"><div class="muted">Open incidents</div><div class="kpi">2</div><div class="delta muted">1 SEV-2 · 1 SEV-3</div></div>
</div>
<div class="cols">
  <div class="card"><h2>Traffic, last 12 hours</h2><div class="bars">${[38, 44, 41, 52, 61, 58, 66, 72, 69, 80, 76, 88].map(h => `<div style="height:${h}%"></div>`).join('')}</div></div>
  <div class="card"><h2>Services</h2><table>
    <tr><th>Service</th><th>Status</th><th>p95</th></tr>
    <tr><td>checkout-api</td><td><span class="pill warn">Degraded</span></td><td>812 ms</td></tr>
    <tr><td>payments-gateway</td><td><span class="pill ok">Healthy</span></td><td>143 ms</td></tr>
    <tr><td>search-indexer</td><td><span class="pill bad">Down</span></td><td>—</td></tr>
    <tr><td>notifications</td><td><span class="pill ok">Healthy</span></td><td>98 ms</td></tr>
  </table></div>
</div>`

const board = (title: string) => `
<header><h1>${title}</h1><span class="muted">14 open · 3 need an owner</span></header>
<div class="cols">${[
  ['New', [['Checkout button unresponsive on Safari 17', 'bad', 'P1'], ['CSV export drops unicode names', 'warn', 'P2'], ['Docs: rate limit headers', 'ok', 'P3']]],
  ['Investigating', [['Intermittent 502s from eu-west edge', 'bad', 'P1'], ['Search results stale after reindex', 'warn', 'P2']]],
  ['Fix in review', [['Retry storm on webhook delivery', 'warn', 'P2'], ['Timezone off-by-one in digest email', 'ok', 'P3']]],
].map(([name, tickets]) => `<div class="col"><h2>${name}<span class="muted">${(tickets as unknown[]).length}</span></h2>${(tickets as string[][])
  .map(([t, tone, p]) => `<div class="card ticket"><b>${t}</b><span class="pill ${tone}">${p}</span> <span class="muted">· updated 3h ago</span></div>`).join('')}</div>`).join('')}
</div>`

const checklist = (title: string) => `
<header><h1>${title}</h1><span class="muted" id="progress"></span></header>
<div class="card">${[
  ['Final copy review for the landing page', true], ['Pricing page legal sign-off', true], ['Load test checkout at 3× peak', false],
  ['Status page and incident comms drafted', false], ['Press embargo lifts — Tuesday 09:00 PT', false], ['Support macros updated for new plans', false],
].map(([text, done]) => `<label class="item${done ? ' done' : ''}"><input type="checkbox"${done ? ' checked' : ''}><span>${text}</span></label>`).join('')}
</div>`

const doc = (title: string) => `
<article class="card" style="padding:28px 32px">
  <header><h1>${title}</h1><span class="muted">Last edited by Priya Natarajan · 3 days ago</span></header>
  <p>This runbook covers detection, triage and recovery when checkout or payment authorization degrades. Follow the steps in order and post updates in <b>#inc-payments</b> every 15 minutes.</p>
  <h2>1. Confirm the impact</h2>
  <ul><li>Check the Ops dashboard error rate for <code>checkout-api</code> and <code>payments-gateway</code>.</li><li>Compare against the provider status page before paging the vendor.</li></ul>
  <h2>2. Mitigate</h2>
  <ol><li>Fail over card authorization to the secondary acquirer.</li><li>Enable the queued-order banner so customers aren't double-charged.</li><li>Scale <code>checkout-api</code> to 2× replicas if p95 exceeds 800 ms.</li></ol>
  <h2>3. Recover and follow up</h2>
  <p>Once error rates return under 0.5% for 30 minutes, disable the banner, reconcile queued orders, and open a post-incident review.</p>
</article>`

/** The JS a fixture gadget's UI bundle runs, picked by its title. */
export function gadgetBundle(title: string, workspaceTitle: string): string {
  const escaped = title.replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'))
  const lower = `${title} ${workspaceTitle}`.toLowerCase()
  const body = lower.includes('dashboard') ? dashboard
    : /board|triage/.test(lower) ? board(escaped)
    : /checklist|launch|on-call/.test(lower) ? checklist(escaped)
    : doc(escaped)
  return `
const style = document.createElement('style');
style.textContent = ${JSON.stringify(STYLE)};
document.head.appendChild(style);
document.body.innerHTML = ${JSON.stringify(`<main>${body}</main>`)};
const update = () => {
  const boxes = [...document.querySelectorAll('label.item input')];
  boxes.forEach(b => b.closest('label').classList.toggle('done', b.checked));
  const progress = document.getElementById('progress');
  if (progress) progress.textContent = boxes.filter(b => b.checked).length + ' of ' + boxes.length + ' done';
};
document.addEventListener('change', update);
update();
`
}
