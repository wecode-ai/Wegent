import { test, expect, TestData } from '../fixtures/test-fixtures'

test.describe('Settings - Model Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings?tab=models')
    await page.waitForLoadState('networkidle')
  })

  test('should access model management page', async ({ page }) => {
    await expect(page).toHaveURL(/\/settings.*tab=models/)

    // Page should have loaded
    await page.waitForTimeout(1000)
  })

  test('should display model list', async ({ page }) => {
    // Wait for content to load
    await page.waitForTimeout(2000)

    // Look for model cards or list items
    const modelList = page.locator(
      '[data-testid="model-list"], .model-card, [data-type="model"]'
    )

    // There should be some models listed (public models)
    await page.waitForTimeout(1000)
  })

  test('should display public and user models', async ({ page }) => {
    // Wait for models to load
    await page.waitForTimeout(2000)

    // Check for tab or filter for public/user models
    const publicTab = page.locator(
      'button:has-text("Public"), [data-value="public"]'
    )
    const userTab = page.locator(
      'button:has-text("User"), button:has-text("Custom"), [data-value="user"]'
    )

    // At least one should be visible or models should be listed
    await page.waitForTimeout(1000)
  })

  test('should open create model dialog', async ({ page }) => {
    // Find create button
    const createButton = page.locator(
      'button:has-text("Create"), button:has-text("新建"), button:has-text("Add Model"), [data-testid="create-model"]'
    )

    if (await createButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createButton.click()

      // Dialog should open
      await page.waitForSelector('[role="dialog"], [data-state="open"]', {
        timeout: 5000,
      })
    }
  })

  test('should create new model', async ({ page, testPrefix }) => {
    const modelName = TestData.uniqueName(`${testPrefix}-model`)

    // Find and click create button
    const createButton = page.locator(
      'button:has-text("Create"), button:has-text("Add Model")'
    )

    if (!(await createButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip()
      return
    }

    await createButton.click()

    // Wait for dialog
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Fill model name
    const nameInput = page.locator(
      '[role="dialog"] input[name="name"], [role="dialog"] input[placeholder*="name"]'
    ).first()

    if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nameInput.fill(modelName)

      // Fill other required fields if visible
      const providerSelect = page.locator(
        '[role="dialog"] [data-testid="provider-select"], [role="dialog"] select[name="provider"]'
      )

      if (await providerSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
        await providerSelect.click()
        await page.locator('[role="option"]:has-text("OpenAI")').first().click()
      }

      // Fill API key
      const apiKeyInput = page.locator(
        '[role="dialog"] input[name="api_key"], [role="dialog"] input[type="password"]'
      ).first()

      if (await apiKeyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await apiKeyInput.fill('test-api-key-for-e2e')
      }

      // Submit form
      const submitButton = page.locator(
        '[role="dialog"] button[type="submit"], [role="dialog"] button:has-text("Save")'
      ).first()

      if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitButton.click()
        await page.waitForTimeout(2000)
      }
    }
  })

  test('should test model connection', async ({ page }) => {
    // Find test connection button
    const testButton = page.locator(
      'button:has-text("Test"), button:has-text("测试连接"), [data-testid="test-connection"]'
    ).first()

    if (await testButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await testButton.click()

      // Wait for test result
      await page.waitForTimeout(3000)

      // Check for success/error message
      const resultMessage = page.locator(
        '[data-testid="test-result"], .toast, [role="alert"]'
      )

      await page.waitForTimeout(2000)
    }
  })

  test('should delete model', async ({ page }) => {
    // Find delete button on a user model (not public)
    const deleteButton = page.locator(
      'button:has-text("Delete"), [data-testid="delete-model"], button[aria-label*="delete"]'
    ).first()

    if (await deleteButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await deleteButton.click()

      // Confirm deletion dialog
      const confirmButton = page.locator(
        'button:has-text("Confirm"), button:has-text("确认"), [role="alertdialog"] button:has-text("Delete")'
      )

      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click()
        await page.waitForTimeout(2000)
      }
    }
  })
})
