import { test, expect } from '../fixtures/test-fixtures'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient } from '../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'

const FIXTURE_CONCURRENCY = 16

async function runInBatches<T, R>(values: T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let offset = 0; offset < values.length; offset += FIXTURE_CONCURRENCY) {
    const batch = values.slice(offset, offset + FIXTURE_CONCURRENCY)
    results.push(...(await Promise.all(batch.map(operation))))
  }
  return results
}

test('finds older agents in management and chat after creating 205 agents', async ({
  browser,
  baseURL,
  request,
  testPrefix,
}) => {
  test.setTimeout(180_000)
  const admin = createApiClient(request)
  expect((await admin.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
  // Other workers mutate the shared admin catalog; fixed page counts need a dedicated owner.
  const username = `${testPrefix}-pagination-owner`
  const password = 'E2E-pagination-123!'
  const owner = await admin.adminCreateUser({
    user_name: username,
    password,
    role: 'user',
    auth_source: 'password',
  })
  expect(owner.status).toBe(201)
  const ownerId = (owner.data as { id: number }).id
  const api = createApiClient(request)
  const created: Array<{ id: number; name: string }> = []
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined
  let botId: number | undefined

  try {
    const login = await api.login(username, password, 1)
    expect(login.status).toBe(200)
    const token = login.data?.access_token
    expect(token).toBeTruthy()
    const appBaseUrl = baseURL || 'http://localhost:3000'
    context = await browser.newContext({
      baseURL: appBaseUrl,
      storageState: buildStorageState(appBaseUrl, token!, getJwtExpiryMs(token!)),
    })
    await context.addInitScript(() => {
      localStorage.setItem('user_onboarding_completed', 'true')
    })
    const page = await context.newPage()
    const bot = await api.createBot({
      name: `${testPrefix}-pagination-bot`,
      shell_name: 'Chat',
      agent_config: {},
      system_prompt: 'Agent catalog pagination fixture.',
      namespace: 'default',
    })
    expect(bot.status).toBe(201)
    botId = (bot.data as { id: number }).id

    const teamResults = await runInBatches(
      Array.from({ length: 205 }, (_, index) => index),
      index =>
        api.createTeam({
          name: `${testPrefix}-agent-${index}`,
          bots: [{ bot_id: botId, role: 'leader', bot_prompt: '' }],
          bind_mode: ['chat'],
          namespace: 'default',
          requires_workspace: false,
        })
    )
    const creationErrors: string[] = []
    for (const [index, team] of teamResults.entries()) {
      if (team.status === 201) {
        created.push(team.data as { id: number; name: string })
      } else {
        creationErrors.push(`Team ${index}: ${team.status}`)
      }
    }
    expect(creationErrors, 'Pagination fixtures must be created').toEqual([])

    const oldest = created[0]
    const firstPage = await api.get<{ items: Array<{ id: number }> }>(
      '/api/teams?page=1&limit=100&scope=all'
    )
    expect(firstPage.status).toBe(200)
    expect(firstPage.data?.items.some(team => team.id === oldest.id)).toBe(false)

    const searchRequests: string[] = []
    const catalogRequests: string[] = []
    page.on('request', request => {
      if (request.url().includes('/resource-library/search?')) searchRequests.push(request.url())
      if (new URL(request.url()).pathname.endsWith('/api/teams'))
        catalogRequests.push(request.url())
    })
    // Match API order so later pages append instead of moving the scroll anchor.
    await page.goto('/resource-library?tab=mine&type=agent&source=mine&sort=latest')
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(100)
    expect(searchRequests).toEqual([])
    expect(catalogRequests).toHaveLength(1)
    expect(new URL(catalogRequests[0]).searchParams.get('page')).toBe('1')
    // Anchor scrolling to an existing card, not the sentinel that moves as pages append.
    await page.locator('[data-testid^="team-card-"]').nth(99).scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(200)
    expect(searchRequests).toEqual([])
    expect(catalogRequests).toHaveLength(2)
    expect(new URL(catalogRequests[1]).searchParams.get('page')).toBe('2')

    await page.getByTestId('resource-library-header-search-input').fill(testPrefix)
    await page.getByTestId('resource-library-header-search-input').press('Enter')
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(100)
    expect(searchRequests).toHaveLength(1)
    await page.locator('[data-testid^="team-card-"]').nth(99).scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(200)
    await page.locator('[data-testid^="team-card-"]').nth(199).scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(205)
    expect(searchRequests).toHaveLength(3)
    await page.getByTestId('resource-library-header-search-input').fill(oldest.name)
    await page.getByTestId('resource-library-header-search-input').press('Enter')
    await expect(page.getByTestId(`team-card-${oldest.id}`)).toBeVisible()
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(1)
    expect(searchRequests).toHaveLength(4)

    const searchResponse = page.waitForResponse(
      response => response.url().includes('/resource-library/search?') && response.ok()
    )
    await page.goto(
      `/resource-library?tab=mine&type=agent&source=mine&keyword=${encodeURIComponent(oldest.name)}`
    )
    await searchResponse
    await expect(page.getByTestId(`team-card-${oldest.id}`)).toBeVisible()

    await page.goto(`/chat?teamId=${oldest.id}`)
    await expect(page.getByTestId('selected-team-badge')).toContainText(oldest.name)
  } finally {
    const cleanupResults = await runInBatches(created, async team => ({
      team,
      result: await api.delete(
        `/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`
      ),
    }))
    const cleanupErrors = cleanupResults.flatMap(({ team, result }) =>
      result.status === 200 ? [] : [`Team ${team.id}: ${result.status}`]
    )
    if (botId !== undefined) {
      const result = await api.delete(`/api/bots/${botId}?force=true`)
      if (result.status !== 200) cleanupErrors.push(`Bot ${botId}: ${result.status}`)
    }
    await context?.close()
    const deletedOwner = await admin.adminDeleteUser(ownerId)
    if (deletedOwner.status !== 204) cleanupErrors.push(`Owner ${ownerId}: ${deletedOwner.status}`)
    expect(cleanupErrors, 'Pagination fixtures must be removed').toEqual([])
  }
})
