/** Stable identity for a provider-verified email event; sender-controlled Message-ID is excluded. */
export async function emailOccurrenceId(raw: Uint8Array, envelopeRecipient: string): Promise<string> {
  const recipient = new TextEncoder().encode(envelopeRecipient);
  const identity = new Uint8Array(raw.byteLength + recipient.byteLength);
  identity.set(raw);
  identity.set(recipient, raw.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", identity));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
