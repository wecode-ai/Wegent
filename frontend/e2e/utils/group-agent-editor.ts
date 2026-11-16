// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from '@playwright/test'
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

export async function assertCatalogSelectionIds(
  page: Page,
  teamId: number,
  botId: number,
  shadowed: { name: string; id: number },
  shared: { name: string; id: number },
  readSelection: () => Promise<{
    agent_config: { bind_model: string; bind_model_type: string }
  }>
): Promise<void> {
  await page.reload()
  const catalogResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith('/models/unified')
  )
  await page.getByTestId('edit-team-button-' + teamId).click()
  const response = await catalogResponse
  expect(response.status()).toBe(200)
  const catalog = (await response.json()).data
  for (const model of [shadowed, shared]) {
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: model.id, name: model.name, type: 'public' }),
      ])
    )
  }

  const dialog = page.getByTestId('team-edit-dialog')
  const original = await readSelection()
  await saveCatalogSelection(page, dialog, botId, shadowed, 403)
  await expect(dialog).toBeVisible()
  expect(await readSelection()).toEqual(original)
  await saveCatalogSelection(page, dialog, botId, shared, 200)
  await expect(dialog).toBeHidden({ timeout: 30000 })
  expect((await readSelection()).agent_config).toMatchObject({
    bind_model: shared.name,
    bind_model_type: 'public',
  })
  await page.getByTestId('edit-team-button-' + teamId).click()
  await expect(dialog.getByTestId('simple-model-select')).toHaveText(shared.name)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
}

async function saveCatalogSelection(
  page: Page,
  dialog: Locator,
  botId: number,
  model: { name: string; id: number },
  status: number
): Promise<void> {
  await dialog.getByTestId('simple-model-select').click()
  await page.getByTestId('model-cascade-search-input').fill(model.name)
  await page.getByTestId('model-option-' + model.name).click()
  const saved = page.waitForResponse(
    response =>
      new URL(response.url()).pathname.endsWith('/bots/' + botId) &&
      response.request().method() === 'PUT'
  )
  await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
  const response = await saved
  expect(response.request().postDataJSON()).toMatchObject({ model_id: model.id })
  expect(response.status(), await response.text()).toBe(status)
}
