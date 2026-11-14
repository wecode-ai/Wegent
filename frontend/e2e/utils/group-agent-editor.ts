// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from '@playwright/test'
import type { Bot, Team } from '../../src/types/api'
import type { ApiClient } from './api-client'

type TeamDetail = Omit<Team, 'bots'> & {
  bots: Array<{ bot_id: number; role?: string; bot: Bot & { user_id: number } }>
}

export async function readTeamDetail(api: ApiClient, teamId: number): Promise<TeamDetail> {
  const response = await api.get<TeamDetail>(`/api/teams/${teamId}`)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return response.data!
}

export async function assertLeaderReloadOnReopen(
  page: Page,
  creator: ApiClient,
  teamId: number,
  botId: number
): Promise<void> {
  const dialog = page.getByTestId('team-edit-dialog')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const prompt = 'The creator changed this private Bot while the group editor was closed.'
  const saved = await creator.put(`/api/bots/${botId}`, { system_prompt: prompt })
  expect(saved.status, JSON.stringify(saved.data)).toBe(200)

  await page.getByTestId(`edit-team-button-${teamId}`).click()
  await expect(dialog.getByTestId('simple-prompt-textarea')).toHaveValue(prompt)
}
