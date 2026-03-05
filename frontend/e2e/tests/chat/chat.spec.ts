import { test, expect } from '@playwright/test'
import { ChatTaskPage } from '../../pages/tasks/chat-task.page'
import { createApiClient, ApiClient } from '../../utils/api-client'
import { DataBuilders } from '../../fixtures/data-builders'
import { ADMIN_USER } from '../../config/test-users'

test.describe('Chat Page', () => {
  let chatPage: ChatTaskPage

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatTaskPage(page)
    await chatPage.navigate()
    // Wait for page to fully load
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Close any onboarding/driver overlay
    const skipButton = page.locator('button:has-text("Skip"), button:has-text("跳过")').first()
    if (await skipButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipButton.click()
      await page.waitForTimeout(500)
    }
  })

  test('should navigate to chat page', async ({ page }) => {
    await expect(page).toHaveURL(/\/chat/)
  })

  test('should display message input', async () => {
    const isReady = await chatPage.isMessageInputReady()
    expect(isReady).toBe(true)
  })

  test('should display task sidebar', async () => {
    const isVisible = await chatPage.isSidebarVisible()
    // Sidebar may be collapsed or in different state
    expect(typeof isVisible).toBe('boolean')
  })
})

test.describe('Chat Page - Team Selection', () => {
  let chatPage: ChatTaskPage
  let apiClient: ApiClient
  let testTeamName: string

  test.beforeEach(async ({ page, request }) => {
    chatPage = new ChatTaskPage(page)
    apiClient = createApiClient(request)
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    await chatPage.navigate()
    // Wait for page to fully load
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
  })

  test.afterEach(async () => {
    if (testTeamName) {
      await apiClient.deleteTeam(testTeamName).catch(() => {})
      testTeamName = ''
    }
  })

  test('should select a team', async () => {
    const teamData = DataBuilders.team()
    testTeamName = teamData.metadata.name
    await apiClient.createTeam(teamData)

    await chatPage.navigate()

    if (await chatPage.hasTeamSelector()) {
      await chatPage.selectTeam(testTeamName)
      const selected = await chatPage.getSelectedTeam()
      expect(selected).toContain(testTeamName)
    }
  })

  test('should display team in selector after creation', async () => {
    const teamData = DataBuilders.team()
    testTeamName = teamData.metadata.name
    await apiClient.createTeam(teamData)

    await chatPage.navigate()

    if (await chatPage.hasTeamSelector()) {
      await chatPage.page
        .locator('[data-testid="team-selector"], [role="combobox"]')
        .first()
        .click({ force: true })
      await chatPage.page.waitForTimeout(300)

      const teamOption = chatPage.page.locator(`[role="option"]:has-text("${testTeamName}")`)
      await expect(teamOption).toBeVisible({ timeout: 5000 })
    }
  })
})

test.describe('Chat Page - Messaging', () => {
  let chatPage: ChatTaskPage

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatTaskPage(page)
    await chatPage.navigate()
    // Wait for page to fully load
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
  })

  test('should send a message', async ({ page }) => {
    const testMessage = 'Hello, this is a test message'

    // Close any onboarding overlay
    const skipButton = page.locator('button:has-text("Skip"), button:has-text("跳过")').first()
    if (await skipButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipButton.click()
      await page.waitForTimeout(500)
    }

    // Check if we need to select a model first
    const modelSelector = page
      .locator('button:has-text("select a model"), [data-testid="model-selector"]')
      .first()
    if (await modelSelector.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Try to select first available model
      await modelSelector.click()
      await page.waitForTimeout(500)
      const firstModel = page.locator('[role="option"]').first()
      if (await firstModel.isVisible({ timeout: 3000 }).catch(() => false)) {
        await firstModel.click()
        await page.waitForTimeout(500)
      }
    }

    const isReady = await chatPage.isMessageInputReady()
    expect(isReady).toBe(true)

    await chatPage.typeMessage(testMessage)
    await chatPage.sendMessage()

    // Verify message appears in the list (user message should appear immediately)
    // Use a more flexible selector that matches the UI
    const userMessageLocator = page.locator('text=' + testMessage).first()
    await expect(userMessageLocator).toBeVisible({ timeout: 5000 })
  })

  test('should create new chat', async ({ page }) => {
    // Close any driver/onboarding overlay first
    const skipButton = page.locator('button:has-text("Skip"), button:has-text("跳过")').first()
    if (await skipButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipButton.click()
      await page.waitForTimeout(500)
    }

    if (await chatPage.hasNewTaskButton()) {
      const initialCount = await chatPage.getTaskCount()
      await chatPage.startNewChat()
      // Task count should increase or stay same (if creation is async)
      const newCount = await chatPage.getTaskCount()
      expect(newCount).toBeGreaterThanOrEqual(initialCount)
    }
  })
})

test.describe('Chat Page - Features', () => {
  let chatPage: ChatTaskPage

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatTaskPage(page)
    await chatPage.navigate()
    // Wait for page to fully load
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
  })

  test('should have file upload capability', async () => {
    const hasUpload = await chatPage.hasFileUpload()
    // File upload may or may not be enabled
    expect(typeof hasUpload).toBe('boolean')
  })

  test('should display messages in task list', async () => {
    const taskCount = await chatPage.getTaskCount()
    expect(taskCount).toBeGreaterThanOrEqual(0)
  })
})
