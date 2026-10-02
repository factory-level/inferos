/**
 * Deployment-independent salt prefix for client-side password hashing; see `PublicApi.login()`
 * for the full derivation. Its own module, free of imports, so Node tooling that signs in to a
 * local Workshop (scripts run directly under `node`) can derive the same hash as the browser.
 */
export const SERVICE_SALT = new Uint8Array([
  0xd9, 0x4e, 0x54, 0x1d, 0x29, 0xc1, 0x03, 0x74, 0x73, 0x7e, 0xb3, 0xe3, 0x34, 0x6d, 0x8f, 0x21
]);
