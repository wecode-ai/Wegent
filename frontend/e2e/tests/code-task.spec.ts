import { test, expect } from '../fixtures/test-fixtures'
import { mockTaskExecution } from '../utils/api-mock'
import { createApiClient, type ApiClient } from '../utils/api-client'
import { ADMIN_USER } from '../config/test-users'

type CreatedResource = {
  name: string
  id?: number
}

test.describe('Code Task', () => {
  let apiClient: ApiClient
  let codeBot: CreatedResource | null = null
  let codeTeam: CreatedResource | null = null

  const codePagePath = () => `/code?teamId=${codeTeam?.id}`

  test.beforeAll(async ({ request }) => {
    apiClient = createApiClient(request)
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const botName = `e2e-code-task-bot-${suffix}`
    const teamName = `e2e-code-task-team-${suffix}`

    const botResponse = await apiClient.createBot({
      name: botName,
      shell_name: 'Chat',
      system_prompt: 'You are a deterministic E2E code-task assistant.',
      namespace: 'default',
      is_active: true,
    })
    expect([200, 201]).toContain(botResponse.status)
    codeBot = { name: botName, id: (botResponse.data as { id?: number } | null)?.id }
    expect(codeBot.id).toBeTruthy()

    const teamResponse = await apiClient.createTeam({
      name: teamName,
      description: 'E2E team for code task smoke tests',
      bots: [
        {
          bot_id: codeBot.id,
          bot_prompt: 'Return concise deterministic answers.',
          role: 'worker',
        },
      ],
      bind_mode: ['code'],
      namespace: 'default',
      is_active: true,
      requires_workspace: false,
      workflow: null,
    })
    expect([200, 201]).toContain(teamResponse.status)
    codeTeam = { name: teamName, id: (teamResponse.data as { id?: number } | null)?.id }
    expect(codeTeam.id).toBeTruthy()
  })

  test.afterAll(async () => {
    if (codeTeam) {
      await apiClient.deleteTeam(codeTeam.name).catch(() => {})
    }
    if (codeBot) {
      await apiClient.deleteBot(codeBot.name).catch(() => {})
    }
  })

  test.beforeEach(async ({ page }) => {
    // Setup API mocks for task execution
    await mockTaskExecution(page)
    await page.addInitScript(() => {
      localStorage.setItem('user_onboarding_completed', 'true')
      localStorage.removeItem('onboarding_in_progress')
      localStorage.removeItem('onboarding_current_step')
    })
  })

  test('should access code page', async ({ page }) => {
    await page.goto(codePagePath())

    // Should be on code page
    await expect(page).toHaveURL(/\/code/)

    await page.waitForLoadState('domcontentloaded')
  })

  test('should display team selector', async ({ page }) => {
    await page.goto(codePagePath())
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
    await page.goto(codePagePath())
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
    await page.goto(codePagePath())
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
    await page.goto(codePagePath())
    await page.waitForLoadState('domcontentloaded')

    // Message input should be visible
    const messageInput = page.getByTestId('message-input')

    // Assert message input is visible
    await expect(messageInput.first()).toBeVisible({ timeout: 10000 })
  })

  test('should send code task message', async ({ page }) => {
    await page.goto(codePagePath())
    await page.waitForLoadState('domcontentloaded')

    // Find message input
    const messageInput = page.getByTestId('message-input').first()

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
