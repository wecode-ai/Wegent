import { test, expect } from '../../fixtures/test-fixtures'
import { ADMIN_USER } from '../../config/test-users'
import { buildCliTeamResource, parseCliJson, runWegentCli } from '../../utils/cli'
import { createApiClient } from '../../utils/api-client'

const AGENT_RESOURCES_URL = '/resource-library?tab=mine&type=agent&scope=personal'

test.describe('CLI and page mixed E2E', () => {
  let token: string
  let createdTeamName: string | null = null

  test.beforeEach(async ({ request }) => {
    const apiClient = createApiClient(request)
    const loginResponse = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)

    expect(loginResponse.status).toBe(200)
    expect(loginResponse.data?.access_token).toEqual(expect.any(String))
    token = loginResponse.data!.access_token
  })

  test.afterEach(async () => {
    if (!createdTeamName) {
      return
    }

    await runWegentCli(['kind', 'delete', 'team', createdTeamName, '--json'], {
      token,
    }).catch(() => {})
    createdTeamName = null
  })

  test('shows and removes a CLI-created team in the agent resource page', async ({
    page,
  }, testInfo) => {
    const teamName = `e2e-cli-page-${testInfo.workerIndex}-${Date.now()}`
    const teamResource = buildCliTeamResource(teamName)
    createdTeamName = teamName

    const applyResult = await runWegentCli(['kind', 'apply', '--input', '-', '--json'], {
      token,
      stdin: JSON.stringify(teamResource),
    })
    const applyEnvelope = parseCliJson<{ success: boolean }>(applyResult)

    expect(applyResult.exitCode, applyResult.stderr || applyResult.stdout).toBe(0)
    expect(applyEnvelope.success).toBe(true)
    expect(applyEnvelope.data.success).toBe(true)

    await page.goto(AGENT_RESOURCES_URL)
    await page.waitForLoadState('domcontentloaded')

    await expect(page.locator('[data-testid="my-resources"]')).toBeVisible({
      timeout: 20000,
    })
    await expect(page.locator('[data-testid="team-list-items"]')).toBeVisible({
      timeout: 20000,
    })

    const createdTeamCard = page
      .locator('[data-testid^="team-card-"]')
      .filter({ hasText: teamName })
      .first()
    await expect(createdTeamCard).toBeVisible({ timeout: 20000 })

    const deleteResult = await runWegentCli(['kind', 'delete', 'team', teamName, '--json'], {
      token,
    })
    const deleteEnvelope = parseCliJson<{ message: string }>(deleteResult)

    expect(deleteResult.exitCode, deleteResult.stderr || deleteResult.stdout).toBe(0)
    expect(deleteEnvelope.success).toBe(true)
    createdTeamName = null

    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="team-list-items"]')).toBeVisible({
      timeout: 20000,
    })
    await expect(
      page.locator('[data-testid^="team-card-"]').filter({ hasText: teamName })
    ).toHaveCount(0, { timeout: 20000 })
  })
})
