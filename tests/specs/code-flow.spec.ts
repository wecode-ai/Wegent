import { test, expect } from '@playwright/test'

/**
 * Common setup function for code tests
 * - Navigates to code page
 * - Selects dev-team agent
 * - Selects wecode-ai/Wegent repository
 * - Selects main branch
 * - Waits for input to be enabled
 */
async function setupCodePage(page: any) {
  // First navigate to set localStorage, then reload to skip onboarding
  await page.goto('/code')

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

  // Wait for page to stabilize
  await page.waitForTimeout(1000)

  // Step 1: Select dev-team agent
  console.log('Selecting dev-team agent...')
  const teamSelector = page.locator('[data-testid="team-selector"]').first()
  await expect(teamSelector).toBeVisible({ timeout: 10000 })

  // Click to open team selector dropdown
  await teamSelector.click()
  await page.waitForTimeout(500)

  // Search for dev-team
  const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"]').first()
  if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await searchInput.fill('dev-team')
    await page.waitForTimeout(500)
  }

  // Select dev-team from dropdown
  const devTeamOption = page.locator('[data-testid="team-option-dev-team"]').first()
  if (await devTeamOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await devTeamOption.click()
  } else {
    // Try to find by text content
    const teamOptions = page.locator('[data-testid^="team-option-"]').filter({ hasText: /dev-team/i })
    if (await teamOptions.count() > 0) {
      await teamOptions.first().click()
    }
  }
  await page.waitForTimeout(500)

  // Step 2: Select repository wecode-ai/Wegent
  console.log('Selecting repository...')
  const repoSelector = page.locator('[data-testid="repo-branch-selector"]').first()
  await expect(repoSelector).toBeVisible({ timeout: 10000 })

  // Click to open repository selector
  await repoSelector.click()
  await page.waitForTimeout(500)

  // Search for repository
  const repoSearchInput = page.locator('input[placeholder*="仓库"], input[placeholder*="repository"], input[placeholder*="搜索"]').first()
  if (await repoSearchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await repoSearchInput.fill('wecode-ai/Wegent')
    await page.waitForTimeout(500)
  }

  // Select wecode-ai/Wegent repository
  const wegentRepoOption = page.locator('[data-testid="repo-option-wecode-ai-Wegent"]').first()
  if (await wegentRepoOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await wegentRepoOption.click()
  } else {
    // Try to find by text content
    const repoOptions = page.locator('[data-testid^="repo-option-"]').filter({ hasText: /wecode-ai/i })
    if (await repoOptions.count() > 0) {
      await repoOptions.first().click()
    }
  }
  await page.waitForTimeout(500)

  // Verify repository is selected by checking the selector text
  const repoSelectorText = await repoSelector.textContent()
  console.log('Repository selected:', repoSelectorText)

  // Step 3: Select main branch
  console.log('Selecting branch...')
  // Click to open repo selector again to access branch selection
  await repoSelector.click()
  await page.waitForTimeout(500)

  // Search for main branch
  const branchSearchInput = page.locator('input[placeholder*="分支"], input[placeholder*="branch"]').first()
  if (await branchSearchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await branchSearchInput.fill('main')
    await page.waitForTimeout(500)
  }

  // Select main branch
  const mainBranchOption = page.locator('[data-testid="branch-option-main"]').first()
  if (await mainBranchOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await mainBranchOption.click()
  } else {
    // Try to find by text content
    const branchOptions = page.locator('[data-testid^="branch-option-"]').filter({ hasText: /^main$/ })
    if (await branchOptions.count() > 0) {
      await branchOptions.first().click()
    }
  }
  await page.waitForTimeout(500)

  // Verify repository and branch are selected
  const repoBranchText = await repoSelector.textContent()
  console.log('Repository/Branch selected:', repoBranchText)

  // Step 4: Select model 公网:GLM-5
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

  // Select 公网:GLM-5 model (data-testid replaces special chars with -)
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

  // Step 5: Wait for input to be enabled
  const chatInput = page.locator('[data-testid="message-input"]').first()
  await expect(chatInput).toHaveAttribute('contenteditable', 'true', { timeout: 10000 })

  console.log('Code page setup completed')
  return chatInput
}

test.describe('Code Flow', () => {
  test('should analyze repository and provide code suggestions', async ({ page }) => {
    test.setTimeout(300000) // 5 minutes timeout for AI response

    const chatInput = await setupCodePage(page)

    // Type a code-related message
    const testMessage = '请分析一下这个代码仓库的结构，并告诉我主要的功能模块。'
    await chatInput.click()
    await chatInput.fill(testMessage)

    // Debug: check input content
    const inputContent = await chatInput.textContent()
    console.log('Input content:', inputContent)

    // Find and click send button
    const sendButton = page.locator('[data-testid="send-button"]').first()
    await expect(sendButton).toBeEnabled({ timeout: 5000 })
    await sendButton.click()

    // Wait for AI response
    const messagesContainer = page.locator('.messages-container').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    // Wait for AI message to appear
    const aiMessage = messagesContainer.locator('> div').filter({
      has: page.locator('svg.lucide-bot'),
    }).last()
    await expect(aiMessage).toBeVisible({ timeout: 120000 })

    // Wait for streaming to complete
    await page.waitForTimeout(5000)

    // Verify the response
    const allMessages = await messagesContainer.locator('> div').all()
    expect(allMessages.length).toBeGreaterThanOrEqual(2)

    // Verify user message
    const userMessage = allMessages[allMessages.length - 2]
    const userMessageText = await userMessage.textContent()
    expect(userMessageText).toContain(testMessage)

    // Verify AI message has content
    const aiMessageText = await aiMessage.textContent()
    expect(aiMessageText).toBeTruthy()
    expect(aiMessageText!.length).toBeGreaterThan(20)

    console.log('AI Response received:', aiMessageText?.substring(0, 200) + '...')
    console.log(`Total messages: ${allMessages.length}, Test passed ✓`)
  })

  test('should create a new file in the repository', async ({ page }) => {
    test.setTimeout(300000) // 5 minutes timeout

    const chatInput = await setupCodePage(page)

    // Request to create a new file
    const testMessage = '请在根目录下创建一个 README_TEST.md 文件，内容写"这是一个测试文件"。'
    await chatInput.fill(testMessage)

    // Send message
    const sendButton = page.locator('[data-testid="send-button"]').first()
    await expect(sendButton).toBeEnabled({ timeout: 5000 })
    await sendButton.click()
    console.log('Message sent, waiting for response...')

    // Wait for page to transition to chat view
    await page.waitForTimeout(2000)

    // Wait for AI response
    const messagesContainer = page.locator('.messages-container').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    // Wait for AI message
    const aiMessage = messagesContainer.locator('> div').filter({
      has: page.locator('svg.lucide-bot'),
    }).last()
    await expect(aiMessage).toBeVisible({ timeout: 120000 })

    // Wait for streaming to complete
    await page.waitForTimeout(5000)

    // Check if AI response has meaningful content
    const aiMessageText = await aiMessage.textContent()
    console.log('AI Response:', aiMessageText?.substring(0, 300) + '...')

    // Verify AI responded with some content (at least 10 characters)
    expect(aiMessageText).toBeTruthy()
    expect(aiMessageText!.length).toBeGreaterThan(10)

    console.log('Code creation test passed ✓')
  })
})
