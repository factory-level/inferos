// Artillery Playwright-engine flow for load/inferos-browser.yml. Credentials are the local seed's
// development defaults (packages/workshop-backend/scripts/dev-setup.ts), never a real account.
const USER = process.env.FACTORY_LOCAL_USER ?? "dev";
const PASSWORD = process.env.FACTORY_LOCAL_PASSWORD ?? "devpassword";

export async function shellToBoardWorkspace(page, _vuContext, _events, test) {
  await test.step("shell_boot", async () => {
    await page.goto("/");
    await page.getByRole("heading", { name: "InferOS" }).waitFor();
  });
  await test.step("sign_in", async () => {
    await page.getByRole("textbox", { name: "Username" }).fill(USER);
    await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "What are we working on?" }).waitFor();
  });
  await test.step("open_board_workspace", async () => {
    await page.getByRole("link", { name: /InferOps Canvas demo/ }).first().click();
    // The mock board's pending move surfaces as the workspace's approval request.
    await page.getByRole("button", { name: /request needs review/ }).waitFor({ timeout: 30_000 });
  });
}
