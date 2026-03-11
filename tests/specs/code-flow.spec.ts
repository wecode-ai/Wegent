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
  // Navigate to code page
  await page.goto('/code')

  // Wait for page to load - sidebar should be visible
  await page.waitForSelector('[data-tour="task-sidebar"]', {
    state: 'visible',
    timeout: 30000,
  })

  // Wait for page to stabilize
  await page.waitForTimeout(1000)

  // Step 1: Select dev-team agent
  console.log('Selecting dev-team agent...')
  const teamSelector = page.locator('[data-tour="team-selector"]').first()
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
  const devTeamOption = page.locator('[data-testid="team-option-dev-team"], .text-sm:has-text("dev-team")').first()
  if (await devTeamOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await devTeamOption.click()
  } else {
    // Try to find by text content
    const teamOptions = page.locator('.text-sm').filter({ hasText: /dev-team/i })
    if (await teamOptions.count() > 0) {
      await teamOptions.first().click()
    }
  }
  await page.waitForTimeout(500)

  // Step 2: Select repository wecode-ai/Wegent
  console.log('Selecting repository...')
  const repoSelector = page.locator('[data-tour="repo-selector"]').first()
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
  const wegentRepoOption = page.locator('[data-testid="repo-option-wecode-ai-Wegent"], [title="wecode-ai/Wegent"]').first()
  if (await wegentRepoOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await wegentRepoOption.click()
  } else {
    // Try to find by text content
    const repoOptions = page.locator('text=wecode-ai/Wegent')
    if (await repoOptions.count() > 0) {
      await repoOptions.first().click()
    }
  }
  await page.waitForTimeout(500)

  // Step 3: Select main branch
  console.log('Selecting branch...')
  const branchSelector = page.locator('[data-testid="branch-selector"]').first()
  await expect(branchSelector).toBeVisible({ timeout: 10000 })

  // Click to open branch selector
  await branchSelector.click()
  await page.waitForTimeout(500)

  // Search for main branch
  const branchSearchInput = page.locator('input[placeholder*="分支"], input[placeholder*="branch"], input[placeholder*="搜索"]').first()
  if (await branchSearchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await branchSearchInput.fill('main')
    await page.waitForTimeout(500)
  }

  // Select main branch
  const mainBranchOption = page.locator('[data-testid="branch-option-main"], .text-sm:has-text("main")').first()
  if (await mainBranchOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await mainBranchOption.click()
  } else {
    // Try to find by text content
    const branchOptions = page.locator('.text-sm').filter({ hasText: /^main$/ })
    if (await branchOptions.count() > 0) {
      await branchOptions.first().click()
    }
  }
  await page.waitForTimeout(500)

  // Step 4: Wait for input to be enabled
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
    await chatInput.fill(testMessage)

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

    // Check if AI response indicates file creation or asks for confirmation
    const aiMessageText = await aiMessage.textContent()
    console.log('AI Response:', aiMessageText?.substring(0, 300) + '...')

    // AI should either create the file or ask for confirmation
    const hasFileAction = aiMessageText?.toLowerCase().includes('文件') ||
                          aiMessageText?.toLowerCase().includes('创建') ||
                          aiMessageText?.toLowerCase().includes('file') ||
                          aiMessageText?.toLowerCase().includes('create')

    expect(hasFileAction).toBe(true)
    console.log('Code creation test passed ✓')
  })
})
