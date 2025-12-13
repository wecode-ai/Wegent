import { test, expect } from '@playwright/test'
import { BotsPage } from '../../pages/settings/bots.page'
import { DataBuilders } from '../../fixtures/data-builders'
import { createApiClient, ApiClient } from '../../utils/api-client'
import { ADMIN_USER } from '../../config/test-users'

test.describe('Settings - Bots CRUD', () => {
  let botsPage: BotsPage
  let apiClient: ApiClient
  let testBotName: string

  test.beforeEach(async ({ page, request }) => {
    botsPage = new BotsPage(page)
    apiClient = createApiClient(request)
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    await botsPage.navigate()
  })

  test.afterEach(async () => {
    // Cleanup: delete test bot if created
    if (testBotName) {
      await apiClient.deleteBot(testBotName).catch(() => {})
      testBotName = ''
    }
  })

  test('should display bots list', async () => {
    expect(botsPage.isOnSettingsPage()).toBe(true)
    const count = await botsPage.getBotCount()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('should create a new bot successfully', async () => {
    const botData = DataBuilders.bot()
    testBotName = botData.metadata.name

    await botsPage.clickCreateBot()
    await botsPage.fillBotForm({
      name: testBotName,
      description: botData.spec.description,
    })
    await botsPage.submitBotForm()

    // Wait for toast notification
    await botsPage.waitForToast()

    // Verify bot appears in list
    await botsPage.searchBot(testBotName)
    expect(await botsPage.botExists(testBotName)).toBe(true)
  })

  test('should search for bots', async () => {
    // Create a bot via API for searching
    const botData = DataBuilders.bot()
    testBotName = botData.metadata.name
    await apiClient.createBot(botData)

    // Refresh and search
    await botsPage.navigate()
    await botsPage.searchBot(testBotName)

    expect(await botsPage.botExists(testBotName)).toBe(true)
  })

  test('should delete a bot', async () => {
    // Create bot via API
    const botData = DataBuilders.bot()
    testBotName = botData.metadata.name
    await apiClient.createBot(botData)

    // Refresh page
    await botsPage.navigate()
    await botsPage.searchBot(testBotName)

    // Delete via UI
    await botsPage.deleteBot(testBotName)

    // Verify bot is gone
    await botsPage.searchBot(testBotName)
    expect(await botsPage.botExists(testBotName)).toBe(false)

    // Clear testBotName as it's already deleted
    testBotName = ''
  })

  test('should filter bots by scope', async () => {
    // Get count with 'all' scope
    await botsPage.selectScope('all')
    const allCount = await botsPage.getBotCount()

    // Get count with 'personal' scope
    await botsPage.selectScope('personal')
    const personalCount = await botsPage.getBotCount()

    // Personal should be <= all
    expect(personalCount).toBeLessThanOrEqual(allCount)
  })

  test('should validate required fields when creating bot', async ({ page }) => {
    await botsPage.clickCreateBot()

    // Try to submit without name
    await botsPage.submitBotForm()

    // Should show validation error or stay in dialog
    const dialog = page.locator('[role="dialog"]')
    expect(await dialog.isVisible()).toBe(true)
  })
})
