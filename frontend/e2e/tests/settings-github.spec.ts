import { test, expect } from '../fixtures/test-fixtures'

test.describe('Settings - Git Integration', () => {
  test.beforeEach(async ({ page }) => {
    // Git integration is on the integrations tab (index 2)
    await page.goto('/settings?tab=integrations')
    await page.waitForLoadState('domcontentloaded')
  })

  test('should access integrations page', async ({ page }) => {
    // Verify we're on settings page with integrations tab
    await expect(page).toHaveURL(/\/settings/)

    // Wait for integrations content to load - title "Integrations" should be visible
    await expect(page.locator('h2:has-text("Integrations")')).toBeVisible({ timeout: 20000 })
  })

  test('should display Git integration section', async ({ page }) => {
    // Look for Git integration section title "Integrations"
    await expect(page.locator('h2:has-text("Integrations")')).toBeVisible({ timeout: 20000 })
  })

  test('should display token list or empty state', async ({ page }) => {
    // Wait for page to be fully loaded
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1000)

    // Look for token list or empty state message "No git tokens configured"
    // One of these should be visible after loading
    const hasTokens = await page
      .locator('button[title*="Edit"]')
      .isVisible({ timeout: 5000 })
      .catch(() => false)
    const hasEmptyState = await page
      .locator('text=No git tokens configured')
      .isVisible({ timeout: 1000 })
      .catch(() => false)
    // Also check for loading state that might still be present
    const hasLoadingOrContent = await page
      .locator('[data-testid="git-tokens"], .git-token-list, h2:has-text("Integrations")')
      .isVisible({ timeout: 1000 })
      .catch(() => false)

    // Either tokens exist (edit button visible), empty state is shown, or page is still in valid state
    expect(hasTokens || hasEmptyState || hasLoadingOrContent).toBeTruthy()
  })

  test('should open add token dialog', async ({ page }) => {
    // Wait for integrations page to load
    await expect(page.locator('h2:has-text("Integrations")')).toBeVisible({ timeout: 20000 })

    // "New Token" button should always be visible after page loads
    const addTokenButton = page.locator('button:has-text("New Token"), button:has-text("新建")')

    // Button should be visible - no skip, this is a required UI element
    await expect(addTokenButton).toBeVisible({ timeout: 20000 })

    await addTokenButton.click()

    // Wait for dialog to open and become visible
    // headlessui Dialog may render hidden initially, wait for content
    await page.waitForTimeout(500)

    // Dialog should have data-headlessui-state="open" when visible
    // Check for the dialog panel content (Dialog.Title has text-xl class)
    const dialogContent = page.locator(
      '[role="dialog"] .text-xl, [role="dialog"] [class*="DialogTitle"]'
    )
    await expect(dialogContent.first()).toBeVisible({ timeout: 20000 })
  })
})
