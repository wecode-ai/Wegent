// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { createApiClient } from '../../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { ADMIN_USER } from '../../config/test-users'

test('relationship navigation deduplicates libraries and filters every receiving team', async ({
  page,
  request,
  baseURL,
}) => {
  const api = createApiClient(request)
  const login = await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)
  expect(login.status).toBe(200)
  const state = buildStorageState(
    baseURL!,
    login.data!.access_token,
    getJwtExpiryMs(login.data!.access_token)
  )
  await page.context().addCookies(state.cookies)
  await page.addInitScript(({ origin, localStorage: entries }) => {
    if (location.origin === origin)
      entries.forEach(entry => localStorage.setItem(entry.name, entry.value))
  }, state.origins[0])
  const libraries = new Set<number>()
  const teams = new Set<string>()
  try {
    const groupIds: number[] = []
    const names: string[] = []
    for (let index = 0; index < 3; index++) {
      const name = `e2e-knowledge-navigation-${randomUUID()}`
      teams.add(name)
      names.push(name)
      const created = await api.post<{ id: number }>('/api/groups', {
        name,
        display_name: 'Navigation team',
      })
      expect(created.status).toBe(201)
      groupIds.push(created.data!.id)
    }
    const createLibrary = async (namespace: string) => {
      const created = await api.post<{ id: number }>('/api/knowledge-bases', {
        name: `e2e-navigation-${randomUUID()}`,
        namespace,
        summary_enabled: false,
      })
      if (created.data?.id) libraries.add(created.data.id)
      expect(created.status).toBe(201)
      return created.data!.id
    }
    const shared = await createLibrary('default')
    const native = await createLibrary(names[0])
    const unrelated = await createLibrary('default')
    const granted = await api.post<{ failed: unknown[] }>(
      '/api/share/KnowledgeBase/' + shared + '/members/batch',
      {
        members: groupIds.slice(0, 2).map(id => ({
          user_id: 0,
          role: 'Reporter',
          entity_type: 'namespace',
          entity_id: String(id),
        })),
      }
    )
    expect(granted.status).toBe(200)
    expect(granted.data!.failed).toEqual([])
    await page.goto('/knowledge?type=document')
    await page.getByTestId('nav-personal-item').click()
    await expect(page.getByTestId('nav-personal-item')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId(`kb-row-${shared}`)).toHaveCount(1)
    await expect(page.getByTestId(`kb-row-${native}`)).toHaveCount(1)
    await expect(page.getByTestId(`kb-row-${unrelated}`)).toHaveCount(1)
    const count = await page.getByTestId('nav-personal-item').innerText()
    for (const name of names.slice(0, 2)) {
      await page.getByTestId('knowledge-team-filter').selectOption(`group-${name}`)
      await expect(page.getByTestId(`kb-row-${shared}`)).toHaveCount(1)
      await expect(page.getByTestId(`kb-row-${shared}`)).not.toContainText(name)
      await expect(page.getByTestId(`kb-row-${unrelated}`)).toHaveCount(0)
      await expect(page.getByTestId('nav-personal-item')).toHaveText(count)
    }
    await page.getByTestId('knowledge-team-filter').selectOption(`group-${names[2]}`)
    await expect(page.getByTestId(`kb-row-${shared}`)).toHaveCount(0)
    await page.getByTestId('nav-all-item').click()
    await expect(page.getByTestId('knowledge-team-filter')).toHaveValue('')
    await expect(page.getByTestId(`kb-row-${shared}`)).toHaveCount(1)
  } finally {
    // Attempt every cleanup even if a preceding resource fails.
    const errors: unknown[] = []
    for (const id of libraries) {
      try {
        expect((await api.delete(`/api/knowledge-bases/${id}`)).status).toBe(204)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const name of teams) {
      try {
        expect([204, 404]).toContain((await api.deleteGroup(name)).status)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Knowledge navigation cleanup failed')
  }
})
