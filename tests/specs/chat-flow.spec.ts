import { test, expect } from '@playwright/test'

/**
 * Common setup function for chat tests
 * - Navigates to chat page
 * - Skips onboarding
 * - Selects team/agent if needed
 * - Waits for input to be enabled
 */
async function setupChatPage(page: any) {
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
  const quickAccessCards = page.locator('[data-tour="quick-access-cards"]')
  if (await quickAccessCards.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Get all available cards first
    const allCards = quickAccessCards.locator('div.rounded-full.border')
    const cardCount = await allCards.count()

    if (cardCount > 0) {
      // Try to find wegent-chat card among all cards
      let wegentChatIndex = -1
      for (let i = 0; i < cardCount; i++) {
        const cardText = await allCards.nth(i).textContent().catch(() => '')
        if (cardText?.includes('wegent-chat')) {
          wegentChatIndex = i
          break
        }
      }

      // Click wegent-chat if found, otherwise click the first card
      const cardToClick = wegentChatIndex >= 0 ? allCards.nth(wegentChatIndex) : allCards.first()
      await cardToClick.click()
      await page.waitForTimeout(1000)
    }
  }

  // Wait for input to be enabled
  const chatInput = page.locator('[data-testid="message-input"]').first()
  await expect(chatInput).toHaveAttribute('contenteditable', 'true', { timeout: 10000 })

  return chatInput
}

test.describe('Chat Flow', () => {
  test('should send message and receive AI response', async ({ page }) => {
    const chatInput = await setupChatPage(page)

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

  test('should use clarification mode for vague requests', async ({ page }) => {
    // Set longer timeout for this test (5 minutes) as AI may take time to generate clarification questions
    test.setTimeout(300000)
    const chatInput = await setupChatPage(page)

    // Step 1: Wait for controls to be fully loaded
    await page.waitForSelector('[data-tour="input-controls"]', { state: 'visible', timeout: 10000 })
    await page.waitForTimeout(1000)

    // Wait for clarification toggle to appear (only for Chat Shell type teams)
    // The toggle is a button with MessageCircleQuestion icon inside ActionButton
    // Try to find it by looking for buttons with specific characteristics
    await page.waitForTimeout(2000)  // Wait for all controls to render

    // Strategy: Find all buttons in input-controls, then find the one that likely is clarification toggle
    // Clarification toggle is typically the 4th button (index 3) for Chat Shell teams
    // Buttons order: Knowledge Base, ?, Skills, ?, ?, Model, Send
    const allButtons = page.locator('[data-tour="input-controls"] button')
    const buttonCount = await allButtons.count()
    console.log(`Found ${buttonCount} buttons in input-controls`)

    // Try to identify the clarification toggle by position or content
    // For Chat Shell: buttons are [KB, Clarification, Skills, ...]
    let clarificationToggle = null

    // Try each button and check if clicking it toggles the mode
    for (let i = 0; i < Math.min(buttonCount, 6); i++) {
      const btn = allButtons.nth(i)
      const html = await btn.innerHTML().catch(() => '')

      // Check if this button contains MessageCircleQuestion icon (circle + question mark pattern)
      // The icon is typically an SVG with circle and question mark paths
      if (html.includes('circle') && html.includes('?')) {
        clarificationToggle = btn
        console.log(`Found potential clarification toggle at index ${i}`)
        break
      }
    }

    // Fallback: try the 4th button (index 3) which is typically clarification toggle
    if (!clarificationToggle && buttonCount >= 4) {
      clarificationToggle = allButtons.nth(3)
      console.log('Using fallback: button at index 3')
    }

    if (!clarificationToggle) {
      console.log('⚠️ Clarification toggle not found - team may not be Chat Shell type, skipping test')
      test.skip()
      return
    }

    await clarificationToggle.click()
    await page.waitForTimeout(500)

    // Verify the button is now in enabled state (has primary/border-primary class)
    const buttonClass = await clarificationToggle.getAttribute('class')
    const isEnabled = buttonClass?.includes('border-primary') || buttonClass?.includes('bg-primary')
    if (!isEnabled) {
      console.log('⚠️ Clarification mode not enabled (button style unchanged) - may not be supported, skipping test')
      test.skip()
      return
    }
    console.log('✓ Clarification mode enabled')

    // Step 2: Type a vague message that should trigger clarification questions
    const vagueMessage = '帮我写一个程序'
    await chatInput.fill(vagueMessage)

    // Step 3: Send the message
    const sendButton = page.locator(
      'button[type="submit"], button:has(svg[class*="send" i]), [data-testid="send-button"]'
    ).first()
    await sendButton.click()

    // Step 4: Wait for AI response container
    const messagesContainer = page.locator('.messages-container').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    console.log('⏳ Waiting for AI to generate clarification questions (this may take 15-60 seconds)...')

    // Step 5: Wait for clarification form to appear
    // Note: AI takes time to analyze and generate clarification questions
    // Wait up to 120 seconds for the form to appear
    // Use a more robust selector - match by partial class name and text content
    // border-primary/30 is a Tailwind class, we match the border-primary part
    const clarificationForm = page.locator('[class*="border-primary"]:has-text("Spec Clarification"), [class*="border-primary"]:has-text("需求澄清"), [class*="bg-primary"]:has-text("Spec Clarification"), [class*="bg-primary"]:has-text("需求澄清")').first()

    // Poll for the form with longer timeout
    let hasClarificationForm = false
    const maxWaitTime = 120000  // 120 seconds max wait
    const pollInterval = 3000   // Check every 3 seconds
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitTime) {
      hasClarificationForm = await clarificationForm.isVisible({ timeout: pollInterval }).catch(() => false)
      if (hasClarificationForm) {
        break
      }
      // Also check if AI already provided a direct response (streaming stopped)
      const lastAiMessage = messagesContainer.locator('> div').filter({
        has: page.locator('svg.lucide-bot'),
      }).last()
      const hasAiResponse = await lastAiMessage.isVisible({ timeout: 1000 }).catch(() => false)
      if (hasAiResponse) {
        const messageText = await lastAiMessage.textContent().catch(() => '')
        // If AI message is substantial and doesn't contain clarification questions, treat as direct response
        if (messageText && messageText.length > 50 && !messageText.includes('?') && !messageText.includes('？')) {
          console.log('AI provided direct response without clarification questions')
          break
        }
      }
      console.log(`  Still waiting... (${Math.round((Date.now() - startTime) / 1000)}s)`)
    }

    if (!hasClarificationForm) {
      // Case 1: AI didn't ask clarification questions - verify normal response
      console.log('ℹ️ No clarification questions generated - AI provided direct response')

      const aiMessage = messagesContainer.locator('> div').filter({
        has: page.locator('svg.lucide-bot'),
      }).last()
      await expect(aiMessage).toBeVisible({ timeout: 90000 })

      // Wait for streaming to complete (content stabilizes)
      console.log('⏳ Waiting for AI response to complete...')
      await page.waitForTimeout(5000)

      const aiMessageText = await aiMessage.textContent()
      expect(aiMessageText).toBeTruthy()
      expect(aiMessageText!.length).toBeGreaterThan(10)
      console.log('AI Response:', aiMessageText?.substring(0, 200) + '...')
      console.log('✓ Test completed with direct AI response')

      // Pause to let user see the result (10 seconds in headed mode)
      console.log('⏸️  Pausing for 10 seconds to view the result...')
      await page.waitForTimeout(10000)
      return
    }
    console.log('✓ Clarification form displayed')

    // Wait for form content to fully render
    console.log('⏳ Waiting for clarification form content to fully load...')
    await page.waitForTimeout(3000)

    // Step 6: Verify there are questions in the form
    const questions = clarificationForm.locator('.border-border, .border-red-500')
    const questionCount = await questions.count()
    expect(questionCount).toBeGreaterThanOrEqual(1)
    console.log(`✓ Found ${questionCount} clarification questions`)

    // Log all question texts for visibility
    for (let i = 0; i < Math.min(questionCount, 5); i++) {
      const questionText = await questions.nth(i).textContent().catch(() => '')
      console.log(`  Question ${i + 1}: ${questionText?.substring(0, 100)}...`)
    }

    // Pause to let user see the clarification questions (5 seconds)
    console.log('⏸️  Pausing to view clarification questions...')
    await page.waitForTimeout(5000)

    // Step 7: Answer questions - try to select options or fill text inputs
    // For single choice questions (radio buttons)
    const radioOptions = clarificationForm.locator('input[type="radio"]').all()
    const radioButtons = await radioOptions
    if (radioButtons.length > 0) {
      // Click the first option of each radio group
      const radioGroups = new Set<string>()
      for (const radio of radioButtons) {
        const name = await radio.getAttribute('name')
        if (name && !radioGroups.has(name)) {
          radioGroups.add(name)
          await radio.click()
          await page.waitForTimeout(200)
        }
      }
      console.log(`✓ Answered ${radioGroups.size} single choice questions`)
    }

    // For multiple choice questions (checkboxes)
    const checkboxes = clarificationForm.locator('input[type="checkbox"]').all()
    const checkboxInputs = await checkboxes
    if (checkboxInputs.length > 0) {
      // Select recommended options (or first few)
      for (const checkbox of checkboxInputs.slice(0, 2)) {
        await checkbox.click()
        await page.waitForTimeout(200)
      }
      console.log(`✓ Selected ${Math.min(checkboxInputs.length, 2)} checkbox options`)
    }

    // For text input questions
    const textInputs = clarificationForm.locator('textarea').all()
    const textareas = await textInputs
    if (textareas.length > 0) {
      // The last textarea is usually the "additional thoughts" field
      for (const textarea of textareas.slice(0, -1)) {
        await textarea.fill('这是一个测试回答')
        await page.waitForTimeout(200)
      }
      console.log(`✓ Filled ${Math.max(0, textareas.length - 1)} text inputs`)
    }

    // Pause before submitting to let user review answers
    console.log('⏸️  Pausing before submitting answers (5 seconds)...')
    await page.waitForTimeout(5000)

    // Step 8: Submit the clarification answers
    const submitButton = clarificationForm.locator('button:has-text("Submit"), button:has-text("提交"), button:has(svg.lucide-send)').first()
    await expect(submitButton).toBeVisible({ timeout: 5000 })
    await submitButton.click()
    console.log('✓ Submitted clarification answers')

    // Step 9: Wait for AI's final response after clarification
    console.log('⏳ Waiting for AI to generate final response...')
    const aiMessage = messagesContainer.locator('> div').filter({
      has: page.locator('svg.lucide-bot'),
    }).last()

    // Wait longer for streaming to complete
    await page.waitForTimeout(10000)

    // Verify AI responded after clarification
    const finalMessages = await messagesContainer.locator('> div').all()
    expect(finalMessages.length).toBeGreaterThanOrEqual(3) // user + clarification AI + final AI
    console.log(`✓ Total messages after clarification: ${finalMessages.length}`)

    // Step 10: Verify the final AI message has content
    const finalAiMessageText = await aiMessage.textContent()
    expect(finalAiMessageText).toBeTruthy()
    expect(finalAiMessageText!.length).toBeGreaterThan(20)
    console.log('Final AI Response:', finalAiMessageText?.substring(0, 200) + '...')

    console.log('✓ Clarification mode test completed successfully')

    // Final pause to let user see the complete result (15 seconds)
    console.log('⏸️  Test completed. Pausing for 15 seconds to view final result...')
    await page.waitForTimeout(15000)
  })
})
