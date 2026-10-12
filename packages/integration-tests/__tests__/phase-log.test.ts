import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The suite's idle watchdog resets on any output, so the phase logger must write only to its file.
// Printing would change which silences the watchdog catches (src/phase-log.ts).
test("the phase logger never writes to stdout or stderr", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/phase-log.ts"), "utf8")
    .split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n");
  expect(source).not.toMatch(/console\.|process\.(stdout|stderr)|\bwrite(Sync)?\(/u);
  expect(source).toMatch(/appendFileSync\(PHASE_LOG,/u);
});
