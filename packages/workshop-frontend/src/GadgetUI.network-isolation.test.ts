/// <reference types="node" />

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createSandboxedHtml } from "./GadgetUI.tsx";
import { compileAuthoredWidget } from "../../bundled-blueprints/src/authoring-compiler.ts";

const execFileAsync = promisify(execFile);
const chrome = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

it.skipIf(!existsSync(chrome))("Gadget CSP prevents running widgets from reaching a local listener", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/probe")) requests.push(request.url);
    response.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
    response.end(request.url === "/test" ? outer : "unexpected request");
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test listener did not bind a TCP port.");
  const target = `http://127.0.0.1:${address.port}/probe`;
  const compiled = await compileAuthoredWidget({
    "client.tsx": `const endpoint = ${JSON.stringify(target)};
      export default function Widget() {
        return <><img src={endpoint} /><link rel="stylesheet" href={endpoint} />
          <div style={{ backgroundImage: \`url(\${endpoint})\` }} /></>;
      }`,
  });
  const attackedCompiledWidget = compiled.clientJs + `
    window.parent.postMessage('frame-script-ran', '*');
    fetch(${JSON.stringify(target)}).catch(() => {});
    const xhr = new XMLHttpRequest(); xhr.open('GET', ${JSON.stringify(target)}); xhr.send();
    navigator.sendBeacon?.(${JSON.stringify(target)}, 'probe');
    const image = new Image(); image.src = ${JSON.stringify(target)};
    const img = document.createElement('img'); img.src = ${JSON.stringify(target)}; document.body.append(img);
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ${JSON.stringify(target)}; document.head.append(link);
    const style = document.createElement('style'); style.textContent = '@import url(${target}/imported.css);'; document.head.append(style);
    try { new WebSocket(${JSON.stringify(target.replace("http:", "ws:"))}); } catch {}
    try { new EventSource(${JSON.stringify(target)}); } catch {}
    window.open(${JSON.stringify(target)});
    try { top.location = ${JSON.stringify(target)}; } catch {}
  `;
  const frame = createSandboxedHtml(attackedCompiledWidget);
  const encodedFrame = JSON.stringify(frame).replaceAll("</script>", "<\\/script>");
  const outer = `<!doctype html><body><iframe id="gadget" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe><script>
    window.addEventListener('message', event => { if (event.data === 'frame-script-ran') document.body.dataset.frameScript = 'ran'; });
    document.body.dataset.ready = 'yes';
    document.querySelector('#gadget').srcdoc = ${encodedFrame};
  </script></body>`;
  const profile = await mkdtemp(join(tmpdir(), "gadget-network-isolation-"));
  try {
    const result = await execFileAsync(chrome, [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--user-data-dir=${profile}`, "--dump-dom", `http://127.0.0.1:${address.port}/test`,
    ], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    expect(result.stdout).toContain('data-ready="yes"');
    expect(result.stdout).toContain('data-frame-script="ran"');
    expect(requests).toEqual([]);
  } finally {
    server.closeAllConnections();
    await rm(profile, { recursive: true, force: true });
  }
});
