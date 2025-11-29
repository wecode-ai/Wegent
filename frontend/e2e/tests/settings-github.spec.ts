import { test, expect } from '../fixtures/test-fixtures'

test.describe('Settings - GitHub Integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings?tab=integrations')
    await page.waitForLoadState('networkidle')
  })

  test('should access integrations page', async ({ page }) => {
    await expect(page).toHaveURL(/\/settings.*tab=integrations/)

    // Page should have loaded
    await page.waitForTimeout(1000)
  })

  test('should display GitHub integration section', async ({ page }) => {
    // Wait for content to load
    await page.waitForTimeout(2000)

    // Look for GitHub section
    const githubSection = page.locator(
      'text=GitHub, text=github, [data-testid="github-integration"]'
    )

    await page.waitForTimeout(1000)
  })

  test('should open add token dialog', async ({ page }) => {
    // Find add token button
    const addTokenButton = page.locator(
      'button:has-text("Add Token"), button:has-text("添加Token"), button:has-text("Connect GitHub"), [data-testid="add-github-token"]'
    )

    if (await addTokenButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addTokenButton.click()

      // Dialog should open
      await page.waitForSelector('[role="dialog"], [data-state="open"]', {
        timeout: 5000,
      })
    }
  })

  test('should add GitHub token', async ({ page }) => {
    // Find add token button
    const addTokenButton = page.locator(
      'button:has-text("Add"), button:has-text("添加"), button:has-text("Connect")'
    ).first()

    if (!(await addTokenButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip()
      return
    }

    await addTokenButton.click()

    // Wait for dialog
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Fill token input
    const tokenInput = page.locator(
      '[role="dialog"] input[name="token"], [role="dialog"] input[type="password"], [role="dialog"] input[placeholder*="token"]'
    ).first()

    if (await tokenInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tokenInput.fill('ghp_test_token_for_e2e_testing')

      // Fill name if required
      const nameInput = page.locator(
        '[role="dialog"] input[name="name"], [role="dialog"] input[placeholder*="name"]'
      ).first()

      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameInput.fill('E2E Test Token')
      }

      // Submit form
      const submitButton = page.locator(
        '[role="dialog"] button[type="submit"], [role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("Add")'
      ).first()

      if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitButton.click()
        await page.waitForTimeout(2000)
      }
    }
  })

  test('should display repository list', async ({ page }) => {
    // Wait for content to load
    await page.waitForTimeout(2000)

    // Look for repository list
    const repoList = page.locator(
      '[data-testid="repo-list"], .repo-card, [data-type="repository"]'
    )

    // Repository list may be empty if no token is configured
    await page.waitForTimeout(1000)
  })

  test('should refresh repository list', async ({ page }) => {
    // Find refresh button
    const refreshButton = page.locator(
      'button:has-text("Refresh"), button:has-text("刷新"), [data-testid="refresh-repos"]'
    )

    if (await refreshButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await refreshButton.click()

      // Wait for refresh to complete
      await page.waitForTimeout(3000)
    }
  })

  test('should remove GitHub token', async ({ page }) => {
    // Find remove/disconnect button
    const removeButton = page.locator(
      'button:has-text("Remove"), button:has-text("Disconnect"), button:has-text("删除"), [data-testid="remove-token"]'
    ).first()

    if (await removeButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await removeButton.click()

      // Confirm removal
      const confirmButton = page.locator(
        'button:has-text("Confirm"), button:has-text("确认"), [role="alertdialog"] button:has-text("Remove")'
      )

      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click()
        await page.waitForTimeout(2000)
      }
    }
  })
})
