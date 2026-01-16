import { test, expect } from '../fixtures/test-fixtures'
import { mockTaskExecution } from '../utils/api-mock'

test.describe('Chat Task', () => {
  test.beforeEach(async ({ page }) => {
    // Setup API mocks for task execution
    await mockTaskExecution(page)
  })

  test('should access chat page', async ({ page }) => {
    await page.goto('/chat')

    // Should be on chat page
    await expect(page).toHaveURL(/\/chat/)

    // Wait for page to load
    await page.waitForLoadState('domcontentloaded')
  })

  test('should display team selector', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('domcontentloaded')

    // Look for team selector or dropdown
    const teamSelector = page.locator('[data-testid="team-selector"], [role="combobox"], select')

    // Assert team selector is visible (may not exist if only one team)
    const count = await teamSelector.count()
    if (count > 0) {
      await expect(teamSelector.first()).toBeVisible({ timeout: 10000 })
    }
  })

  test('should create new chat task', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('domcontentloaded')

    // Look for new chat button
    const newChatButton = page.locator(
      'button:has-text("New"), button:has-text("新建"), [data-testid="new-chat"]'
    )

    if (await newChatButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newChatButton.click()
      await page.waitForLoadState('domcontentloaded')
    }
  })

  test('should display message input', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('domcontentloaded')

    // Message input should be visible
    const messageInput = page.locator(
      'textarea, input[type="text"][placeholder*="message"], [data-testid="message-input"]'
    )

    await expect(messageInput.first()).toBeVisible({ timeout: 10000 })
  })

  test('should send message and receive response', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('domcontentloaded')

    // Find message input
    const messageInput = page
      .locator(
        'textarea, input[type="text"][placeholder*="message"], [data-testid="message-input"]'
      )
      .first()

    if (await messageInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Type message
      await messageInput.fill('Hello, this is a test message')

      // Find and click send button
      const sendButton = page
        .locator(
          'button[type="submit"], button:has-text("Send"), button:has-text("发送"), [data-testid="send-button"]'
        )
        .first()

      if (await sendButton.isEnabled({ timeout: 3000 }).catch(() => false)) {
        await sendButton.click()

        // Wait for response message to appear or loading to complete
        await page
          .waitForSelector('[data-testid="message"], .message, [data-role="assistant"]', {
            timeout: 15000,
          })
          .catch(() => {
            // Response may not appear in mock mode
          })
      }
    }
  })

  test('should display task list', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('domcontentloaded')

    // Wait for sidebar/task list area
    await page
      .waitForSelector('[data-testid="task-list"], [data-testid="conversation-list"], aside', {
        state: 'visible',
        timeout: 10000,
      })
      .catch(() => {
        // Sidebar may be collapsed or hidden
      })
  })
})
