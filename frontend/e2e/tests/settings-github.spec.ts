import { test, expect } from '../fixtures/test-fixtures'

test.describe('Settings - Git Integration', () => {
  test.beforeEach(async ({ page }) => {
    // Git integration is on the integrations tab (index 2)
    await page.goto('/settings?tab=integrations')
    await page.waitForLoadState('networkidle')
  })

  test('should access integrations page', async ({ page }) => {
    // Verify we're on settings page with integrations tab
    await expect(page).toHaveURL(/\/settings/)

    // Wait for integrations content to load - title "Integrations" should be visible
    await expect(
      page.locator('h2:has-text("Integrations")')
    ).toBeVisible({ timeout: 10000 })
  })

  test('should display Git integration section', async ({ page }) => {
    // Look for Git integration section title "Integrations"
    await expect(
      page.locator('h2:has-text("Integrations")')
    ).toBeVisible({ timeout: 10000 })
  })

  test('should display token list or empty state', async ({ page }) => {
    // Look for token list or empty state message "No git tokens configured"
    // One of these should be visible after loading
    const hasTokens = await page.locator('button[title*="Edit"]').isVisible({ timeout: 5000 }).catch(() => false)
    const hasEmptyState = await page.locator('text=No git tokens configured').isVisible({ timeout: 1000 }).catch(() => false)

    // Either tokens exist (edit button visible) or empty state is shown
    expect(hasTokens || hasEmptyState).toBeTruthy()
  })

  test('should open add token dialog', async ({ page }) => {
    // "New Token" button should always be visible after page loads
    const addTokenButton = page.locator(
      'button:has-text("New Token"), button:has-text("新建")'
    )

    // Button should be visible - no skip, this is a required UI element
    await expect(addTokenButton).toBeVisible({ timeout: 10000 })

    await addTokenButton.click()

    // Dialog should open
    await expect(
      page.locator('[role="dialog"], [data-state="open"]')
    ).toBeVisible({ timeout: 5000 })
  })
})
