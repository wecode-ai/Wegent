// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'
import { ApiClient, createApiClient } from '../utils/api-client'
import { DataBuilders } from '../fixtures/data-builders'

const APP_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'

interface TeamRecord {
  id: number
  name: string
  namespace: string
}

interface ShareScopeFixture {
  groupName: string
  groupTeamId: number
  groupTeamBotId: number
  reporterTeamId: number
  reporterUserId: number
  developerApi: ApiClient
  reporterApi: ApiClient
  reporterToken: string
  cleanup: () => Promise<void>
}

async function findUserId(api: ApiClient, userName: string): Promise<number> {
  const query = new URLSearchParams({
    page: '1',
    limit: '100',
    search: userName,
    include_inactive: 'true',
  })
  const response = await api.get<{ items: Array<{ id: number; user_name: string }> }>(
    `/api/admin/users?${query}`
  )
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  const user = response.data?.items.find(item => item.user_name === userName)
  expect(user, `E2E user ${userName} must exist`).toBeDefined()
  return user!.id
}

async function createGroupTeam(
  api: ApiClient,
  prefix: string,
  namespace: string,
  suffix: string
): Promise<{ teamId: number; teamName: string; botId: number }> {
  const botResponse = await api.createBot({
    name: `${prefix}-${suffix}-bot`,
    shell_name: 'Chat',
    agent_config: {},
    system_prompt: 'Share scope E2E leader bot.',
    namespace,
    is_active: true,
  })
  expect(botResponse.status, JSON.stringify(botResponse.data)).toBe(201)
  const botId = (botResponse.data as { id: number }).id

  const teamName = `${prefix}-${suffix}-agent`
  const teamResponse = await api.createTeam({
    name: teamName,
    description: 'Share scope E2E agent',
    bots: [{ bot_id: botId, bot_prompt: 'Share scope E2E leader prompt.', role: 'leader' }],
    bind_mode: ['chat'],
    namespace,
    is_active: true,
    requires_workspace: false,
    workflow: { mode: 'solo' },
  })
  expect(teamResponse.status, JSON.stringify(teamResponse.data)).toBe(201)
  return { teamId: (teamResponse.data as TeamRecord).id, teamName, botId }
}

async function createShareScopeFixture(
  request: APIRequestContext,
  prefix: string
): Promise<ShareScopeFixture> {
  const adminApi = createApiClient(request)
  const adminLogin = await adminApi.login(ADMIN_USER.username, ADMIN_USER.password, 1)
  expect(adminLogin.status, JSON.stringify(adminLogin.data)).toBe(200)

  const groupData = DataBuilders.group()
  const groupResponse = await adminApi.createGroup(groupData)
  expect(groupResponse.status, JSON.stringify(groupResponse.data)).toBe(201)
  const groupName = groupData.name

  const developerApi = createApiClient(request)
  const developerLogin = await developerApi.login(REGULAR_USER.username, REGULAR_USER.password, 1)
  expect(developerLogin.status, JSON.stringify(developerLogin.data)).toBe(200)

  const reporterData = DataBuilders.user('user')
  const reporterpassword = reporterData.password
  const reporterCreate = await adminApi.adminCreateUser(reporterData)
  expect([200, 201], JSON.stringify(reporterCreate.data)).toContain(reporterCreate.status)
  const reporterUserId = await findUserId(adminApi, reporterData.user_name)

  const reporterApi = createApiClient(request)
  const reporterLogin = await reporterApi.login(reporterData.user_name, reporterpassword, 1)
  expect(reporterLogin.status, JSON.stringify(reporterLogin.data)).toBe(200)

  const createdBotIds: number[] = []
  const createdTeamIds: Array<{ id: number; namespace: string; name: string }> = []

  const cleanup = async () => {
    for (const team of createdTeamIds) {
      const response = await adminApi
        .delete(
          `/api/teams/${team.id}?${new URLSearchParams({
            force: 'true',
            confirm_name: team.name,
          })}`
        )
        .catch(() => undefined)
      console.log(`E2E cleanup team ${team.id}: ${response?.status ?? 'request failed'}`)
    }
    for (const botId of createdBotIds) {
      const response = await adminApi.delete(`/api/bots/${botId}?force=true`).catch(() => undefined)
      console.log(`E2E cleanup bot ${botId}: ${response?.status ?? 'request failed'}`)
    }
    const groupResponse = await adminApi.deleteGroup(groupName).catch(() => undefined)
    console.log(`E2E cleanup group ${groupName}: ${groupResponse?.status ?? 'request failed'}`)
    const userResponse = await adminApi.adminDeleteUser(reporterUserId).catch(() => undefined)
    console.log(`E2E cleanup user ${reporterUserId}: ${userResponse?.status ?? 'request failed'}`)
  }

  try {
    const developerId = await findUserId(adminApi, REGULAR_USER.username)
    const developerMember = await adminApi.addGroupMember(groupName, {
      user_id: developerId,
      role: 'Developer',
    })
    expect([200, 201], JSON.stringify(developerMember.data)).toContain(developerMember.status)

    const reporterMember = await adminApi.addGroupMember(groupName, {
      user_id: reporterUserId,
      role: 'Reporter',
    })
    expect([200, 201], JSON.stringify(reporterMember.data)).toContain(reporterMember.status)

    const groupTeam = await createGroupTeam(adminApi, prefix, groupName, 'group')
    createdBotIds.push(groupTeam.botId)
    createdTeamIds.push({
      id: groupTeam.teamId,
      namespace: groupName,
      name: groupTeam.teamName,
    })

    // The reporter owns this personal agent, so only the group list decides
    // which team targets they may pick.
    const reporterTeam = await createGroupTeam(reporterApi, prefix, 'default', 'reporter')
    createdBotIds.push(reporterTeam.botId)
    createdTeamIds.push({
      id: reporterTeam.teamId,
      namespace: 'default',
      name: reporterTeam.teamName,
    })

    return {
      groupName,
      groupTeamId: groupTeam.teamId,
      groupTeamBotId: groupTeam.botId,
      reporterTeamId: reporterTeam.teamId,
      reporterUserId,
      developerApi,
      reporterApi,
      reporterToken: reporterLogin.data!.access_token,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function readLeaderBotPrompt(api: ApiClient, botId: number): Promise<string | undefined> {
  const response = await api.get<{ system_prompt?: string }>(`/api/bots/${botId}`)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return response.data?.system_prompt
}

async function openUserPage(browser: Browser, token: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: APP_BASE_URL,
    storageState: buildStorageState(APP_BASE_URL, token, getJwtExpiryMs(token)),
    viewport: { width: 1280, height: 720 },
  })
  // Permission tests start after onboarding, which otherwise takes keyboard focus.
  await context.addInitScript(() => {
    localStorage.setItem('user_onboarding_completed', 'true')
  })
  return context.newPage()
}

async function recordQuickCreateActivation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: unknown[] = []
    const elementIds = new WeakMap<Element, number>()
    let nextElementId = 0
    Reflect.set(window, '__wegentQuickCreateActivation', events)
    const describe = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      if (!elementIds.has(target)) elementIds.set(target, ++nextElementId)
      return {
        elementId: elementIds.get(target),
        tag: target.tagName,
        testId: target.closest('[data-testid]')?.getAttribute('data-testid'),
        connected: target.isConnected,
      }
    }
    for (const type of ['focusin', 'focusout', 'keydown', 'keyup', 'click']) {
      for (const capture of [true, false]) {
        document.addEventListener(
          type,
          event => {
            const key = event instanceof KeyboardEvent ? event.key : undefined
            if (key && !['Enter', ' ', 'Tab', 'Escape'].includes(key)) return
            events.push({
              time: performance.now(),
              type,
              capture,
              key,
              prevented: event.defaultPrevented,
              documentFocused: document.hasFocus(),
              target: describe(event.target),
              active: describe(document.activeElement),
              trigger: describe(document.querySelector('[data-testid="quick-create-agent"]')),
              stack: type === 'focusin' ? new Error().stack : undefined,
            })
            if (events.length > 100) events.shift()
          },
          capture
        )
      }
    }
  })
}

// The quick create dialog is the chat entry that renders the agent editor
// without preloading any writable group list.
async function openQuickCreateDialog(page: Page): Promise<Locator> {
  await recordQuickCreateActivation(page)
  await page.goto('/chat', { waitUntil: 'domcontentloaded' })
  const trigger = page.getByTestId('quick-create-agent').first()
  await expect(trigger).toBeVisible({ timeout: 30000 })
  // The card animates continuously, so pointer clicks never settle; the native
  // button is keyboard activatable.
  await trigger.focus()
  await trigger.press('Enter')
  const dialog = page.getByTestId('team-edit-dialog')
  try {
    await expect(dialog).toBeVisible({ timeout: 15000 })
  } finally {
    const events = await page.evaluate(() => Reflect.get(window, '__wegentQuickCreateActivation'))
    await test.info().attach('quick-create-activation', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    })
  }
  return dialog
}

// Agents created from the chat entry are personal resources; the selected team
// target only adds a group binding.
async function findCreatedTeam(api: ApiClient, displayName: string) {
  const response = await api.get<{
    items: Array<{ id: number; name: string; displayName?: string; namespace: string }>
  }>(`/api/teams?${new URLSearchParams({ scope: 'personal' })}`)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return (response.data?.items ?? []).find(
    team => team.displayName === displayName || team.name === displayName
  )
}

async function readGroupBindings(api: ApiClient, teamId: number): Promise<string[]> {
  const response = await api.get<{ group_names: string[] }>(
    `/api/resource-library/agents/${teamId}/bindings`
  )
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return response.data?.group_names ?? []
}

async function openPersonalAgentEditor(page: Page, teamId: number): Promise<Locator> {
  await page.goto('/resource-library?tab=mine&type=agent&source=mine')
  await expect(page.getByTestId('my-resources')).toBeVisible({ timeout: 20000 })
  const card = page.getByTestId(`team-card-${teamId}`)
  await expect(card).toBeVisible({ timeout: 20000 })
  await card.getByTestId(`edit-team-button-${teamId}`).click()
  const dialog = page.getByTestId('team-edit-dialog')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  return dialog
}

test.describe('Agent share scope', () => {
  test('developer can pick a group from the chat create dialog and the binding is kept', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-share-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createShareScopeFixture(request, prefix)
    const login = await fixture.developerApi.login(REGULAR_USER.username, REGULAR_USER.password, 1)
    const page = await openUserPage(browser, login.data!.access_token)
    const agentDisplayName = `${prefix} developer agent`

    try {
      const dialog = await openQuickCreateDialog(page)
      await dialog.getByTestId('team-display-name-input').fill(agentDisplayName)
      // The dialog scroll container keeps re-laying out, so pointer clicks never
      // settle; the native controls are keyboard activatable.
      await dialog.getByTestId('capability-scope-team').focus()
      await dialog.getByTestId('capability-scope-team').press('Enter')

      const groupOption = dialog.getByTestId(`capability-scope-group-${fixture.groupName}`)
      await expect(groupOption).toBeVisible({ timeout: 15000 })
      await groupOption.focus()
      await groupOption.press('Space')
      await dialog.getByRole('button', { name: /^(Save|保存)$/ }).focus()
      await dialog.getByRole('button', { name: /^(Save|保存)$/ }).press('Enter')
      await expect(dialog).toBeHidden({ timeout: 30000 })

      let createdTeamId: number | undefined
      await expect
        .poll(
          async () => {
            const created = await findCreatedTeam(fixture.developerApi, agentDisplayName)
            createdTeamId = created?.id
            return Boolean(created)
          },
          { timeout: 30000 }
        )
        .toBe(true)

      await expect
        .poll(() => readGroupBindings(fixture.developerApi, createdTeamId!), { timeout: 20000 })
        .toContain(fixture.groupName)

      await page.reload()
      await expect
        .poll(() => readGroupBindings(fixture.developerApi, createdTeamId!), { timeout: 20000 })
        .toContain(fixture.groupName)

      const reopened = await openPersonalAgentEditor(page, createdTeamId!)
      await expect(reopened.getByTestId('capability-scope-team')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(
        reopened.getByTestId(`capability-scope-group-${fixture.groupName}`)
      ).toBeChecked()
    } finally {
      await page.context().close()
      await fixture.cleanup()
    }
  })

  test('reporter cannot select a group they cannot edit and the save is rejected', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-share-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createShareScopeFixture(request, prefix)
    const page = await openUserPage(browser, fixture.reporterToken)
    const agentDisplayName = `${prefix} reporter agent`

    try {
      const dialog = await openQuickCreateDialog(page)
      await dialog.getByTestId('team-display-name-input').fill(agentDisplayName)
      await dialog.getByTestId('capability-scope-team').focus()
      await dialog.getByTestId('capability-scope-team').press('Enter')

      await expect(dialog.getByTestId('capability-scope-groups')).toBeVisible({ timeout: 15000 })
      await expect(dialog.locator('[data-testid^="capability-scope-group-"]')).toHaveCount(0)

      await dialog.getByRole('button', { name: /^(Save|保存)$/ }).focus()
      await dialog.getByRole('button', { name: /^(Save|保存)$/ }).press('Enter')
      await expect(
        page
          .locator('[role="status"], [data-sonner-toast]')
          .filter({ hasText: /Select a group|选择群组/ })
          .first()
      ).toBeVisible({ timeout: 15000 })

      expect(await findCreatedTeam(fixture.reporterApi, agentDisplayName)).toBeUndefined()
    } finally {
      await page.context().close()
      await fixture.cleanup()
    }
  })

  test('group editor can save an agent whose leader bot is private to its creator', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-share-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createShareScopeFixture(request, prefix)
    const page = await openUserPage(browser, fixture.reporterToken)

    try {
      await page.goto(
        `/resource-library?tab=mine&type=agent&source=group&group=${encodeURIComponent(
          fixture.groupName
        )}`
      )
      await expect(page.getByTestId('my-resources')).toBeVisible({ timeout: 20000 })
      const card = page.getByTestId(`team-card-${fixture.groupTeamId}`)
      await expect(card).toBeVisible({ timeout: 20000 })
      await card.getByTestId(`edit-team-button-${fixture.groupTeamId}`).click()
      const dialog = page.getByTestId('team-edit-dialog')
      await expect(dialog).toBeVisible({ timeout: 15000 })

      const prompt = dialog.getByTestId('simple-prompt-textarea')
      await expect(prompt).toBeVisible({ timeout: 15000 })
      await prompt.fill('Updated by a group editor with only Team permission.')
      await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
      await expect(dialog).toBeHidden({ timeout: 30000 })

      await expect
        .poll(
          () => readLeaderBotPrompt(fixture.reporterApi, fixture.groupTeamBotId),
          { timeout: 20000 }
        )
        .toBe('Updated by a group editor with only Team permission.')
    } finally {
      await page.context().close()
      await fixture.cleanup()
    }
  })
})
