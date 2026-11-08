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

async function openCreateTeamDialog(page: Page) {
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

test.describe('Settings - Team Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(AGENT_RESOURCES_URL)
    await page.waitForLoadState('domcontentloaded')
    await expectAgentResourcePage(page)
  })

  test('should access team management page', async ({ page }) => {
    await expect(page.locator('[data-testid="new-capability-button"]')).toBeVisible({
      timeout: 15000,
    })
    await expect(page.locator('[data-testid="resource-library-source-segments"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="resource-library-source-mine-button"]')
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('should display team list or empty state', async ({ page }) => {
    await expectTeamListHasContentOrEmptyState(page)
  })

  test('should open create team form', async ({ page }) => {
    const dialog = await openCreateTeamDialog(page)

    await expect(dialog.locator('[data-testid="team-display-name-input"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-model-select"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-basic-content"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-capability-content"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="simple-section-advanced-trigger"]')).toBeVisible()
  })

  test('should accept new team form input', async ({ page, testPrefix }) => {
    const dialog = await openCreateTeamDialog(page)
    const displayName = `${TestData.uniqueName(`${testPrefix}-team`)} Display`

    await dialog.locator('[data-testid="team-display-name-input"]').fill(displayName)

    await expect(dialog.locator('[data-testid="team-display-name-input"]')).toHaveValue(displayName)
  })

  test('should persist a custom executor and allow switching back to it when editing', async ({
    page,
    request,
    testPrefix,
  }) => {
    const api = createApiClient(request)
    const login = await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)
    expect(login.status).toBe(200)

    const shellName = `${testPrefix}-custom-shell`
    const shellDisplayName = `Custom executor ${testPrefix}`
    const displayName = `${testPrefix} Custom agent`
    const created: { botId?: number; team?: { id: number; name: string } } = {}

    const expectPersistedExecutor = async () => {
      const persisted = await api.get(`/api/bots/${created.botId}`)
      expect(persisted.status, JSON.stringify(persisted.data)).toBe(200)
      expect(persisted.data).toMatchObject({
        id: created.botId,
        shell_name: shellName,
        shell_type: 'ClaudeCode',
      })
    }

    try {
      const shell = await api.post('/api/shells', {
        name: shellName,
        displayName: shellDisplayName,
        baseShellRef: 'ClaudeCode',
        baseImage: 'python:3.11',
      })
      expect(shell.status, JSON.stringify(shell.data)).toBe(201)

      const dialog = await openCreateTeamDialog(page)
      const shellSelect = dialog.getByTestId('simple-custom-shell-select')
      const useCaseGroup = dialog.getByRole('radiogroup', { name: /Use case|用途/ })
      const engineGroup = dialog.getByRole('radiogroup', { name: /Execution engine|执行引擎/ })
      await expect(useCaseGroup.getByRole('radio')).toHaveCount(2)
      await expect(engineGroup.getByRole('radio')).toHaveCount(3)
      await expect(useCaseGroup.getByTestId('simple-executor-custom-card')).toHaveCount(0)
      await expect(engineGroup.getByTestId('simple-executor-custom-card')).toBeVisible()
      await expect(shellSelect).toHaveCount(0)
      await engineGroup.getByTestId('simple-executor-custom-card').click()
      await expect(engineGroup.getByTestId('simple-executor-custom-radio')).toBeChecked()
      await expect(useCaseGroup.getByTestId('simple-executor-complex-radio')).toBeChecked()
      await shellSelect.click()
      await page.getByRole('option', { name: shellDisplayName, exact: true }).click()
      await expect(shellSelect).toHaveText(shellDisplayName)
      await dialog.getByTestId('team-display-name-input').fill(displayName)

      const [botResponse, teamResponse] = await Promise.all([
        page
          .waitForResponse(
            response =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/api/bots'
          )
          .then(async response => {
            if (response.ok()) created.botId = ((await response.json()) as { id: number }).id
            return response
          }),
        page
          .waitForResponse(
            response =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/api/teams'
          )
          .then(async response => {
            if (response.ok()) {
              created.team = (await response.json()) as { id: number; name: string }
            }
            return response
          }),
        dialog.getByRole('button', { name: /Save|保存/ }).click(),
      ])
      expect(botResponse.ok(), await botResponse.text()).toBe(true)
      expect(teamResponse.ok(), await teamResponse.text()).toBe(true)
      expect(created.botId).toBeDefined()
      expect(created.team).toBeDefined()
      await expectPersistedExecutor()
      await expect(dialog).not.toBeVisible()

      await page.reload()
      await expectAgentResourcePage(page)
      await page.getByTestId(`edit-team-button-${created.team!.id}`).click()
      await expect(engineGroup.getByTestId('simple-executor-custom-radio')).toBeChecked()
      await expect(useCaseGroup.getByTestId('simple-executor-complex-radio')).toBeChecked()
      await expect(shellSelect).toHaveText(shellDisplayName)

      await engineGroup.getByTestId('simple-coding-runtime-codex-card').click()
      await expect(engineGroup.getByTestId('simple-coding-runtime-codex-radio')).toBeChecked()
      await expect(shellSelect).toHaveCount(0)
      await expect(engineGroup.getByTestId('simple-executor-custom-card')).toBeVisible()
      await engineGroup.getByTestId('simple-executor-custom-card').click()
      await expect(engineGroup.getByTestId('simple-executor-custom-radio')).toBeChecked()
      await expect(shellSelect).toHaveText(shellDisplayName)

      const [updatedBot, updatedTeam] = await Promise.all([
        page.waitForResponse(
          response =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname === `/api/bots/${created.botId}`
        ),
        page.waitForResponse(
          response =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname === `/api/teams/${created.team!.id}`
        ),
        dialog.getByRole('button', { name: /Save|保存/ }).click(),
      ])
      expect(updatedBot.ok(), await updatedBot.text()).toBe(true)
      expect(updatedTeam.ok(), await updatedTeam.text()).toBe(true)
      await expectPersistedExecutor()
    } finally {
      if (created.team) {
        const removed = await api.delete(
          `/api/teams/${created.team.id}?${new URLSearchParams({
            force: 'true',
            confirm_name: created.team.name,
          })}`
        )
        expect.soft([200, 204, 404], JSON.stringify(removed.data)).toContain(removed.status)
      }
      if (created.botId !== undefined) {
        const removed = await api.delete(`/api/bots/${created.botId}`)
        expect.soft([200, 204, 404], JSON.stringify(removed.data)).toContain(removed.status)
      }
      const removed = await api.delete(`/api/shells/${shellName}`)
      expect.soft([200, 204, 404], JSON.stringify(removed.data)).toContain(removed.status)
    }
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
