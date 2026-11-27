// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { REGULAR_USER } from '../config/test-users'
import { DataBuilders } from '../fixtures/data-builders'
import { createApiClient } from '../utils/api-client'
import {
  findCreatedTeam,
  openQuickCreateDialog,
  openUserPage,
  readGroupBindings,
  readTeamDetail,
} from '../utils/group-agent-editor'

test('revalidates default knowledge bindings when the Agent source team changes', async ({
  browser,
  request,
}) => {
  const api = createApiClient(request)
  const login = await api.login(REGULAR_USER.username, REGULAR_USER.password, 1)
  expect(login.status).toBe(200)
  const page = await openUserPage(browser, login.data!.access_token)
  const prefix = `e2e-agent-knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const agentName = `${prefix} Agent`
  const groups: string[] = []
  const libraryIds: number[] = []
  let submitted = false

  const createLibrary = async (label: string) => {
    const group = DataBuilders.group({ display_name: `${prefix} ${label}` })
    const createdGroup = await api.createGroup(group)
    expect(createdGroup.status, JSON.stringify(createdGroup.data)).toBe(201)
    groups.push(group.name)
    const library = await api.post<{ id: number; name: string }>('/api/knowledge-bases', {
      namespace: group.name,
      name: `${prefix} ${label} Library`,
      kb_type: 'classic',
      rag_config_mode: 'disabled',
      summary_enabled: false,
    })
    expect([200, 201], JSON.stringify(library.data)).toContain(library.status)
    libraryIds.push(library.data!.id)
    return { ...library.data!, group: group.name }
  }

  try {
    const libraryA = await createLibrary('Team A')
    const libraryB = await createLibrary('Team B')
    const dialog = await openQuickCreateDialog(page)
    await dialog.getByTestId('team-display-name-input').fill(agentName)
    await dialog.getByTestId('capability-scope-team').press('Enter')
    const target = (group: string) => dialog.getByTestId(`capability-scope-group-${group}`)
    const save = dialog.getByRole('button', { name: /^(Save|保存)$/ })
    const capabilities = dialog.getByTestId('simple-additional-capabilities-toggle')
    const picker = dialog.getByTestId('default-knowledge-base-trigger')
    const option = (id: number) => page.getByTestId(`default-knowledge-base-option-${id}`)

    await target(libraryA.group).press('Space')
    await expect(target(libraryA.group)).toBeChecked()
    await capabilities.press('Enter')
    await picker.press('Enter')
    await page.getByTestId('default-knowledge-base-search-input').fill(prefix)
    await option(libraryA.id).click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('default-knowledge-base-popover')).toBeHidden()
    const chipA = dialog.getByTestId(`default-knowledge-base-chip-${libraryA.id}`)
    await expect(chipA).toBeVisible()
    await expect(save).toBeEnabled()

    await capabilities.press('Enter')
    await expect(picker).toBeHidden()
    await target(libraryB.group).press('Space')
    await expect(target(libraryB.group)).toBeChecked()
    const switched = page.waitForResponse(response => {
      const url = new URL(response.url())
      return (
        url.pathname === '/api/knowledge-bases' &&
        url.searchParams.get('binding_group') === libraryB.group &&
        url.searchParams.getAll('candidate_ids').includes(String(libraryA.id))
      )
    })
    await target(libraryA.group).press('Space')
    expect((await switched).status()).toBe(200)
    await expect(save).toBeDisabled()

    await capabilities.press('Enter')
    await expect(chipA).toContainText(/Unavailable in this scope|当前范围不可绑定/)
    await picker.press('Enter')
    await page.getByTestId('default-knowledge-base-search-input').fill(prefix)
    await expect(option(libraryB.id)).toBeVisible()
    await expect(option(libraryA.id)).toHaveCount(0)
    await option(libraryB.id).click()
    await page.keyboard.press('Escape')
    await expect(save).toBeDisabled()
    await dialog.getByTestId(`default-knowledge-base-remove-${libraryA.id}`).press('Enter')
    await expect(chipA).toHaveCount(0)
    await expect(save).toBeEnabled()
    submitted = true
    await save.press('Enter')
    await expect(dialog).toBeHidden({ timeout: 30000 })

    const team = await findCreatedTeam(api, agentName)
    expect(team).toBeDefined()
    const detail = await readTeamDetail(api, team!.id)
    expect(detail.bots[0].bot.default_knowledge_base_refs).toEqual([
      { id: libraryB.id, name: libraryB.name },
    ])
    expect(await readGroupBindings(api, team!.id)).toEqual([libraryB.group])
  } finally {
    await page.context().close()
    if (submitted) {
      const team = await findCreatedTeam(api, agentName)
      if (team) {
        const detail = await readTeamDetail(api, team.id)
        const query = new URLSearchParams({ force: 'true', confirm_name: team.name })
        expect((await api.delete(`/api/teams/${team.id}?${query}`)).status).toBe(200)
        for (const bot of detail.bots) {
          expect((await api.delete(`/api/bots/${bot.bot_id}?force=true`)).status).toBe(200)
        }
      }
    }
    for (const id of libraryIds) {
      expect([200, 204]).toContain((await api.delete(`/api/knowledge-bases/${id}`)).status)
    }
    for (const group of groups) {
      expect((await api.deleteGroup(group)).status).toBe(204)
    }
  }
})
