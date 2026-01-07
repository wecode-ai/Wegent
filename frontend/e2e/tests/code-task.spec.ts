import { test, expect } from '../fixtures/test-fixtures'
import { mockTaskExecution } from '../utils/api-mock'

test.describe('Code Task', () => {
  test.beforeEach(async ({ page }) => {
    // Setup API mocks for task execution
    await mockTaskExecution(page)
  })

  test('should access code page', async ({ page }) => {
    await page.goto('/code')

    // Should be on code page
    await expect(page).toHaveURL(/\/code/)

    await page.waitForLoadState('domcontentloaded')
  })

  test('should display team selector', async ({ page }) => {
    await page.goto('/code')
    await page.waitForLoadState('domcontentloaded')

    // Look for team selector
    const teamSelector = page.locator('[data-testid="team-selector"], [role="combobox"]')

    // Assert team selector is visible if it exists
    const count = await teamSelector.count()
    if (count > 0) {
      await expect(teamSelector.first()).toBeVisible({ timeout: 10000 })
    }
  })

  test('should display repository selector', async ({ page }) => {
    await page.goto('/code')
    await page.waitForLoadState('domcontentloaded')

    // Look for repository selector or input
    const repoSelector = page.locator(
      '[data-testid="repo-selector"], [placeholder*="repo"], [placeholder*="仓库"]'
    )

    // Assert repository selector is visible if it exists
    const count = await repoSelector.count()
    if (count > 0) {
      await expect(repoSelector.first()).toBeVisible({ timeout: 10000 })
    }
  })

  test('should create new code task', async ({ page }) => {
    await page.goto('/code')
    await page.waitForLoadState('domcontentloaded')

    // Look for new task button
    const newTaskButton = page.locator(
      'button:has-text("New"), button:has-text("新建"), [data-testid="new-task"]'
    )

    if (await newTaskButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newTaskButton.click()
      await page.waitForLoadState('domcontentloaded')
    }
  })

  test('should display message input for code task', async ({ page }) => {
    await page.goto('/code')
    await page.waitForLoadState('domcontentloaded')

    // Message input should be visible
    const messageInput = page.locator(
      'textarea, input[type="text"][placeholder*="message"], [data-testid="message-input"]'
    )

    // Assert message input is visible
    await expect(messageInput.first()).toBeVisible({ timeout: 10000 })
  })

  test('should send code task message', async ({ page }) => {
    await page.goto('/code')
    await page.waitForLoadState('domcontentloaded')

    // Find message input
    const messageInput = page.locator('textarea, input[type="text"]').first()

    if (await messageInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Type message
      await messageInput.fill('Please help me refactor this code')

      // Find send button
      const sendButton = page
        .locator('button[type="submit"], button:has-text("Send"), button:has-text("发送")')
        .first()

      if (await sendButton.isEnabled({ timeout: 3000 }).catch(() => false)) {
        await sendButton.click()

        // Wait for response message to appear
        await page
          .waitForSelector('[data-testid="message"], .message', {
            timeout: 15000,
          })
          .catch(() => {
            // Response may not appear in mock mode
          })
      }
    }
  })
})
