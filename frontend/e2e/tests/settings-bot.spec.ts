import { test, expect, TestData } from '../fixtures/test-fixtures'
import type { Page } from '@playwright/test'

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
  await expect(dialog.locator('input#teamName')).toBeVisible({ timeout: 10000 })
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
    await expect(dialog.locator('[data-testid="simple-model-select"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-basic-trigger"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-execution-trigger"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-prompt-trigger"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-capability-trigger"]')).toBeVisible()
  })

  test('should expose embedded bot configuration fields', async ({ page }) => {
    const dialog = await openCreateAgentDialog(page)

    await expect(dialog.locator('[data-testid="simple-bind-mode-chat-card"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-bind-mode-code-card"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-prompt-textarea"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-manage-skills-button"]')).toBeVisible()
  })

  test('should accept bot-backed agent form input', async ({ page, testPrefix }) => {
    const dialog = await openCreateAgentDialog(page)
    const agentName = TestData.uniqueName(`${testPrefix}-agent`)
    const displayName = `${agentName} Display`
    const prompt = 'You are an assistant created by the bot-backed agent E2E test.'

    await dialog.locator('input#teamName').fill(agentName)
    await dialog.locator('[data-testid="team-display-name-input"]').fill(displayName)
    await dialog.locator('[data-testid="simple-prompt-textarea"]').fill(prompt)

    await expect(dialog.locator('input#teamName')).toHaveValue(agentName)
    await expect(dialog.locator('[data-testid="team-display-name-input"]')).toHaveValue(displayName)
    await expect(dialog.locator('[data-testid="simple-prompt-textarea"]')).toHaveValue(prompt)
  })
})
