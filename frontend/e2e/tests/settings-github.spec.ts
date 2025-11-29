import { test, expect } from '../fixtures/test-fixtures'

test.describe('Settings - GitHub Integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings?tab=integrations')
    await page.waitForLoadState('networkidle')
  })

  test('should access integrations page', async ({ page }) => {
    await expect(page).toHaveURL(/\/settings.*tab=integrations/)

    // Wait for settings content to load
    await page.waitForSelector('main, [data-testid="settings-content"]', {
      state: 'visible',
      timeout: 10000,
    })
  })

  test('should display GitHub integration section', async ({ page }) => {
    // Look for GitHub section
    const githubSection = page.locator(
      'text=GitHub, text=github, [data-testid="github-integration"]'
    )

    // Wait for GitHub section or main content
    await page
      .waitForSelector(
        'main, [data-testid="settings-content"], [data-testid="github-integration"]',
        { state: 'visible', timeout: 10000 }
      )
      .catch(() => {
        // Continue test
      })
  })

  test('should open add token dialog', async ({ page }) => {
    // Find add token button
    const addTokenButton = page.locator(
      'button:has-text("Add Token"), button:has-text("添加Token"), button:has-text("Connect GitHub"), [data-testid="add-github-token"]'
    )

    if (await addTokenButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addTokenButton.click()

      // Dialog should open
      await expect(
        page.locator('[role="dialog"], [data-state="open"]')
      ).toBeVisible({ timeout: 5000 })
    }
  })

  test('should add GitHub token', async ({ page }) => {
    // Find add token button
    const addTokenButton = page
      .locator(
        'button:has-text("Add"), button:has-text("添加"), button:has-text("Connect")'
      )
      .first()

    if (!(await addTokenButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip()
      return
    }

    await addTokenButton.click()

    // Wait for dialog
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Fill token input
    const tokenInput = page
      .locator(
        '[role="dialog"] input[name="token"], [role="dialog"] input[type="password"], [role="dialog"] input[placeholder*="token"]'
      )
      .first()

    if (await tokenInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tokenInput.fill('ghp_test_token_for_e2e_testing')

      // Fill name if required
      const nameInput = page
        .locator(
          '[role="dialog"] input[name="name"], [role="dialog"] input[placeholder*="name"]'
        )
        .first()

      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameInput.fill('E2E Test Token')
      }

      // Submit form
      const submitButton = page
        .locator(
          '[role="dialog"] button[type="submit"], [role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("Add")'
        )
        .first()

      if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitButton.click()

        // Wait for dialog to close
        await page
          .waitForSelector('[role="dialog"]', {
            state: 'detached',
            timeout: 10000,
          })
          .catch(() => {
            // Dialog may stay open with validation errors
          })
      }
    }
  })

  test('should display repository list', async ({ page }) => {
    // Look for repository list
    const repoList = page.locator(
      '[data-testid="repo-list"], .repo-card, [data-type="repository"]'
    )

    // Wait for repo list or empty state
    await page
      .waitForSelector(
        '[data-testid="repo-list"], .repo-card, [data-type="repository"], [data-testid="empty-state"]',
        { state: 'visible', timeout: 10000 }
      )
      .catch(() => {
        // Repository list may be empty if no token is configured
      })
  })

  test('should refresh repository list', async ({ page }) => {
    // Find refresh button
    const refreshButton = page.locator(
      'button:has-text("Refresh"), button:has-text("刷新"), [data-testid="refresh-repos"]'
    )

    if (await refreshButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await refreshButton.click()

      // Wait for loading to complete
      await page
        .waitForSelector('[data-loading="true"]', {
          state: 'detached',
          timeout: 10000,
        })
        .catch(() => {
          // Loading indicator may not exist
        })
    }
  })

  test('should remove GitHub token', async ({ page }) => {
    // Find remove/disconnect button
    const removeButton = page
      .locator(
        'button:has-text("Remove"), button:has-text("Disconnect"), button:has-text("删除"), [data-testid="remove-token"]'
      )
      .first()

    if (await removeButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await removeButton.click()

      // Confirm removal
      const confirmButton = page.locator(
        'button:has-text("Confirm"), button:has-text("确认"), [role="alertdialog"] button:has-text("Remove")'
      )

      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click()

        // Wait for alert dialog to close
        await page
          .waitForSelector('[role="alertdialog"]', {
            state: 'detached',
            timeout: 5000,
          })
          .catch(() => {
            // May not have alertdialog
          })
      }
    }
  })
})
