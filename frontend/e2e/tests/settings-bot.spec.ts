import { test, expect, TestData } from '../fixtures/test-fixtures'
import type { Page } from '@playwright/test'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient } from '../utils/api-client'

const AGENT_RESOURCES_URL = '/resource-library?tab=mine&type=agent&source=mine'

async function expectAgentResourcePage(page: Page) {
  await expect(page).toHaveURL(/\/resource-library/)
  await expect(page.locator('[data-testid="my-resources"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="resource-type-agent-filter"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('[data-testid="resource-library-content"]')).toBeVisible({
    timeout: 15000,
  })
}

async function expectTeamListHasContentOrEmptyState(page: Page) {
  await expect(page.locator('[data-testid="team-list-items"]')).toBeVisible({ timeout: 15000 })
  await expect
    .poll(
      async () => {
        const teamCount = await page.locator('[data-testid^="team-card-"]').count()
        const emptyVisible = await page
          .locator('[data-testid="team-empty-state"]')
          .isVisible()
          .catch(() => false)

        return teamCount > 0 || emptyVisible
      },
      { timeout: 10000 }
    )
    .toBe(true)
}

async function openCreateAgentDialog(page: Page) {
  await page.locator('[data-testid="new-capability-button"]').click()
  await expect(page.locator('[data-testid="new-capability-menu"]')).toBeVisible({
    timeout: 10000,
  })
  await page.locator('[data-testid="new-capability-type-agent"]').click()

  const dialog = page.locator('[role="dialog"]')
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(dialog.locator('[data-testid="team-display-name-input"]')).toBeVisible({
    timeout: 10000,
  })
  return dialog
}

test.describe('Resource Library - Bot-backed Agent Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(AGENT_RESOURCES_URL)
    await page.waitForLoadState('domcontentloaded')
    await expectAgentResourcePage(page)
  })

  test('should access bot-backed agent management in resource library', async ({ page }) => {
    await expect(page.locator('[data-testid="new-capability-button"]')).toBeVisible({
      timeout: 15000,
    })
    await expect(page.locator('[data-testid="resource-library-source-segments"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="resource-library-source-mine-button"]')
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('should display agent list or empty state', async ({ page }) => {
    await expectTeamListHasContentOrEmptyState(page)
  })

  test('should open create agent form', async ({ page }) => {
    const dialog = await openCreateAgentDialog(page)

    await expect(dialog.locator('[data-testid="team-display-name-input"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-basic-content"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-executor-simple-card"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-executor-complex-card"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-executor-complex-radio"]')).toBeChecked()
    await expect(dialog.locator('[data-testid="simple-coding-runtime-codex-card"]')).toBeVisible()
    await expect(
      dialog.locator('[data-testid="simple-coding-runtime-claude_code-card"]')
    ).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-model-select"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-prompt-textarea"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-capability-content"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-advanced-trigger"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="team-save-publish-section"]')).toBeVisible()

    await dialog.locator('[data-testid="simple-executor-simple-card"]').click()
    await expect(dialog.locator('[data-testid="simple-executor-simple-radio"]')).toBeChecked()
    await expect(
      dialog.locator('[data-testid="simple-coding-runtime-codex-card"]')
    ).not.toBeVisible()

    await dialog.locator('[data-testid="simple-executor-complex-card"]').click()
    await expect(dialog.locator('[data-testid="simple-executor-complex-radio"]')).toBeChecked()
    await expect(dialog.locator('[data-testid="simple-coding-runtime-codex-card"]')).toBeVisible()
  })

  test('should expose embedded bot configuration fields', async ({ page }) => {
    const dialog = await openCreateAgentDialog(page)

    await dialog.locator('[data-testid="simple-section-advanced-trigger"]').click()
    await expect(dialog.locator('[data-testid="simple-section-advanced-content"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-bind-mode-settings-content"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-bind-mode-chat-card"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-bind-mode-code-card"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-bind-mode-task-card"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-prompt-textarea"]')).toBeVisible()

    await dialog.locator('[data-testid="simple-additional-capabilities-toggle"]').click()
    await expect(dialog.locator('[data-testid="simple-manage-skills-button"]')).toBeVisible()
  })

  test('should persist shared base capabilities without hiding skills', async ({
    page,
    request,
    testPrefix,
  }) => {
    const apiClient = createApiClient(request)
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    const agentDisplayName = TestData.uniqueName(`${testPrefix}-base-capabilities`)
    let botName = ''
    let teamName = ''

    try {
      const dialog = await openCreateAgentDialog(page)
      const baseCapabilitiesSwitch = dialog.locator(
        '[data-testid="inherit-base-capabilities-switch"]'
      )

      await expect(baseCapabilitiesSwitch).toBeChecked()
      await expect(
        dialog.getByText(
          /Reuse the system agent's general skills, tools, and plugins|沿用系统智能体的通用 Skill、工具和插件能力/
        )
      ).toBeVisible()
      await dialog.locator('[data-testid="simple-additional-capabilities-toggle"]').click()
      await expect(dialog.locator('[data-testid="simple-manage-skills-button"]')).toBeVisible()

      await baseCapabilitiesSwitch.click()
      await expect(baseCapabilitiesSwitch).not.toBeChecked()
      await baseCapabilitiesSwitch.click()
      await expect(baseCapabilitiesSwitch).toBeChecked()

      await dialog.locator('[data-testid="team-display-name-input"]').fill(agentDisplayName)
      const botResponsePromise = page.waitForResponse(
        response =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/bots'
      )
      const teamResponsePromise = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/teams'
      )

      await dialog.getByRole('button', { name: /Save|保存/ }).click()

      const botResponse = await botResponsePromise
      expect(botResponse.ok(), await botResponse.text()).toBe(true)
      const botRequest = botResponse.request().postDataJSON() as {
        inherit_base_capabilities?: boolean
        capability_mode?: string
      }
      expect(botRequest.inherit_base_capabilities).toBe(true)
      expect(botRequest.capability_mode).toBe('manual')

      const savedBot = (await botResponse.json()) as {
        name: string
        inherit_base_capabilities?: boolean
      }
      botName = savedBot.name
      expect(savedBot.inherit_base_capabilities).toBe(true)

      const teamResponse = await teamResponsePromise
      expect(teamResponse.ok(), await teamResponse.text()).toBe(true)
      const savedTeam = (await teamResponse.json()) as { name: string }
      teamName = savedTeam.name

      const persistedBots = await apiClient.getBots('personal')
      expect(persistedBots.status).toBe(200)
      const persistedBot = (
        persistedBots.data as {
          items?: Array<{
            name: string
            inherit_base_capabilities?: boolean
            capability_mode?: string
          }>
        }
      ).items?.find(bot => bot.name === botName)
      expect(persistedBot).toMatchObject({
        name: botName,
        inherit_base_capabilities: true,
        capability_mode: 'manual',
      })
    } finally {
      if (teamName) {
        await apiClient.deleteTeam(teamName).catch(() => undefined)
      }
      if (botName) {
        await apiClient.deleteBot(botName).catch(() => undefined)
      }
    }
  })

  test('should accept bot-backed agent form input', async ({ page, testPrefix }) => {
    const dialog = await openCreateAgentDialog(page)
    const displayName = `${TestData.uniqueName(`${testPrefix}-agent`)} Display`
    const prompt = 'You are an assistant created by the bot-backed agent E2E test.'

    await dialog.locator('[data-testid="team-display-name-input"]').fill(displayName)
    await dialog.locator('[data-testid="simple-prompt-textarea"]').fill(prompt)

    await expect(dialog.locator('[data-testid="team-display-name-input"]')).toHaveValue(displayName)
    await expect(dialog.locator('[data-testid="simple-prompt-textarea"]')).toHaveValue(prompt)
  })
})
