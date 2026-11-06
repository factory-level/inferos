// ---------------------------------------------------------------------------
// Status Widget -- one piece of work's state, under the InferOS mark.
//
// The state is the Workshop's (the widget's declared states.json, one person's state of one
// placed widget): Operate shows it above the widget with the events it accepts, and tells the
// widget which state it is in with a `widget-state` message. The widget only draws it. The mark is
// the InferOS logo, bundled as an asset rather than fetched, recoloured per state.
// ---------------------------------------------------------------------------
/// <reference path="./lib/assets.d.ts" />

import MARK from "./lib/mark.svg";
import { lookFor, widgetStateOf } from "./lib/status.ts";

const STYLES = `
:root { color-scheme: light dark; --text: #1b1f24; --muted: #5d6673; }
@media (prefers-color-scheme: dark) { :root { --text: #e7eaee; --muted: #9aa3ae; } }
html, body { margin: 0; height: 100%; }
body { font: 14px system-ui, sans-serif; color: var(--text); }
main { box-sizing: border-box; height: 100%; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
header { display: flex; align-items: center; gap: 10px; }
header svg { width: 32px; height: 32px; flex: none; }
header svg.pulse { animation: pulse 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { header svg.pulse { animation: none; } }
@keyframes pulse { 50% { opacity: .45; } }
h1 { margin: 0; font-size: 13px; font-weight: 600; color: var(--muted); }
p { margin: 0; font-size: 18px; }
`;

const style = document.createElement("style");
style.textContent = STYLES;
document.head.appendChild(style);

const mark = document.importNode(
  new DOMParser().parseFromString(MARK, "image/svg+xml").documentElement, true) as unknown as SVGSVGElement;
mark.setAttribute("aria-hidden", "true");
mark.removeAttribute("aria-label");
mark.removeAttribute("role");
const path = mark.querySelector("path")!;

const title = document.createElement("h1");
title.textContent = "Status";
const status = document.createElement("p");
status.setAttribute("role", "status");
const header = document.createElement("header");
header.append(mark, title);
const main = document.createElement("main");
main.append(header, status);
document.body.appendChild(main);

const draw = (state: string | null) => {
  const look = lookFor(state);
  path.setAttribute("stroke", look.color);
  mark.classList.toggle("pulse", look.pulse);
  mark.dataset.state = state ?? "";
  status.textContent = look.label;
};
draw(null);

// Only the host page may say which state the widget is in.
window.addEventListener("message", event => {
  if (event.source !== window.parent) return;
  const state = widgetStateOf(event.data);
  if (state !== null) draw(state);
});
