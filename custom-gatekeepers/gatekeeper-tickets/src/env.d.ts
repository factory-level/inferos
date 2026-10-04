// Project-specific ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./tickets.js");
    // Durable Object classes exposed as namespaces on ctx.exports.
    durableNamespaces: "TicketsFakeProvider" | "TicketsQueueGatekeeper";
  }
}
