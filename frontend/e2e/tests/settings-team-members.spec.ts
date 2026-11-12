import { test, expect } from '../fixtures/test-fixtures'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient } from '../utils/api-client'

test('keeps a new member after editing its prompt, saving the agent, and reloading', async ({
  page,
  request,
  testPrefix,
}) => {
  const api = createApiClient(request)
  expect((await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
  const bots: Array<{ id: number; name: string }> = []
  let teamId: number | undefined
  const teamName = `${testPrefix}-team`
  const updatedPrompt = 'Diagnose frontend problems using concrete evidence.'

  try {
    for (const role of ['leader', 'diagnose']) {
      const response = await api.createBot({
        name: `${testPrefix}-${role}`,
        shell_name: 'Codex',
        agent_config: {},
        system_prompt: 'Original prompt',
        mcp_servers: {},
        namespace: 'default',
      })
      expect(response.status).toBe(201)
      bots.push(response.data as { id: number; name: string })
    }
    const [leader, member] = bots
    const team = await api.createTeam({
      name: teamName,
      namespace: 'default',
      workflow: { mode: 'pipeline', leader_bot_id: leader.id },
      bots: [{ bot_id: leader.id, role: 'leader', bot_prompt: '' }],
      bind_mode: ['code', 'task'],
    })
    expect(team.status).toBe(201)
    teamId = (team.data as { id: number }).id

    await page.goto(
      `/resource-library?tab=mine&type=agent&source=mine&keyword=${encodeURIComponent(testPrefix)}`
    )
    await page.getByTestId(`edit-team-button-${teamId}`).click()
    const dialog = page.getByTestId('team-edit-dialog')
    await expect(dialog.getByTestId(`pipeline-member-row-${leader.id}`)).toBeVisible()

    await dialog.getByTestId(`member-row-header-${member.id}`).click()
    await dialog.locator('button:has(svg.lucide-chevron-right)').click()
    await expect(dialog.getByTestId(`pipeline-member-row-${member.id}`)).toBeVisible()
    await dialog.getByTestId(`edit-bot-button-${member.id}`).click()

    const drawer = page.locator('[data-team-edit-drawer="true"]')
    const prompt = drawer.getByPlaceholder(/AI-powered code review|你是一个/)
    await expect(prompt).toHaveValue('Original prompt')
    await prompt.fill(updatedPrompt)
    const botSaved = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === `/api/bots/${member.id}`
    )
    await drawer.getByTestId('save-button').click()
    expect((await botSaved).ok()).toBe(true)
    await expect(drawer).not.toBeVisible()
    await expect(dialog.getByTestId(`pipeline-member-row-${member.id}`)).toBeVisible()
    await expect(dialog.getByTestId(`pipeline-member-row-${leader.id}`)).toBeVisible()

    const teamSaved = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === `/api/teams/${teamId}`
    )
    await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
    const savedResponse = await teamSaved
    expect(savedResponse.ok()).toBe(true)
    expect(
      savedResponse
        .request()
        .postDataJSON()
        .bots.map((bot: { bot_id: number }) => bot.bot_id)
    ).toEqual([leader.id, member.id])
    await expect(dialog).not.toBeVisible()

    await page.reload()
    await page.getByTestId(`edit-team-button-${teamId}`).click()
    await expect(dialog.getByTestId(`pipeline-member-row-${member.id}`)).toBeVisible()
    await dialog.getByTestId(`edit-bot-button-${member.id}`).click()
    await expect(prompt).toHaveValue(updatedPrompt)
    const persistedTeam = await api.get<{ bots: Array<{ bot_id: number }> }>(`/api/teams/${teamId}`)
    expect(persistedTeam.status).toBe(200)
    expect(persistedTeam.data?.bots.map(bot => bot.bot_id)).toEqual([leader.id, member.id])
  } finally {
    if (teamId !== undefined) {
      const response = await api.delete(
        `/api/teams/${teamId}?${new URLSearchParams({ force: 'true', confirm_name: teamName })}`
      )
      expect(response.status).toBe(200)
    }
    for (const bot of bots) expect((await api.delete(`/api/bots/${bot.id}`)).status).toBe(200)
  }
})
