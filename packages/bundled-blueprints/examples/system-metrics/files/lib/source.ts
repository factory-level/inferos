// The demo source: which installations exist and one installation's figures. The installation is
// chosen here, at the source -- a load returns only the requested demo installation -- and every
// answer is a copy, so no caller can change the fixture. Shared by the Durable Object and its tests.
import { DEMO_INSTALLATIONS } from "./fixture.ts";
import type { DemoInstallation, LoadMetricsResult } from "./protocol.ts";

export function listDemoInstallations(): DemoInstallation[] {
  return DEMO_INSTALLATIONS.map(({ installation }) => ({ ...installation }));
}

export function loadDemoMetrics(installationId: string): LoadMetricsResult {
  const entry = DEMO_INSTALLATIONS.find(({ installation }) => installation.installationId === installationId);
  if (!entry) return { ok: false, reason: "unknown-installation" };
  return { ok: true, installation: { ...entry.installation }, ...structuredClone(entry.metrics) };
}
