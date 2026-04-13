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
  // Also mark code feature onboarding as completed to skip the "Bug or feature?" page
  await page.evaluate(() => {
    localStorage.setItem('user_onboarding_completed', 'true')
    localStorage.setItem('onboarding_in_progress', '')
    localStorage.removeItem('onboarding_in_progress')
    localStorage.setItem('code_onboarding_completed', 'true')
    localStorage.setItem('code_feature_selected', 'cloud')
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

  // Wait for page to stabilize
  await page.waitForTimeout(1000)

  // Handle "Bug or feature?" onboarding page if present
  // This page appears for first-time code feature users
  // Wait a bit longer for the page to fully render
  await page.waitForTimeout(2000)

  // Check for the onboarding page by looking for the characteristic heading
  const onboardingHeading = page.locator('h2', { hasText: '选择最适合您的方式继续编码之旅' }).first()
  const isOnboardingVisible = await onboardingHeading.isVisible({ timeout: 5000 }).catch(() => false)

  if (isOnboardingVisible) {
    console.log('✓ Code feature onboarding page detected, selecting cloud IDE option...')

    // Click the "使用WeCode云IDE" (Use WeCode Cloud IDE) option
    // Find by the h3 heading and click on its parent card
    const cloudIdeHeading = page.locator('h3', { hasText: '使用WeCode云IDE' }).first()
    const isCloudIdeVisible = await cloudIdeHeading.isVisible({ timeout: 3000 }).catch(() => false)

    if (isCloudIdeVisible) {
      // Strategy: Find the clickable parent element of the h3 heading
      // Try multiple approaches to find the actual clickable card
      let clicked = false

      // Strategy 1: Try clicking the heading itself (it might have click handler)
      try {
        await cloudIdeHeading.click({ timeout: 2000 })
        console.log('✓ Clicked: 使用WeCode云IDE (heading)')
        clicked = true
      } catch {
        // Continue to next strategy
      }

      // Strategy 2: Use XPath to find parent button
      if (!clicked) {
        try {
          const parentButton = page.locator('h3:has-text("使用WeCode云IDE") >> xpath=ancestor::button[1]')
          if (await parentButton.isVisible({ timeout: 2000 })) {
            await parentButton.click()
            console.log('✓ Clicked: 使用WeCode云IDE (parent button)')
            clicked = true
          }
        } catch {
          // Continue to next strategy
        }
      }

      // Strategy 3: Use XPath to find nearest div with border/card styling
      if (!clicked) {
        try {
          const cardDiv = page.locator('h3:has-text("使用WeCode云IDE") >> xpath=ancestor::div[contains(@class, "border") or contains(@class, "cursor-pointer")][1]')
          if (await cardDiv.isVisible({ timeout: 2000 })) {
            await cardDiv.click()
            console.log('✓ Clicked: 使用WeCode云IDE (card div)')
            clicked = true
          }
        } catch {
          // Continue to next strategy
        }
      }

      // Strategy 4: Click any element with the text
      if (!clicked) {
        try {
          await page.getByText('使用WeCode云IDE').first().click({ timeout: 2000 })
          console.log('✓ Clicked: 使用WeCode云IDE (getByText)')
          clicked = true
        } catch {
          console.log('✗ Failed to click Cloud IDE option')
        }
      }
    } else {
      // Fallback: try the first option (在IDE中使用WeCode)
      try {
        await page.getByText('在IDE中使用WeCode').first().click({ timeout: 2000 })
        console.log('✓ Clicked: 在IDE中使用WeCode')
      } catch {
        console.log('✗ Could not click any onboarding option')
      }
    }

    // Wait for the onboarding page to disappear
    await page.waitForTimeout(3000)

    console.log('✓ Onboarding completed, continuing with test...')
  } else {
    console.log('✓ No onboarding page detected, continuing...')
  }

  // Step 1: Select dev-team agent
  console.log('Selecting dev-team agent...')
  const teamSelector = page.locator('[data-testid="team-selector"]').first()
  await expect(teamSelector).toBeVisible({ timeout: 10000 })

  // Click to open team selector dropdown
  await teamSelector.click()
  await page.waitForTimeout(1000)

  // Search for dev-team
  const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"]').first()
  if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await searchInput.fill('dev-team')
    await page.waitForTimeout(1000)
    console.log('Filled team search input')
  }

  // Select dev-team from dropdown - wait for it to appear
  const devTeamOption = page.locator('[data-testid="team-option-dev-team"]').first()
  try {
    await expect(devTeamOption).toBeVisible({ timeout: 5000 })
    await devTeamOption.click()
    console.log('Selected dev-team agent')
  } catch {
    // Try to find by text content
    console.log('Could not find exact team option, trying fallback...')
    const teamOptions = page.locator('[data-testid^="team-option-"]')
    const count = await teamOptions.count()
    console.log(`Found ${count} team options`)
    if (count > 0) {
      // Find first option containing dev-team
      for (let i = 0; i < count; i++) {
        const text = await teamOptions.nth(i).textContent()
        console.log(`Team option ${i}: ${text}`)
        if (text && text.toLowerCase().includes('dev-team')) {
          await teamOptions.nth(i).click()
          console.log('Selected dev-team by text match')
          break
        }
      }
    }
  }
  await page.waitForTimeout(1000)

  // Step 2: Select repository weibo_rd/common/wecode/wegent
  console.log('Selecting repository...')
  const repoSelector = page.locator('[data-testid="repo-branch-selector"]').first()
  await expect(repoSelector).toBeVisible({ timeout: 10000 })

  // Click to open repository selector
  await repoSelector.click()
  await page.waitForTimeout(1000)

  // Wait for the repository dropdown to be visible
  const repoDropdown = page.locator('[data-testid="repo-branch-selector-dropdown"]').first()
  if (await repoDropdown.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('Repository dropdown opened')
  }

  // Search for repository
  const repoSearchInput = page.locator('input[placeholder*="仓库"], input[placeholder*="repository"], input[placeholder*="搜索"]').first()
  if (await repoSearchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await repoSearchInput.fill('wegent')
    await page.waitForTimeout(1000)
    console.log('Filled repository search input')
  }

  // Select weibo_rd/common/wecode/wegent repository - wait for it to appear after search
  // Note: data-testid replaces / with -
  const wegentRepoOption = page.locator('[data-testid="repo-option-weibo_rd-common-wecode-wegent"]').first()
  try {
    await expect(wegentRepoOption).toBeVisible({ timeout: 5000 })
    await wegentRepoOption.click()
    console.log('Selected weibo_rd/common/wecode/wegent repository')
  } catch {
    // Try to find by text content
    console.log('Could not find exact repo option, trying fallback...')
    const repoOptions = page.locator('[data-testid^="repo-option-"]')
    const count = await repoOptions.count()
    console.log(`Found ${count} repo options`)
    if (count > 0) {
      // Find first option containing wegent
      for (let i = 0; i < count; i++) {
        const text = await repoOptions.nth(i).textContent()
        console.log(`Repo option ${i}: ${text}`)
        if (text && text.includes('wegent')) {
          await repoOptions.nth(i).click()
          console.log('Selected repository by text match')
          break
        }
      }
    }
  }
  await page.waitForTimeout(1000)

  // Verify repository is selected by checking the selector text
  const repoSelectorText = await repoSelector.textContent()
  console.log('Repository selected:', repoSelectorText)

  // Step 3: Select main branch
  console.log('Selecting branch...')
  // Click to open repo selector again to access branch selection
  await repoSelector.click()
  await page.waitForTimeout(1000)

  // Search for main branch
  const branchSearchInput = page.locator('input[placeholder*="分支"], input[placeholder*="branch"]').first()
  if (await branchSearchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await branchSearchInput.fill('main')
    await page.waitForTimeout(1000)
    console.log('Filled branch search input')
  }

  // Select main branch - wait for it to appear
  const mainBranchOption = page.locator('[data-testid="branch-option-main"]').first()
  try {
    await expect(mainBranchOption).toBeVisible({ timeout: 5000 })
    await mainBranchOption.click()
    console.log('Selected main branch')
  } catch {
    // Try to find by text content
    console.log('Could not find exact branch option, trying fallback...')
    const branchOptions = page.locator('[data-testid^="branch-option-"]')
    const count = await branchOptions.count()
    console.log(`Found ${count} branch options`)
    if (count > 0) {
      // Find first option that is exactly "main"
      for (let i = 0; i < count; i++) {
        const text = await branchOptions.nth(i).textContent()
        console.log(`Branch option ${i}: ${text}`)
        if (text && text.trim() === 'main') {
          await branchOptions.nth(i).click()
          console.log('Selected main branch by text match')
          break
        }
      }
    }
  }
  await page.waitForTimeout(1000)

  // Verify repository and branch are selected
  const repoBranchText = await repoSelector.textContent()
  console.log('Repository/Branch selected:', repoBranchText)

  // Verify that a repository is actually selected (not the placeholder)
  if (!repoBranchText || repoBranchText.includes('请选择') || repoBranchText.includes('选择')) {
    throw new Error('Repository was not properly selected. Selector text: ' + repoBranchText)
  }

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
  // Code Flow tests need to run serially because they share the same page state
  // and concurrent execution causes navigation issues
test.describe.configure({ mode: 'serial' })

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

    // Dismiss any overlay before clicking
    await page.evaluate(() => {
      const closeButton = document.querySelector('nextjs-portal button[aria-label="Close"]') as HTMLElement
      if (closeButton) closeButton.click()
      document.querySelectorAll('nextjs-portal').forEach(el => {
        if (el.querySelector('[data-nextjs-dev-overlay]')) el.remove()
      })
    })

    await sendButton.click()
    console.log('Send button clicked, waiting for navigation...')

    // Wait for page navigation to task view (URL should change from /code to /code?taskId=xxx)
    try {
      await page.waitForURL(/\/code\?.*taskId=/, { timeout: 30000 })
      console.log('Navigation to task view detected')
    } catch (e) {
      console.log('Navigation timeout - checking if already on task view')
      const currentUrl = page.url()
      console.log('Current URL:', currentUrl)
      if (!currentUrl.includes('taskId')) {
        throw new Error('Page did not navigate to task view after clicking send')
      }
    }
    await page.waitForTimeout(2000)

    // Wait for AI response - use more flexible selector
    const messagesContainer = page.locator('[data-testid="messages-container"]').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    // Wait for AI message to appear (AI messages have data-testid="ai-message-icon")
    const aiMessage = messagesContainer.locator('[data-message-type="ai"]').first()
    await expect(aiMessage).toBeVisible({ timeout: 120000 })

    // Wait for the AI icon to confirm it's an AI message
    const aiIcon = aiMessage.locator('[data-testid="ai-message-icon"]').first()
    await expect(aiIcon).toBeVisible({ timeout: 10000 })

    // Wait for streaming to complete
    await page.waitForTimeout(5000)

    // Wait for streaming to complete
    await page.waitForTimeout(5000)

    // Verify the response
    const allMessages = await messagesContainer.locator('[data-message-type]').all()
    expect(allMessages.length).toBeGreaterThanOrEqual(2)

    // Verify user message
    const userMessage = messagesContainer.locator('[data-message-type="user"]').first()
    const userMessageText = await userMessage.textContent()
    expect(userMessageText).toContain(testMessage)

    // Verify AI message has content
    const aiMessageFinal = messagesContainer.locator('[data-message-type="ai"]').last()
    const aiMessageText = await aiMessageFinal.textContent()
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

    // Wait for page navigation to task view (URL should change from /code to /code?taskId=xxx)
    await page.waitForURL(/\/code\?.*taskId=/, { timeout: 30000 })
    await page.waitForTimeout(2000)

    // Wait for AI response
    const messagesContainer = page.locator('[data-testid="messages-container"]').first()
    await expect(messagesContainer).toBeVisible({ timeout: 30000 })

    // Wait for AI message (AI messages have data-message-type="ai")
    const aiMessage = messagesContainer.locator('[data-message-type="ai"]').first()
    await expect(aiMessage).toBeVisible({ timeout: 120000 })

    // Wait for streaming to complete
    await page.waitForTimeout(5000)

    // Check if AI response has meaningful content
    const aiMessageFinal = messagesContainer.locator('[data-message-type="ai"]').last()
    const aiMessageText = await aiMessageFinal.textContent()
    console.log('AI Response:', aiMessageText?.substring(0, 300) + '...')

    // Verify AI responded with some content (at least 10 characters)
    expect(aiMessageText).toBeTruthy()
    expect(aiMessageText!.length).toBeGreaterThan(10)

    console.log('Code creation test passed ✓')
  })
})
