import { test, expect, TestData } from '../fixtures/test-fixtures'
import type { Page } from '@playwright/test'

const AGENT_RESOURCES_URL = '/resource-library?tab=mine&type=agent&scope=personal'
const TEAM_LIST_TITLE = 'h2:has-text("Team List"), h2:has-text("智能体列表")'

async function expectAgentResourcePage(page: Page) {
  await expect(page).toHaveURL(/\/resource-library/)
  await expect(page.locator('[data-testid="my-resources"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="managed-resource-agent-tab"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator(TEAM_LIST_TITLE)).toBeVisible({ timeout: 15000 })
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

async function openCreateTeamDialog(page: Page) {
  const createButton = page.locator('[data-testid="create-team-button"]')
  await expect(createButton).toBeVisible({ timeout: 20000 })
  await createButton.click()

  const dialog = page.locator('[role="dialog"]')
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(dialog.locator('input#teamName')).toBeVisible({ timeout: 10000 })
  return dialog
}

test.describe('Settings - Team Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(AGENT_RESOURCES_URL)
    await page.waitForLoadState('domcontentloaded')
    await expectAgentResourcePage(page)
  })

  test('should access team management page', async ({ page }) => {
    await expect(page.locator('[data-testid="create-team-button"]')).toBeVisible({
      timeout: 20000,
    })
    await expect(page.locator('[data-testid="create-team-wizard-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="team-mode-filter"]')).toBeVisible()
  })

  test('should display team list or empty state', async ({ page }) => {
    await expectTeamListHasContentOrEmptyState(page)
  })

  test('should open create team form', async ({ page }) => {
    const dialog = await openCreateTeamDialog(page)

    await expect(dialog.locator('[data-testid="team-display-name-input"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-model-select"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-basic-trigger"]')).toBeVisible()
  })

  test('should accept new team form input', async ({ page, testPrefix }) => {
    const dialog = await openCreateTeamDialog(page)
    const teamName = TestData.uniqueName(`${testPrefix}-team`)
    const displayName = `${teamName} Display`

    await dialog.locator('input#teamName').fill(teamName)
    await dialog.locator('[data-testid="team-display-name-input"]').fill(displayName)

    await expect(dialog.locator('input#teamName')).toHaveValue(teamName)
    await expect(dialog.locator('[data-testid="team-display-name-input"]')).toHaveValue(displayName)
  })

  test('should show actions for listed teams or an empty state', async ({ page }) => {
    await expectTeamListHasContentOrEmptyState(page)

    const teamCard = page.locator('[data-testid^="team-card-"]').first()
    if ((await teamCard.count()) > 0) {
      await expect(teamCard.locator('button').first()).toBeVisible()
      return
    }

    await expect(page.locator('[data-testid="team-empty-state"]')).toBeVisible()
  })
})
