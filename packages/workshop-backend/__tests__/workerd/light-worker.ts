// The `main` of the `workerd-light` vitest project (see vitest.config.ts): just the Durable Objects
// its files address, so a file there never evaluates the backend Worker the way `test-worker.ts`
// makes every `cloudflare:test` file do.

export { UserDirectoryDurableObject } from "../../src/user-directory.js";

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
