import { expect, type Page } from '@playwright/test'
import { expectSelected, test, type HistoryTeam } from '../../fixtures/recent-team-history'

async function openCodePage(page: Page, teamId?: number): Promise<void> {
  const params = new URLSearchParams({ agent: 'code' })
  if (teamId !== undefined) params.set('teamId', String(teamId))
  await page.goto(`/chat?${params.toString()}`, { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(/\/chat\?.*agent=code/)
  await expect(page.getByTestId('quick-access-more-button')).toBeVisible({ timeout: 15000 })
}

async function expectCodeModeSelected(page: Page, team: HistoryTeam): Promise<void> {
  await expectSelected(page, team)
  await expect
    .poll(() => new URL(page.url()).searchParams.get('agent'), {
      message: 'Selecting a code-capable agent must keep the code page',
    })
    .toBe('code')
}

async function selectFromAllAgents(page: Page, team: HistoryTeam): Promise<void> {
  await page.getByTestId('quick-access-more-button').click()
  await page.getByTestId('quick-access-view-all-agents').click()
  await page.getByTestId(`quick-access-more-team-${team.name}`).click()
}

test.describe('Agent selection keeps the current page mode', () => {
  test('dual-mode agent selected from all agents stays in code mode', async ({ page, history }) => {
    const initialTeam = await history.teamWithModes('dual-all-agents-initial', ['chat', 'code'])
    const team = await history.teamWithModes('dual-all-agents', ['chat', 'code'])

    await openCodePage(page, initialTeam.id)
    await expectSelected(page, initialTeam)
    await selectFromAllAgents(page, team)

    await expectCodeModeSelected(page, team)
  })

  test('dual-mode agent selected from the input selector stays in code mode', async ({
    page,
    history,
  }) => {
    const initialTeam = await history.teamWithModes('dual-selector-initial', ['chat', 'code'])
    const team = await history.teamWithModes('dual-selector', ['chat', 'code'])
    await history.seed(team, 'code')

    await openCodePage(page, initialTeam.id)
    await expectSelected(page, initialTeam)
    await page.getByTestId('agent-skill-selector-button').click()
    await page.getByTestId(`team-option-${team.name}`).click()

    await expectCodeModeSelected(page, team)
  })

  test('chat-only agent selected from all agents switches to chat', async ({ page, history }) => {
    const team = await history.teamWithModes('chat-only', ['chat'])

    await openCodePage(page)
    await selectFromAllAgents(page, team)

    await expect(page).toHaveURL(new RegExp(`/chat\\?teamId=${team.id}$`))
    expect(new URL(page.url()).searchParams.get('agent')).toBeNull()
    await expectSelected(page, team)
  })
})
