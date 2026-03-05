import { test, expect } from '@playwright/test'

test.describe('Chat Flow', () => {
  test('should send message and receive AI response', async ({ page }) => {
    // First navigate to set localStorage, then reload to skip onboarding
    await page.goto('/chat')

    // Set localStorage to mark onboarding as completed
    await page.evaluate(() => {
      localStorage.setItem('user_onboarding_completed', 'true')
      localStorage.setItem('onboarding_in_progress', '')
      localStorage.removeItem('onboarding_in_progress')
    })

    // Reload page - now onboarding should be skipped
    await page.reload()

    // Wait for page to load - sidebar should be visible
    await page.waitForSelector('[data-tour="task-sidebar"]', {
      state: 'visible',
      timeout: 30000,
    })

    // Double check and force remove any driver.js overlay
    await page.evaluate(() => {
      document.querySelectorAll('.driver-overlay, .driver-popover, .driver-popover-tip').forEach(el => el.remove())
    })

    // Wait for any animations to complete
    await page.waitForTimeout(500)

    // Select "wegent-chat" agent from QuickAccessCards if available
    // The input will be disabled until a team is selected
    const quickAccessCards = page.locator('[data-tour="quick-access-cards"]')
    if (await quickAccessCards.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Look for wegent-chat card specifically
      const wegentChatCard = quickAccessCards.locator('div.rounded-full.border:has-text("wegent-chat")').first()
      if (await wegentChatCard.isVisible({ timeout: 2000 }).catch(() => false)) {
        await wegentChatCard.click()
        // Wait for team selection to complete
        await page.waitForTimeout(1000)
      } else {
        // Fallback: click the first available team card
        const firstCard = quickAccessCards.locator('div.rounded-full.border').first()
        if (await firstCard.isVisible({ timeout: 2000 }).catch(() => false)) {
          await firstCard.click()
          await page.waitForTimeout(1000)
        }
      }
    }

    // Find chat input area - it's a contentEditable div with data-testid="message-input"
    const chatInput = page.locator('[data-testid="message-input"]').first()

    // Wait for input to be enabled (contenteditable="true")
    await expect(chatInput).toHaveAttribute('contenteditable', 'true', { timeout: 10000 })

    // Type test message
    const testMessage = 'Hello, this is a test message. Please respond with a short greeting.'
    await chatInput.fill(testMessage)

    // Find and click send button
    // Send button typically has an icon or text, look for common patterns
    const sendButton = page.locator(
      'button[type="submit"], button:has(svg[class*="send" i]), [data-testid="send-button"]'
    ).first()

    await sendButton.click()

    // Wait for AI response
    // AI messages appear in .messages-container
    const messagesContainer = page.locator('.messages-container').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    // Wait for AI message to appear (may take time for API response)
    const aiMessage = messagesContainer.locator('> div').filter({
      has: page.locator('svg.lucide-bot'),
    }).last()
    await expect(aiMessage).toBeVisible({ timeout: 90000 })

    // Wait for streaming to complete
    await page.waitForTimeout(5000)

    // Structured validation: Verify message format and order
    const allMessages = await messagesContainer.locator('> div').all()

    // 1. Verify at least 2 messages (user + AI)
    expect(allMessages.length).toBeGreaterThanOrEqual(2)

    // 2. Verify user message exists and contains our test message
    const userMessage = allMessages[allMessages.length - 2]
    const userMessageText = await userMessage.textContent()
    expect(userMessageText).toContain(testMessage)

    // 3. Verify last message is AI message (has Bot icon)
    const lastMessage = allMessages[allMessages.length - 1]
    const hasBotIcon = await lastMessage.locator('svg.lucide-bot').isVisible()
    expect(hasBotIcon).toBe(true)

    // 4. Verify AI message has meaningful content
    const aiMessageText = await aiMessage.textContent()
    expect(aiMessageText).toBeTruthy()
    expect(aiMessageText!.length).toBeGreaterThan(10)

    // 5. Verify AI response is not just repeating the question
    expect(aiMessageText).not.toBe(testMessage)

    console.log('AI Response received:', aiMessageText?.substring(0, 200) + '...')
    console.log(`Total messages: ${allMessages.length}, Validation passed ✓`)
  })
})
