import { test, expect } from '../fixtures/test-fixtures'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient } from '../utils/api-client'

test('finds older agents in management and chat after creating 205 agents', async ({
  page,
  request,
  testPrefix,
}) => {
  test.setTimeout(180_000)
  const api = createApiClient(request)
  const login = await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)
  expect(login.status).toBe(200)
  const created: Array<{ id: number; name: string }> = []
  const bot = await api.createBot({
    name: `${testPrefix}-pagination-bot`,
    shell_name: 'Chat',
    agent_config: {},
    system_prompt: 'Agent catalog pagination fixture.',
    namespace: 'default',
  })
  expect(bot.status).toBe(201)
  const botId = (bot.data as { id: number }).id

  try {
    for (let index = 0; index < 205; index += 1) {
      const team = await api.createTeam({
        name: `${testPrefix}-agent-${index}`,
        bots: [{ bot_id: botId, role: 'leader', bot_prompt: '' }],
        bind_mode: ['chat'],
        namespace: 'default',
        requires_workspace: false,
      })
      expect(team.status).toBe(201)
      created.push(team.data as { id: number; name: string })
    }
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
    await page.goto('/resource-library?tab=mine&type=agent&source=mine')
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(100)
    expect(searchRequests).toEqual([])
    expect(catalogRequests).toHaveLength(1)
    expect(new URL(catalogRequests[0]).searchParams.get('page')).toBe('1')
    await page.getByTestId('team-list-load-more-trigger').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(200)
    expect(searchRequests).toEqual([])
    expect(catalogRequests).toHaveLength(2)
    expect(new URL(catalogRequests[1]).searchParams.get('page')).toBe('2')

    await page.getByTestId('resource-library-header-search-input').fill(testPrefix)
    await page.getByTestId('resource-library-header-search-input').press('Enter')
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(100)
    expect(searchRequests).toHaveLength(1)
    await page.getByTestId('team-list-load-more-trigger').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(200)
    await page.getByTestId('team-list-load-more-trigger').scrollIntoViewIfNeeded()
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
    const cleanupErrors: string[] = []
    for (const team of created) {
      const result = await api.delete(
        `/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`
      )
      if (result.status !== 200) cleanupErrors.push(`Team ${team.id}: ${result.status}`)
    }
    const result = await api.delete(`/api/bots/${botId}?force=true`)
    if (result.status !== 200) cleanupErrors.push(`Bot ${botId}: ${result.status}`)
    expect(cleanupErrors, 'Pagination fixtures must be removed').toEqual([])
  }
})
