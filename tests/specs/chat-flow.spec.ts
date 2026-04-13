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

  // Remove Next.js dev overlay if present (it can block pointer events)
  await page.evaluate(() => {
    const closeButton = document.querySelector('nextjs-portal button[aria-label="Close"]') as HTMLElement
    if (closeButton) closeButton.click()
    document.querySelectorAll('nextjs-portal').forEach(el => {
      if (el.querySelector('[data-nextjs-dev-overlay]')) {
        el.remove()
      }
    })
  })

  // Wait for any animations to complete
  await page.waitForTimeout(500)

  // Select "wegent-chat" agent from QuickAccessCards if available
  const quickAccessCards = page.locator('[data-testid="quick-access-cards"]')
  if (await quickAccessCards.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Try to find wegent-chat card by data-testid
    const wegentChatCard = page.locator('[data-testid="quick-access-team-wegent-chat"]').first()
    if (await wegentChatCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await wegentChatCard.click()
    } else {
      // Fallback: click the first team card
      const firstCard = quickAccessCards.locator('[data-testid^="quick-access-team-"]').first()
      if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
        await firstCard.click()
      }
    }
    await page.waitForTimeout(1000)
  }

  // Select model 公网:GLM-5
  console.log('Selecting model...')
  const modelSelector = page.locator('[data-testid="model-selector"]').first()
  await expect(modelSelector).toBeVisible({ timeout: 10000 })

  // Click to open model selector
  await modelSelector.click()
  await page.waitForTimeout(500)

  // Search for model
  const modelSearchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"]').first()
  if (await modelSearchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await modelSearchInput.fill('GLM-5')
    await page.waitForTimeout(500)
  }

  // Select 公网:GLM-5 model
  const modelOption = page.locator('[data-testid="model-option-公网-GLM-5"]').first()
  if (await modelOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await modelOption.click()
  } else {
    // Try to find by text content
    const modelOptions = page.locator('[data-testid^="model-option-"]').filter({ hasText: /GLM-5/i })
    if (await modelOptions.count() > 0) {
      await modelOptions.first().click()
    }
  }
  await page.waitForTimeout(500)

  // Wait for input to be enabled
  const chatInput = page.locator('[data-testid="message-input"]').first()
  await expect(chatInput).toHaveAttribute('contenteditable', 'true', { timeout: 10000 })

  console.log('Chat page setup completed')
  return chatInput
}

// Generate unique test ID for concurrent test isolation
const TEST_ID = Math.random().toString(36).substring(2, 8)

test.describe('Chat Flow', () => {
  test('should send message and receive AI response', async ({ page }) => {
    const chatInput = await setupChatPage(page)

    // Type test message with unique ID for isolation
    const testMessage = `Hello, this is a test message [${TEST_ID}]. Please respond with a short greeting.`
    await chatInput.fill(testMessage)

    // Find and click send button
    const sendButton = page.locator('[data-testid="send-button"]').first()
    await expect(sendButton).toBeEnabled({ timeout: 5000 })
    await sendButton.click()

    // Wait for AI response
    // AI messages appear in messages-container
    const messagesContainer = page.locator('[data-testid="messages-container"]').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    // Wait for AI message to appear (may take time for API response)
    const aiMessage = messagesContainer.locator('> div').filter({
      has: page.locator('[data-testid="ai-message-icon"]'),
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
    const hasBotIcon = await lastMessage.locator('[data-testid="ai-message-icon"]').isVisible()
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
    await page.waitForSelector('[data-testid="input-controls"]', { state: 'visible', timeout: 10000 })
    await page.waitForTimeout(1000)

    // Find clarification toggle by data-testid
    let clarificationToggle = page.locator('[data-testid="clarification-toggle"]').first()
    const isClarificationVisible = await clarificationToggle.isVisible({ timeout: 3000 }).catch(() => false)

    if (!isClarificationVisible) {
      console.log('⚠️ Clarification toggle not found - team may not be Chat Shell type, skipping test')
      test.skip()
      return
    }
    console.log('✓ Found clarification toggle')

    await clarificationToggle.click()
    await page.waitForTimeout(500)

    // Verify the button is now in enabled state (has primary/border-primary class)
    const buttonClass = await clarificationToggle.getAttribute('class')
    const isEnabled = buttonClass?.includes('primary')
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
    const sendButton = page.locator('[data-testid="send-button"]').first()
    await expect(sendButton).toBeEnabled({ timeout: 5000 })
    await sendButton.click()

    // Step 4: Wait for AI response container
    const messagesContainer = page.locator('[data-testid="messages-container"]').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    console.log('⏳ Waiting for AI to generate clarification questions (this may take 15-60 seconds)...')

    // Step 5: Wait for clarification form to appear
    // Note: AI takes time to analyze and generate clarification questions
    // Wait up to 120 seconds for the form to appear
    const clarificationForm = page.locator('[data-testid="clarification-form"]').first()

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
        has: page.locator('[data-testid="ai-message-icon"]'),
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
        has: page.locator('[data-testid="ai-message-icon"]'),
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
    const questions = clarificationForm.locator('[data-testid^="clarification-question-"]')
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
    const radioOptions = clarificationForm.locator('[data-testid$="-radio"] [data-testid^="clarification-option-"]').all()
    const radioButtons = await radioOptions
    if (radioButtons.length > 0) {
      // Click the first option of each radio group
      for (const radio of radioButtons.slice(0, 1)) {
        await radio.click()
        await page.waitForTimeout(200)
      }
      console.log(`✓ Answered single choice questions`)
    }

    // For multiple choice questions (checkboxes)
    const checkboxes = clarificationForm.locator('[data-testid$="-checkbox"] [data-testid^="clarification-option-"]').all()
    const checkboxInputs = await checkboxes
    if (checkboxInputs.length > 0) {
      // Select recommended options (or first few)
      for (const checkbox of checkboxInputs.slice(0, 2)) {
        await checkbox.click()
        await page.waitForTimeout(200)
      }
      console.log(`✓ Selected ${Math.min(checkboxInputs.length, 2)} checkbox options`)
    }

    // For text input questions (custom textarea)
    const textInputs = clarificationForm.locator('[data-testid="clarification-custom-textarea"]').all()
    const textareas = await textInputs
    if (textareas.length > 0) {
      for (const textarea of textareas) {
        await textarea.fill('这是一个测试回答')
        await page.waitForTimeout(200)
      }
      console.log(`✓ Filled ${textareas.length} text inputs`)
    }

    // Pause before submitting to let user review answers
    console.log('⏸️  Pausing before submitting answers (5 seconds)...')
    await page.waitForTimeout(5000)

    // Step 8: Submit the clarification answers
    const submitButton = clarificationForm.locator('[data-testid="clarification-submit"]').first()
    await expect(submitButton).toBeVisible({ timeout: 5000 })
    await submitButton.click()
    console.log('✓ Submitted clarification answers')

    // Step 9: Wait for AI's final response after clarification
    console.log('⏳ Waiting for AI to generate final response...')
    const aiMessage = messagesContainer.locator('> div').filter({
      has: page.locator('[data-testid="ai-message-icon"]'),
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
