/// <reference types="node" />

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { createSandboxedHtml } from "./GadgetUI.tsx";
import { compileAuthoredWidget } from "@gadgets/bundled-blueprints/authoring-compiler";

const chrome = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const browserTestsRequired = process.env.GADGET_BROWSER_TESTS_REQUIRED === "1";
const servers: ReturnType<typeof createServer>[] = [];

if (browserTestsRequired && !existsSync(chrome)) {
  throw new Error(`Gadget browser tests are required but Chrome was not found at ${chrome}. Set CHROME_BIN to its executable path.`);
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** What one probe case did: it ran in the frame, and whether its request reached the listener. */
type ProbeResult = { id: string; ran: boolean; requestReachedListener: boolean };

/** The outbound request APIs the Gadget CSP blocks (ADR 0013 outward paths 1 and 2). */
const REQUEST_CASES = [
  "worker-data",
  "worker-blob",
  "fetch",
  "xhr",
  "beacon",
  "image",
  "stylesheet",
  "css-import",
  "cssom-import",
  "websocket",
  "eventsource",
] as const;

/**
 * Runs each probe case in a real headless Chrome, inside the production sandboxed Gadget frame
 * (`createSandboxedHtml`, the same iframe sandbox as GadgetUI.tsx), after an outer-page positive
 * control proves the listener is reachable at all. With `click`, a real mouse click (CDP input, a user
 * gesture) lands inside the frame once each case has run. Returns what each case did.
 */
async function runRequestProbes(cases: readonly string[], options: { click?: boolean } = {}): Promise<ProbeResult[]> {
  const requests: string[] = [];
  const listener = createServer((request, response) => {
    if (request.url?.startsWith("/probe/")) requests.push(request.url);
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "content-type": "text/html; charset=utf-8",
    });
    response.end("<!doctype html><title>listener</title>");
  });
  const app = createServer((_request, response) => {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    response.end(currentPage);
  });
  servers.push(listener, app);
  await Promise.all([listen(listener), listen(app)]);
  const listenerPort = portOf(listener);
  const appPort = portOf(app);
  const target = `http://127.0.0.1:${listenerPort}`;

  const compiled = await compileAuthoredWidget({
    "client.tsx": `const endpoint = ${JSON.stringify(`${target}/probe/static`)};
      export default function Widget() {
        return <><img src={endpoint} /><link rel="stylesheet" href={endpoint} />
          <div style={{ backgroundImage: 'url(' + endpoint + ')' }} /></>;
      }`,
  });

  let currentPage = "";
  const outerPage = (frame: string, includePositiveControl: boolean) => `<!doctype html><html><body style="margin:0">
    <iframe id="gadget" style="width:320px;height:120px;border:0" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe>
    <script>
      const frame = document.querySelector('#gadget');
      window.__ran = [];
      window.addEventListener('message', event => {
        if (event.data?.type === 'probe-ran') window.__ran.push(event.data.id);
      });
      frame.addEventListener('load', () => { document.body.dataset.frameReady = 'yes'; });
      frame.srcdoc = ${JSON.stringify(frame).replaceAll("<", "\\u003c")};
      ${includePositiveControl ? `fetch(${JSON.stringify(`${target}/probe/positive-control`)}).then(() => {
        document.body.dataset.positiveControl = 'hit';
      }).catch(() => { document.body.dataset.positiveControl = 'failed'; });` : ""}
    </script></body></html>`;

  const profile = await mkdtemp(join(tmpdir(), "gadget-request-probes-"));
  const debugPort = await unusedPort();
  const browser = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "--remote-allow-origins=*", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let browserError = "";
  browser.stderr.on("data", chunk => { browserError += chunk.toString(); });
  let cdp: Cdp | undefined;
  let stage = "starting Chrome";
  try {
    await waitFor(async () => fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(500),
    }).then(response => response.ok), 30_000);
    stage = "opening CDP target";
    const page = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then(response => response.json()) as { webSocketDebuggerUrl: string };
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 500, deviceScaleFactor: 1, mobile: false });

    const positiveBaseline = requests.length;
    stage = "positive control";
    currentPage = outerPage(createSandboxedHtml(compiled.clientJs), true);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/test?positive-control` });
    await waitFor(async () => (await evaluate(cdp!, "document.body.dataset.positiveControl === 'hit'")) === true);
    await waitFor(async () => requests.includes("/probe/positive-control"));
    expect(requests.slice(positiveBaseline)).toContain("/probe/positive-control");

    const results: ProbeResult[] = [];
    for (const id of cases) {
      stage = `frame load for ${id}`;
      const probe = probeCode(id, target);
      currentPage = outerPage(createSandboxedHtml(`${compiled.clientJs}\n${probe}`), false);
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/test?${id}` });
      await waitFor(async () => (await evaluate(cdp!, "document.body.dataset.frameReady === 'yes'")) === true);
      await waitFor(async () => (await evaluate(cdp!, `window.__ran.includes(${JSON.stringify(id)})`)) === true);
      if (options.click) {
        stage = `user click for ${id}`;
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 40 });
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", { type, x: 40, y: 40, button: "left", clickCount: 1 });
        }
        // The click reached the widget's own handler, or the probe proves nothing.
        await waitFor(async () => (await evaluate(cdp!, "window.__ran.includes('clicked')")) === true);
      }
      stage = `listener settle for ${id}`;
      await settle(requests, 500);
      results.push({ id, ran: true, requestReachedListener: requests.includes(`/probe/${id}`) });
    }

    expect(results).toHaveLength(cases.length);
    expect(results.filter(result => !result.ran).map(result => result.id)).toEqual([]);
    return results;
  } catch (error) {
    const browserState = cdp ? await evaluate(cdp, "({url:location.href,html:document.documentElement.outerHTML.slice(0,500),ran:window.__ran,positive:document.body?.dataset.positiveControl})").catch(() => "unavailable") : "unavailable";
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}\nRequests: ${JSON.stringify(requests)}\nState: ${JSON.stringify(browserState)}\nChrome: ${browserError}`, { cause: error });
  } finally {
    cdp?.close();
    browser.kill("SIGTERM");
    await Promise.race([once(browser, "exit"), new Promise(resolve => setTimeout(resolve, 1_000))]);
    if (browser.exitCode === null) {
      browser.kill("SIGKILL");
      await once(browser, "exit");
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

it.skipIf(!existsSync(chrome))("Gadget CSP blocks tested outbound request APIs against an outer-page positive control", async () => {
  const results = await runRequestProbes(REQUEST_CASES);
  expect(results.filter(result => result.requestReachedListener).map(result => result.id)).toEqual([]);
}, 180_000);

// FAC-15 R-3: characterization tests of KNOWN P0 GAPS (inferops ADR 0013, "Outward paths from a
// frame", which FAC-8 must close before a widget holds business data; "any route left open" is a
// no-go). They assert what is OPEN today, in real Chrome, so they fail loudly the day a path closes;
// then invert each into a security check. They are not security checks now. Safe today only because no
// governed data reaches a code-running widget (FAC-15 gap G-1). The frame's sandbox allows popups that
// escape it (GadgetUI.tsx); the CSP covers connect-src and form-action, not navigation.
// Path 4 is NOT characterized yet. Chrome's popup blocker drops a window.open without a user gesture,
// so the probe below gives one: a full-frame button whose click handler (proven to run) calls
// window.open. In headless Chrome no request reached the listener even so. That doesn't show the path
// is closed: headless Chrome may suppress or delay popup windows, and the frame's sandbox allows
// popups that escape it (GadgetUI.tsx). Treat path 4 as open for the go/no-go until a headed-browser
// probe settles it, using runRequestProbes(["window-open-click"], { click: true }). No test asserts
// it yet, on purpose: neither "open" nor "closed" is shown.

it.skipIf(!existsSync(chrome))("known P0 gap (ADR 0013 outward path 3): a widget can navigate its own frame to an outside URL", async () => {
  const [result] = await runRequestProbes(["navigate"]);
  expect(result).toEqual({ id: "navigate", ran: true, requestReachedListener: true });
}, 180_000);

// ADR 0013 outward path 5, closed today by the frame CSP's form-action 'none': a real security check.
it.skipIf(!existsSync(chrome))("ADR 0013 outward path 5 is closed: a widget's form submission is blocked by form-action 'none'", async () => {
  const [result] = await runRequestProbes(["form-submit"]);
  expect(result).toEqual({ id: "form-submit", ran: true, requestReachedListener: false });
}, 180_000);

function probeCode(id: string, target: string): string {
  const url = `${target}/probe/${id}`;
  const code = (() => {
    switch (id) {
      case "worker-data": {
        const worker = `fetch(${JSON.stringify(url)}).catch(()=>{});`;
        return `try { new Worker('data:text/javascript,' + encodeURIComponent(${JSON.stringify(worker)})); } catch {}`;
      }
      case "worker-blob": return `try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`fetch(${JSON.stringify(url)}).catch(()=>{});`)}],{type:'text/javascript'}))); } catch {}`;
      case "fetch": return `try { fetch(${JSON.stringify(url)}).catch(()=>{}); } catch {}`;
      case "xhr": return `try { const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(url)});x.send(); } catch {}`;
      case "beacon": return `try { navigator.sendBeacon(${JSON.stringify(url)},'probe'); } catch {}`;
      case "image": return `try { const i=new Image();i.src=${JSON.stringify(url)};document.body.append(i); } catch {}`;
      case "stylesheet": return `try { const l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(url)};document.head.append(l); } catch {}`;
      case "css-import": return `try { const s=document.createElement('style');s.textContent='@import url(${url});';document.head.append(s); } catch {}`;
      case "cssom-import": return `try { const s=document.createElement('style');document.head.append(s);s.sheet?.insertRule('@import url(${url});'); } catch {}`;
      case "websocket": return `try { new WebSocket(${JSON.stringify(url.replace("http:", "ws:"))}); } catch {}`;
      case "eventsource": return `try { new EventSource(${JSON.stringify(url)}); } catch {}`;
      // FAC-15 R-3: ADR 0013 outward paths 3 (the frame's own navigation), 4 (new windows), 5 (forms).
      case "window-open-click": return `try { const b=document.createElement('button');b.textContent='Open';b.style.cssText='position:fixed;inset:0;width:100%;height:100%';b.onclick=()=>{parent.postMessage({type:'probe-ran',id:'clicked'},'*');window.open(${JSON.stringify(url)},'_blank');};document.body.append(b); } catch {}`;
      case "navigate": return `try { setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 0); } catch {}`;
      case "form-submit": return `try { const f=document.createElement('form');f.method='GET';f.action=${JSON.stringify(url)};document.body.append(f);f.submit(); } catch {}`;
      default: return "";
    }
  })();
  const marker = `parent.postMessage({type:'probe-ran',id:${JSON.stringify(id)}}, '*');`;
  return `document.body.style.margin='0'; try { ${code} } catch {} finally { ${marker} }`;
}

async function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  const pending = new Map<number, [(value: any) => void, (error: Error) => void]>();
  let sequence = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: { message: string } };
    if (!message.id) return;
    const handlers = pending.get(message.id);
    if (!handlers) return;
    pending.delete(message.id);
    if (message.error) handlers[1](new Error(message.error.message));
    else handlers[0](message.result);
  });
  await once(socket, "open");
  return {
    send(method, params = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, [resolve, reject]));
    },
    close() { socket.close(); },
  };
}

async function evaluate<T = boolean>(cdp: Cdp, expression: string): Promise<T> {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result.value as T;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // The DevTools port is polled while Chrome starts and can refuse early requests.
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(50, remainingMs)));
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for browser probe state.`);
}

async function settle(requests: string[], minimumMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(minimumMs, 350);
  let quietSince = Date.now();
  let previousCount = requests.length;
  while (Date.now() < deadline || Date.now() - quietSince < 250) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (requests.length !== previousCount) {
      previousCount = requests.length;
      quietSince = Date.now();
    }
  }
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
}

function portOf(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test server did not bind a TCP port.");
  return address.port;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = portOf(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
