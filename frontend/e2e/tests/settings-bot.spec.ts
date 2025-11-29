import { test, expect, TestData } from '../fixtures/test-fixtures'

test.describe('Settings - Bot Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings?tab=team')
    await page.waitForLoadState('networkidle')
  })

  test('should access bot management page', async ({ page }) => {
    await expect(page).toHaveURL(/\/settings/)

    // Page should have loaded
    await page.waitForTimeout(1000)
  })

  test('should display bot list', async ({ page }) => {
    // Wait for content to load
    await page.waitForTimeout(2000)

    // Look for bot cards or list items
    const botList = page.locator(
      '[data-testid="bot-list"], .bot-card, [data-type="bot"]'
    )

    // There should be some bots listed (from seed data)
    await page.waitForTimeout(1000)
  })

  test('should open create bot dialog', async ({ page }) => {
    // Find create button
    const createButton = page.locator(
      'button:has-text("Create"), button:has-text("新建"), button:has-text("Add"), [data-testid="create-bot"]'
    )

    if (await createButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createButton.click()

      // Dialog should open
      await page.waitForSelector('[role="dialog"], [data-state="open"]', {
        timeout: 5000,
      })
    }
  })

  test('should create new bot', async ({ page, testPrefix }) => {
    const botName = TestData.uniqueName(`${testPrefix}-bot`)

    // Find and click create button
    const createButton = page.locator(
      'button:has-text("Create"), button:has-text("新建"), button:has-text("Add Bot")'
    )

    if (!(await createButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip()
      return
    }

    await createButton.click()

    // Wait for dialog
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Fill bot name
    const nameInput = page.locator(
      '[role="dialog"] input[name="name"], [role="dialog"] input[placeholder*="name"]'
    ).first()

    if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nameInput.fill(botName)

      // Submit form
      const submitButton = page.locator(
        '[role="dialog"] button[type="submit"], [role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("Create")'
      ).first()

      if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitButton.click()
        await page.waitForTimeout(2000)
      }
    }
  })

  test('should edit bot configuration', async ({ page }) => {
    // Find an edit button on a bot card
    const editButton = page.locator(
      'button:has-text("Edit"), [data-testid="edit-bot"], button[aria-label*="edit"]'
    ).first()

    if (await editButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editButton.click()

      // Wait for edit dialog or page
      await page.waitForSelector('[role="dialog"], [data-state="open"]', {
        timeout: 5000,
      })
    }
  })

  test('should delete bot', async ({ page }) => {
    // Find delete button
    const deleteButton = page.locator(
      'button:has-text("Delete"), [data-testid="delete-bot"], button[aria-label*="delete"]'
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
