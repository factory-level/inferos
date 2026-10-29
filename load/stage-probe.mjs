// Artillery Playwright-engine flow for load/stage-probe.yml (release-graph node 10's light probe):
// the stage's login page, "Continue with InferOps", the operator persona on the InferOps persona
// page, back with an InferOS session. Persona and Access token come from the environment by name
// (scripts/ci/stage-smoke.ts passes them with `docker run -e NAME`); nothing is logged.
const PERSONA = process.env.GROKBOT_PERSONA_USER ?? "";
const ACCESS = process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
  ? { "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET }
  : null;
const escaped = PERSONA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function stageSignIn(page, _vuContext, _events, test) {
  if (ACCESS) await page.context().setExtraHTTPHeaders(ACCESS);
  await test.step("stage_login_page", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: /Continue with InferOps/ }).waitFor({ timeout: 30_000 });
  });
  await test.step("persona_sign_in", async () => {
    const popupPromise = page.context().waitForEvent("page", { timeout: 30_000 });
    await page.getByRole("button", { name: /Continue with InferOps/ }).click();
    const popup = await popupPromise;
    await popup.getByRole("button", { name: new RegExp(`\\b${escaped}\\b`) }).click({ timeout: 30_000 });
    await page.waitForFunction(() => Boolean(localStorage.getItem("authToken")), null, { timeout: 30_000 });
  });
}
