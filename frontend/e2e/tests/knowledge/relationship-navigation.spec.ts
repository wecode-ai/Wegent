// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createApiClient, type ApiClient } from '../../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'

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

test('read-only permissions stay scoped on mobile and desktop without exposing members', async ({
  browser,
  request,
  baseURL,
}) => {
  const owner = createApiClient(request)
  expect((await owner.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
  const reader = createApiClient(request)
  const login = await reader.login(REGULAR_USER.username, REGULAR_USER.password, 1)
  expect(login.status).toBe(200)
  const identity = await reader.get<{ id: number }>('/api/users/me')
  expect(identity.status).toBe(200)
  let id: number | undefined
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const created = await owner.post<{ id: number }>('/api/knowledge-bases', {
      name: 'e2e-mobile-permissions-' + randomUUID(),
      namespace: 'default',
      summary_enabled: false,
      direct_access_requirement: 'read',
    })
    id = created.data?.id
    expect(created.status).toBe(201)
    expect(id).toBeGreaterThan(0)
    const grant = await owner.post('/api/share/KnowledgeBase/' + id + '/members', {
      user_id: identity.data!.id,
      role: 'Reporter',
    })
    expect(grant.status).toBe(200)
    context = await browser.newContext({
      baseURL,
      storageState: buildStorageState(
        baseURL!,
        login.data!.access_token,
        getJwtExpiryMs(login.data!.access_token)
      ),
    })
    const page = await context.newPage()
    const memberRequests: string[] = []
    page.on('request', request => {
      if (
        new RegExp('/share/KnowledgeBase/' + id + '/(members|requests)(?:[/?]|$)').test(
          new URL(request.url()).pathname
        )
      )
        memberRequests.push(request.url())
    })
    for (const width of [375, 767, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/knowledge?type=document&group=shared')
      const row = page.getByTestId('kb-row-' + id)
      await expect(row).toBeVisible()
      if (width <= 767) {
        await expect(page.getByTestId('knowledge-mobile-list')).toBeVisible()
        await expect(row.getByTestId('open-kb-' + id)).toBeVisible()
      }
      const trigger = row.getByTestId('permission-kb-' + id)
      const bounds = await trigger.boundingBox()
      expect(bounds!.width).toBeGreaterThanOrEqual(44)
      expect(bounds!.height).toBeGreaterThanOrEqual(44)
      await trigger.click()
      await expect(page.getByTestId('knowledge-permission-sources')).toBeVisible()
      await expect(page.getByTestId('perm-tab-user')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
    expect(memberRequests).toEqual([])
  } finally {
    const errors: unknown[] = []
    if (context) {
      try {
        await context.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (id) {
      try {
        expect((await owner.delete('/api/knowledge-bases/' + id)).status).toBe(204)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Permission scenario cleanup failed')
  }
})

interface CreationSession {
  api: ApiClient
  libraries: Map<number, ApiClient>
  groups: Set<string>
  contexts: Set<BrowserContext>
}
const creationTest = test.extend<{ creation: CreationSession }>({
  creation: async ({ request, page, baseURL }, use) => {
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
    const creation: CreationSession = {
      api,
      libraries: new Map(),
      groups: new Set(),
      contexts: new Set(),
    }
    try {
      await use(creation)
    } finally {
      const errors: unknown[] = []
      for (const context of creation.contexts) {
        try {
          await context.close()
        } catch (error) {
          errors.push(error)
        }
      }
      for (const [id, owner] of creation.libraries) {
        try {
          expect((await owner.delete('/api/knowledge-bases/' + id)).status).toBe(204)
        } catch (error) {
          errors.push(error)
        }
      }
      for (const name of creation.groups) {
        try {
          expect([204, 404]).toContain((await api.deleteGroup(name)).status)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Creation scenario cleanup failed')
    }
  },
})

async function createLibraryInDialog(page: Page, creation: CreationSession, owner = creation.api) {
  const dialog = page.getByTestId('create-kb-dialog')
  await dialog.getByTestId('kb-name-input').fill('e2e-created-knowledge-' + randomUUID())
  const summarySection = dialog.getByTestId('knowledge-summary-section-trigger')
  if ((await summarySection.getAttribute('aria-expanded')) === 'false') await summarySection.click()
  const summary = dialog.locator('#knowledge-summary-enabled')
  if ((await summary.getAttribute('aria-checked')) === 'true') await summary.click()
  await expect(summary).toHaveAttribute('aria-checked', 'false')
  const pending = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/api/knowledge-bases' &&
      response.request().method() === 'POST'
  )
  await dialog.getByTestId('submit-create-kb').click()
  const response = await pending
  const body = (await response.json()) as { id: number; namespace: string }
  if (Number.isSafeInteger(body.id) && body.id > 0) creation.libraries.set(body.id, owner)
  expect(response.status()).toBe(201)
  return body
}

creationTest(
  'creates once, grants a colleague, and finds the same library in relationship navigation',
  async ({ page, request, browser, baseURL, creation }) => {
    await page.goto('/knowledge?type=document')
    await page.getByTestId('create-kb-button').click()
    const library = await createLibraryInDialog(page, creation)
    const authorization = page.getByTestId('created-knowledge-authorization')
    await authorization.getByTestId('knowledge-auth-user-search').fill(REGULAR_USER.username)
    await authorization.getByText(REGULAR_USER.username, { exact: true }).click()
    const pending = page.waitForResponse(
      response =>
        new URL(response.url()).pathname ===
          `/api/share/KnowledgeBase/${library.id}/members/batch` &&
        response.request().method() === 'POST'
    )
    await authorization.getByTestId('submit-created-permissions').click()
    const granted = await pending
    expect(granted.status()).toBe(200)
    expect(((await granted.json()) as { failed: unknown[] }).failed).toEqual([])
    await expect(page.getByTestId('knowledge-authorization-complete')).toBeVisible()
    await page.getByTestId('finish-created-authorization').click()
    await expect(page.getByTestId('create-kb-button')).toBeFocused()
    await page.getByTestId('nav-personal-item').click()
    await expect(page.getByTestId('kb-row-' + library.id)).toHaveCount(1)
    const recipient = createApiClient(request)
    const login = await recipient.login(REGULAR_USER.username, REGULAR_USER.password, 1)
    expect(login.status).toBe(200)
    const context = await browser.newContext({
      baseURL,
      storageState: buildStorageState(
        baseURL!,
        login.data!.access_token,
        getJwtExpiryMs(login.data!.access_token)
      ),
    })
    creation.contexts.add(context)
    const colleague = await context.newPage()
    await colleague.goto('/knowledge?type=document&group=shared')
    await expect(colleague.getByTestId('kb-row-' + library.id)).toHaveCount(1)
  }
)

creationTest(
  'defaults to an authorized team and requires an explicit personal choice for a read-only teammate',
  async ({ page, request, browser, baseURL, creation }) => {
    const name = 'e2e-team-create-' + randomUUID()
    creation.groups.add(name)
    expect((await creation.api.createGroup({ name, display_name: name })).status).toBe(201)
    await page.goto('/knowledge?type=document')
    await page.getByTestId('knowledge-team-filter').selectOption('group-' + name)
    await page.getByTestId('create-kb-button').click()
    await expect(page.getByTestId('create-space-settings')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('group-selector')).toContainText(name)
    expect((await createLibraryInDialog(page, creation)).namespace).toBe(name)
    await page.getByTestId('finish-created-authorization').click()
    const recipient = createApiClient(request)
    const login = await recipient.login(REGULAR_USER.username, REGULAR_USER.password, 1)
    expect(login.status).toBe(200)
    const identity = await recipient.get<{ id: number }>('/api/users/me')
    expect(identity.status).toBe(200)
    expect(
      (await creation.api.addGroupMember(name, { user_id: identity.data!.id, role: 'Reporter' }))
        .status
    ).toBe(201)
    const context = await browser.newContext({
      baseURL,
      storageState: buildStorageState(
        baseURL!,
        login.data!.access_token,
        getJwtExpiryMs(login.data!.access_token)
      ),
    })
    creation.contexts.add(context)
    const teammate = await context.newPage()
    await teammate.goto('/knowledge?type=document')
    await teammate.getByTestId('knowledge-team-filter').selectOption('group-' + name)
    await teammate.getByTestId('create-kb-button').click()
    await expect(teammate.getByTestId('submit-create-kb')).toBeDisabled()
    await teammate.getByTestId('create-in-personal-space').click()
    expect((await createLibraryInDialog(teammate, creation, recipient)).namespace).toBe('default')
    await teammate.getByTestId('finish-created-authorization').click()
  }
)
