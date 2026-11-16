// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ADMIN_USER } from '../../config/test-users'
import { expect, test } from '../../fixtures/test-fixtures'
import { createApiClient } from '../../utils/api-client'

interface Subscription {
  id: number
  trigger_config: { expression: string; timezone: string; workday_only: boolean }
}

test('subscription workday calendar survives create, list, edit and opt-out', async ({
  request,
  testPrefix,
}) => {
  const api = createApiClient(request)
  expect((await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
  const botName = `${testPrefix}-workday-bot`
  const teamName = `${testPrefix}-workday-agent`
  let botId: number | undefined
  let teamId: number | undefined
  const subscriptionIds: number[] = []

  try {
    const bot = await api.createBot({
      name: botName,
      shell_name: 'Chat',
      agent_config: {},
      system_prompt: 'Workday subscription persistence test.',
      namespace: 'default',
      is_active: true,
    })
    expect(bot.status, JSON.stringify(bot.data)).toBe(201)
    botId = (bot.data as { id: number }).id
    const team = await api.createTeam({
      name: teamName,
      bots: [{ bot_id: botId, role: 'leader' }],
      bind_mode: ['chat'],
      requires_workspace: false,
      workflow: { mode: 'solo' },
    })
    expect(team.status, JSON.stringify(team.data)).toBe(201)
    teamId = (team.data as { id: number }).id

    const cron = { expression: '0 9 * * *', timezone: 'Asia/Shanghai' }
    const payload = {
      display_name: `${testPrefix}-workdays`,
      team_id: teamId,
      trigger_type: 'cron',
      trigger_config: { ...cron, workday_only: true },
      prompt_template: 'Summarize the workday.',
      enabled: false,
    }
    const created = await api.post<Subscription>('/api/subscriptions', payload)
    expect(created.status, JSON.stringify(created.data)).toBe(201)
    const id = created.data!.id
    subscriptionIds.push(id)
    expect(created.data?.trigger_config).toEqual({ ...cron, workday_only: true })

    const path = `/api/subscriptions/${id}`
    const read = await api.get<Subscription>(path)
    expect(read.status).toBe(200)
    expect(read.data?.trigger_config.workday_only).toBe(true)

    const listed = await api.get<{ items: Subscription[] }>('/api/subscriptions?limit=100')
    expect(listed.status, JSON.stringify(listed.data)).toBe(200)
    expect(listed.data?.items.find(item => item.id === id)?.trigger_config).toEqual({
      ...cron,
      workday_only: true,
    })

    const edited = await api.put<Subscription>(path, { description: 'Calendar remains enabled' })
    expect(edited.status, JSON.stringify(edited.data)).toBe(200)
    expect(edited.data?.trigger_config.workday_only).toBe(true)
    const disabled = await api.put<Subscription>(path, {
      trigger_config: { ...cron, workday_only: false },
    })
    expect(disabled.status, JSON.stringify(disabled.data)).toBe(200)
    expect(disabled.data?.trigger_config.workday_only).toBe(false)
    const reread = await api.get<Subscription>(path)
    expect(reread.status).toBe(200)
    expect(reread.data?.trigger_config.workday_only).toBe(false)

    const legacy = await api.post<Subscription>('/api/subscriptions', {
      ...payload,
      display_name: `${testPrefix}-legacy`,
      trigger_config: cron,
    })
    expect(legacy.status, JSON.stringify(legacy.data)).toBe(201)
    subscriptionIds.push(legacy.data!.id)
    expect(legacy.data?.trigger_config.workday_only).toBe(false)
  } finally {
    for (const id of subscriptionIds) {
      const deleted = await api.delete(`/api/subscriptions/${id}`)
      expect.soft(deleted.status, JSON.stringify(deleted.data)).toBe(204)
    }
    if (teamId) {
      const deleted = await api.delete(
        `/api/teams/${teamId}?force=true&confirm_name=${encodeURIComponent(teamName)}`
      )
      expect.soft(deleted.status, JSON.stringify(deleted.data)).toBe(200)
    }
    if (botId) {
      const deleted = await api.delete(`/api/bots/${botId}`)
      expect.soft(deleted.status, JSON.stringify(deleted.data)).toBe(200)
      const modelDeleted = await api.delete(`/api/v1/namespaces/default/models/${botName}-model`)
      expect.soft(modelDeleted.status, JSON.stringify(modelDeleted.data)).toBe(200)
    }
  }
})
