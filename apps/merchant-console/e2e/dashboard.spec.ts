import { expect, test } from "@playwright/test";

test("renders the merchant workspace without viewport overflow", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Merchant overview" })).toBeVisible();
  await expect(page.getByText("Fixture data")).toBeVisible();

  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);
});

test("creates a policy-bounded test invoice", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Amount (required)").fill("42.50");
  await page.getByLabel("Order reference").fill("ORDER-4001");
  await page.getByLabel("Operator", { exact: true }).selectOption("meridian");
  await expect(page.getByLabel("Trusted hold")).toBeDisabled();
  await page.getByRole("button", { name: "Create invoice" }).click();

  await expect(page.getByRole("status")).toContainText("ready for wallet presentation");
  const createdInvoice = page.locator('[data-testid="payment-INV-1043"]:visible');
  await expect(createdInvoice).toBeVisible();
  await expect(createdInvoice).toContainText("USDC 42.50");
  await expect(createdInvoice).toContainText("Immediate conversion");
});
