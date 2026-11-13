// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import { test, expect, type Page, type BrowserContext, type Locator } from '@playwright/test'
import { createApiClient, type ApiClient } from '../../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'

function fixtureName(prefix: string) {
  // Keep namespace + display name within the persisted Kind.name limit (100).
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

async function selectKnowledgeTeam(page: Page, groupId: string) {
  await page.getByTestId('knowledge-team-filter').click()
  await page.getByTestId('knowledge-team-search').fill(groupId.replace(/^group-/, ''))
  await page.getByTestId('knowledge-team-option-' + groupId).click()
}

test('relationship navigation deduplicates libraries and filters by owning space instead of receiving teams', async ({
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
      const name = fixtureName('e2e-nav-team')
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
        name: fixtureName('e2e-nav-kb'),
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
    for (const [index, name] of names.slice(0, 2).entries()) {
      await selectKnowledgeTeam(page, `group-${name}`)
      await expect(page.getByTestId(`kb-row-${shared}`)).toHaveCount(0)
      await expect(page.getByTestId(`kb-row-${native}`)).toHaveCount(index === 0 ? 1 : 0)
      await expect(page.getByTestId(`kb-row-${unrelated}`)).toHaveCount(0)
      await expect(page.getByTestId('nav-personal-item')).toHaveText(count, {
        useInnerText: true,
      })
    }
    await selectKnowledgeTeam(page, `group-${names[2]}`)
    await expect(page.getByTestId(`kb-row-${shared}`)).toHaveCount(0)
    await page.getByTestId('nav-all-item').click()
    await page.getByTestId('knowledge-team-filter').click()
    await expect(page.getByTestId('knowledge-team-option-all')).toHaveAttribute(
      'data-current',
      'true'
    )
    await page.keyboard.press('Escape')
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

test('approved authorization stays read-only on mobile and desktop without approvals or writes', async ({
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
      name: fixtureName('e2e-permissions'),
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
    const memberRequests: Array<{ url: string; method: string }> = []
    page.on('request', request => {
      if (
        new RegExp('/share/KnowledgeBase/' + id + '/(members|requests)(?:[/?]|$)').test(
          new URL(request.url()).pathname
        )
      )
        memberRequests.push({ url: request.url(), method: request.method() })
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
      const mobile = width <= 767
      const trigger = row.getByTestId((mobile ? 'more-kb-' : 'permission-kb-') + id)
      const bounds = await trigger.boundingBox()
      expect(bounds!.width).toBeGreaterThanOrEqual(mobile ? 44 : 32)
      expect(bounds!.height).toBeGreaterThanOrEqual(mobile ? 44 : 32)
      const approvedRead = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === `/api/share/KnowledgeBase/${id}/members` &&
          response.request().method() === 'GET'
      )
      await trigger.click()
      if (mobile) {
        const permission = page.getByRole('menuitem').and(page.getByTestId('permission-kb-' + id))
        await expect(permission).toBeVisible()
        // Visibility does not mean the menu's entry zoom has reached its final size.
        await expect
          .poll(() =>
            page
              .getByRole('menu')
              .evaluate(element =>
                element
                  .getAnimations()
                  .every(animation => ['finished', 'idle'].includes(animation.playState))
              )
          )
          .toBe(true)
        const menuBounds = await permission.boundingBox()
        expect(menuBounds!.width).toBeGreaterThanOrEqual(44)
        expect(menuBounds!.height).toBeGreaterThanOrEqual(44)
        await permission.click()
      }
      expect((await approvedRead).status()).toBe(200)
      await expect(page.getByTestId('knowledge-permission-sources')).toBeVisible()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('collaborator-item')).toHaveCount(2)
      await expect(
        dialog
          .locator('[data-authorization-id="creator"]')
          .getByText(ADMIN_USER.username, { exact: true })
      ).toBeVisible()
      const readerObject = dialog
        .getByTestId('collaborator-item')
        .filter({ has: page.getByText(REGULAR_USER.username, { exact: true }) })
      await expect(readerObject.getByText(REGULAR_USER.username, { exact: true })).toBeVisible()
      await expect(dialog.getByTestId('permission-add-collaborator')).toHaveCount(0)
      await expect(dialog.getByTestId('knowledge-authorization-actions')).toHaveCount(0)
      await expect(dialog.locator('[data-testid^="permission-approve-"]')).toHaveCount(0)
      await expect(page.getByTestId('perm-tab-user')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
    expect(memberRequests.length).toBeGreaterThanOrEqual(3)
    expect(
      memberRequests.every(
        request => request.method === 'GET' && new URL(request.url).pathname.endsWith('/members')
      )
    ).toBe(true)
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
  await dialog.getByTestId('kb-name-input').fill(fixtureName('e2e-create-kb'))
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
    await expect(page.getByTestId('created-knowledge-authorization')).toHaveCount(0)
    await page.getByTestId('permission-add-collaborator').click()
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
    await page.getByTestId('close-add-collaborator').click()
    await expect(page.getByTestId('permission-add-collaborator')).toBeFocused()
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
    const name = fixtureName('e2e-create-team')
    creation.groups.add(name)
    expect((await creation.api.createGroup({ name, display_name: name })).status).toBe(201)
    await page.goto('/knowledge?type=document')
    await selectKnowledgeTeam(page, 'group-' + name)
    await page.getByTestId('create-kb-button').click()
    await expect(page.getByTestId('group-selector')).toBeVisible()
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
    await selectKnowledgeTeam(teammate, 'group-' + name)
    await teammate.getByTestId('create-kb-button').click()
    await expect(teammate.getByTestId('submit-create-kb')).toBeDisabled()
    await teammate.getByTestId('create-in-personal-space').click()
    expect((await createLibraryInDialog(teammate, creation, recipient)).namespace).toBe('default')
    await teammate.getByTestId('finish-created-authorization').click()
  }
)

creationTest(
  'uses the same collaborator flow from the list and document management',
  async ({ page, creation }) => {
    const name = fixtureName('e2e-collaborators')
    const created = await creation.api.post<{ id: number }>('/api/knowledge-bases', {
      name,
      namespace: 'default',
      kb_type: 'classic',
      summary_enabled: false,
    })
    if (created.data?.id) creation.libraries.set(created.data.id, creation.api)
    expect(created.status).toBe(201)
    const id = created.data!.id
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/knowledge?type=document')
    await page.getByTestId('permission-kb-' + id).click()
    await page.getByTestId('permission-add-collaborator').click()
    await page.getByTestId('knowledge-auth-user-search').fill(REGULAR_USER.username)
    await page.getByText(REGULAR_USER.username, { exact: true }).click()
    const pending = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === `/api/share/KnowledgeBase/${id}/members/batch` &&
        response.request().method() === 'POST'
    )
    await page.getByTestId('submit-created-permissions').click()
    const response = await pending
    expect(response.status()).toBe(200)
    expect(((await response.json()) as { failed: unknown[] }).failed).toEqual([])
    await expect(page.getByTestId('knowledge-authorization-complete')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('permission-add-collaborator')).toBeFocused()
    await page.getByTestId('knowledge-member-search').fill(REGULAR_USER.username)
    await expect(page.getByTestId('knowledge-member-count')).toContainText('1')
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 375, height: 480 })
    await page.goto(`/knowledge/default/${encodeURIComponent(name)}?type=document&view=documents`)
    const permissionTrigger = page.getByTestId('knowledge-detail-permissions-tab')
    const documentAction = page.getByTestId('upload-documents-button')
    await expect(documentAction).toBeVisible()
    const mountedDocumentAction = await documentAction.elementHandle()
    await permissionTrigger.click()
    expect(await mountedDocumentAction!.evaluate(element => element.isConnected)).toBe(true)
    await page.getByTestId('knowledge-member-search').fill(REGULAR_USER.username)
    const detail = page.getByTestId('knowledge-detail-classic')
    await expect
      .poll(() =>
        detail.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)
      )
      .toBe(true)
    await expect
      .poll(() => page.evaluate(() => document.body.scrollHeight <= window.innerHeight))
      .toBe(true)
    await expect(page.getByTestId('knowledge-member-count')).toContainText('1')
    await page.getByTestId('permission-add-collaborator').click()
    await expect(page.getByTestId('knowledge-auth-user-search')).toBeVisible()
    await page.getByTestId('submit-created-permissions').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('submit-created-permissions')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('permission-add-collaborator')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(permissionTrigger).toBeFocused()
    expect(await mountedDocumentAction!.evaluate(element => element.isConnected)).toBe(true)
  }
)

async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      control.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return (
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight &&
          !!hit &&
          element.contains(hit)
        )
      })
    )
    .toBe(true)
  await control.click({ trial: true })
}

async function expectResultsBefore(results: Locator, following: Locator) {
  // Visibility alone passes for clipped or overlapping absolute-positioned lists.
  await expect(results).toBeVisible()
  await expect
    .poll(async () => {
      const list = await results.boundingBox()
      const next = await following.boundingBox()
      return !!list && !!next && list.y + list.height <= next.y
    })
    .toBe(true)
}

async function expectResultsClearOfFooter(results: Locator, footer: Locator) {
  await expect
    .poll(async () => {
      const visibleBottom = await results.evaluate(element => {
        let bottom = element.getBoundingClientRect().bottom
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowY)) {
            bottom = Math.min(bottom, parent.getBoundingClientRect().bottom)
          }
        }
        return bottom
      })
      const action = await footer.boundingBox()
      return !!action && visibleBottom <= action.y
    })
    .toBe(true)
}

creationTest(
  'keeps expanded grant results and actions reachable at every supported dialog size',
  async ({ page, creation }) => {
    const prefix = fixtureName('e2e-grant-layout')
    const groupIds: number[] = []
    for (let index = 0; index < 8; index++) {
      const name = `${prefix}-${index}`
      creation.groups.add(name)
      const group = await creation.api.post<{ id: number }>('/api/groups', {
        name,
        display_name: name,
      })
      expect(group.status).toBe(201)
      groupIds.push(group.data!.id)
    }
    await page.goto('/knowledge?type=document')
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
      { width: 320, height: 568 },
      { width: 375, height: 480 },
    ]) {
      await page.setViewportSize(viewport)
      await page.getByTestId('create-kb-button').click()
      const library = await createLibraryInDialog(page, creation)
      for (const entry of ['created', 'management']) {
        if (entry === 'management') {
          await page.getByTestId('finish-created-authorization').click()
          if (viewport.width < 768) await page.getByTestId(`more-kb-${library.id}`).click()
          await page.getByTestId(`permission-kb-${library.id}`).click()
        }
        await page.getByTestId('permission-add-collaborator').click()
        const search = page.getByTestId('knowledge-auth-user-search')
        await search.fill(REGULAR_USER.username)
        const person = page.getByRole('button', { name: REGULAR_USER.username, exact: false })
        const userResults = person.locator('..')
        await expectResultsBefore(userResults, page.getByTestId('add-namespace-group-search'))
        await expectReachable(page.getByTestId('auth-role-user'))
        await person.click()
        await expect(search).toHaveValue(REGULAR_USER.username)
        const groupSearch = page.getByTestId('add-namespace-group-search')
        await groupSearch.fill(prefix)
        const first = page.getByTestId(`auth-select-namespace-${groupIds[0]}`)
        const last = page.getByTestId(`auth-select-namespace-${groupIds[7]}`)
        const results = first.locator('..')
        await expect(first).toBeVisible()
        await first.scrollIntoViewIfNeeded()
        await expectResultsClearOfFooter(results, page.getByTestId('submit-created-permissions'))
        expect(await results.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(
          true
        )
        await expectReachable(last)
        await last.click()
        await expect(groupSearch).toHaveValue(prefix)
        await expect(last).toBeDisabled()
        await expectReachable(first)
        await first.click()
        await expect(page.getByTestId(`remove-auth-namespace-${groupIds[0]}`)).toBeVisible()
        await expectReachable(page.getByTestId('auth-role-namespace'))
        await page.getByTestId('auth-role-namespace').click()
        await page.getByRole('option', { name: /Developer|开发者/ }).click()
        // Reopen the results before checking footer hit targets.
        await groupSearch.click()
        await expectReachable(page.getByTestId('submit-created-permissions'))
        await expectReachable(page.getByTestId('cancel-created-permissions'))
        await expectReachable(page.getByTestId('close-add-collaborator'))
        await page.getByTestId('cancel-created-permissions').click()
        await expect(page.getByTestId('permission-add-collaborator')).toBeFocused()
        await page.getByTestId('permission-add-collaborator').click()
        await page.getByTestId('close-add-collaborator').click()
        await expect(page.getByTestId('permission-add-collaborator')).toBeFocused()
      }
      await page.getByTestId('close-knowledge-access').click()
      await expect(page.getByTestId('close-knowledge-access')).toBeHidden()
      await expect(page.getByTestId('create-kb-button')).toBeEnabled()
      await page.getByTestId('create-kb-button').click({ trial: true })
    }
  }
)

creationTest(
  'submits on the first click while inline search results stay expanded',
  async ({ page, creation }) => {
    const name = fixtureName('e2e-grant-click')
    creation.groups.add(name)
    const group = await creation.api.post<{ id: number }>('/api/groups', {
      name,
      display_name: name,
    })
    expect(group.status).toBe(201)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/knowledge?type=document')
    await page.getByTestId('create-kb-button').click()
    const library = await createLibraryInDialog(page, creation)
    await page.getByTestId('permission-add-collaborator').click()
    await page.getByTestId('knowledge-auth-user-search').fill(REGULAR_USER.username)
    await page.getByRole('button', { name: REGULAR_USER.username, exact: false }).click()
    await page.getByTestId('add-namespace-group-search').fill(name)
    await page.getByTestId(`auth-select-namespace-${group.data!.id}`).click()
    await expect(page.getByTestId('knowledge-auth-user-search-results')).toBeVisible()
    await expect(page.getByTestId('knowledge-auth-namespace-results')).toBeVisible()
    const pending = page.waitForResponse(
      response =>
        new URL(response.url()).pathname ===
          `/api/share/KnowledgeBase/${library.id}/members/batch` &&
        response.request().method() === 'POST'
    )
    // A mousedown that collapses inline results can move the action before mouseup.
    await page.getByTestId('submit-created-permissions').click()
    const response = await pending
    expect(response.status()).toBe(200)
    expect(((await response.json()) as { failed: unknown[] }).failed).toEqual([])
    await expect(page.getByTestId('knowledge-authorization-complete')).toBeVisible()
  }
)

creationTest(
  'refreshes creation locations after managing a team without losing the draft',
  async ({ page, creation }) => {
    await page.goto('/knowledge?type=document')
    await page.getByTestId('create-kb-button').click()
    const dialog = page.getByTestId('create-kb-dialog')
    const draftName = fixtureName('e2e-return-draft')
    await dialog.getByTestId('kb-name-input').fill(draftName)
    await dialog.getByTestId('group-selector').click()
    const popup = page.waitForEvent('popup')
    await page.getByTestId('create-manage-organizations').click()
    const management = await popup
    await expect(management).toHaveURL(/settings\?tab=group-manager/)
    const name = fixtureName('e2e-return-team')
    creation.groups.add(name)
    expect((await creation.api.post('/api/groups', { name, display_name: name })).status).toBe(201)
    const refreshed = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/groups' && response.request().method() === 'GET'
    )
    await management.close()
    await page.bringToFront()
    // Headless popup closure does not guarantee a window focus event. Reopening
    // locations is also a real return interaction that must refresh permissions.
    await dialog.getByTestId('group-selector').click()
    await refreshed
    await expect(dialog.getByTestId('kb-name-input')).toHaveValue(draftName)
    await page.getByTestId('create-space-search').fill(name)
    await page.getByTestId('create-space-option-group-' + name).click()
    await expect(dialog.getByTestId('submit-create-kb')).toBeEnabled()
    expect((await createLibraryInDialog(page, creation)).namespace).toBe(name)
  }
)
