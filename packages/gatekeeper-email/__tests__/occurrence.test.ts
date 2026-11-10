import { describe, expect, it } from "vitest";
import { emailOccurrenceId } from "../src/occurrence.js";

describe("verified email occurrence identity", () => {
  it("deduplicates byte-identical provider deliveries to the same envelope recipient", async () => {
    const raw = new TextEncoder().encode("Message-ID: <same@example.test>\r\n\r\nhello");
    expect(await emailOccurrenceId(raw, "inbox@example.test"))
      .toBe(await emailOccurrenceId(raw, "inbox@example.test"));
  });

  it("treats different raw bytes as distinct even when Message-ID is unchanged", async () => {
    const first = new TextEncoder().encode("Message-ID: <same@example.test>\r\n\r\nhello");
    const second = new TextEncoder().encode("Message-ID: <same@example.test>\r\n\r\nchanged");
    expect(await emailOccurrenceId(first, "inbox@example.test"))
      .not.toBe(await emailOccurrenceId(second, "inbox@example.test"));
  });

  it("scopes identical raw bytes to the SMTP envelope recipient", async () => {
    const raw = new TextEncoder().encode("Message-ID: <same@example.test>\r\n\r\nhello");
    expect(await emailOccurrenceId(raw, "first@example.test"))
      .not.toBe(await emailOccurrenceId(raw, "second@example.test"));
  });
});
