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
})
