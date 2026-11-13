// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test'
import JSZip from 'jszip'
import { ADMIN_USER, REGULAR_USER } from '../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'
import { ApiClient, createApiClient } from '../utils/api-client'
import { deleteDedicatedBotModel } from '../utils/cleanup-dedicated-bot-model'
import { assertShellRecoveryPermission } from '../utils/shell-recovery-permission'
import { DataBuilders } from '../fixtures/data-builders'
import type { Bot, Team, User } from '../../src/types/api'
import type { Group } from '../../src/types/group'

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
  developerToken: string
  ownerApi: ApiClient
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
  suffix: string,
  botNamespace = namespace,
  agentConfig: Record<string, unknown> = {}
): Promise<{ teamId: number; teamName: string; botId: number }> {
  const botResponse = await api.createBot({
    name: `${prefix}-${suffix}-bot`,
    shell_name: 'Chat',
    agent_config: agentConfig,
    system_prompt: 'Share scope E2E leader bot.',
    namespace: botNamespace,
    is_active: true,
  })
  expect(botResponse.status, JSON.stringify(botResponse.data)).toBe(201)
  expect((botResponse.data as { namespace: string }).namespace).toBe(botNamespace)
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
  expect((teamResponse.data as TeamRecord).namespace).toBe(namespace)
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

  const createdBots: Array<{ id: number; name: string; api: ApiClient }> = []
  const createdTeams: Array<{ id: number; name: string; api: ApiClient }> = []

  const cleanup = async () => {
    for (const team of createdTeams) {
      const response = await team.api.delete(
        `/api/teams/${team.id}?${new URLSearchParams({
          force: 'true',
          confirm_name: team.name,
        })}`
      )
      expect(response.status, JSON.stringify(response.data)).toBe(200)
    }
    for (const bot of createdBots) {
      const response = await bot.api.delete(`/api/bots/${bot.id}?force=true`)
      expect(response.status, JSON.stringify(response.data)).toBe(200)
      await deleteDedicatedBotModel(bot.api, bot.name)
    }
    const groupResponse = await adminApi.deleteGroup(groupName)
    expect(groupResponse.status, JSON.stringify(groupResponse.data)).toBe(204)
    console.log(`E2E cleanup group ${groupName}: ${groupResponse.status}`)
    const userResponse = await adminApi.adminDeleteUser(reporterUserId)
    expect(userResponse.status, JSON.stringify(userResponse.data)).toBe(204)
    console.log(`E2E cleanup user ${reporterUserId}: ${userResponse.status}`)
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

    // The admin owns this private leader Bot while the Team itself is a group
    // resource, keeping the regression on the Team-context authorization path.
    const groupTeam = await createGroupTeam(adminApi, prefix, groupName, 'group', 'default')
    createdBots.push({
      id: groupTeam.botId,
      name: `${prefix}-group-bot`,
      api: adminApi,
    })
    createdTeams.push({
      id: groupTeam.teamId,
      name: groupTeam.teamName,
      api: adminApi,
    })
    const visibleTeams = await developerApi.get<{ items: TeamRecord[] }>(
      `/api/teams?${new URLSearchParams({
        scope: 'group',
        group_name: groupName,
        limit: '100',
      })}`
    )
    expect(visibleTeams.status, JSON.stringify(visibleTeams.data)).toBe(200)
    expect(visibleTeams.data?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: groupTeam.teamId, namespace: groupName }),
      ])
    )

    // The reporter owns this personal agent, so only the group list decides
    // which team targets they may pick.
    const reporterTeam = await createGroupTeam(reporterApi, prefix, 'default', 'reporter')
    createdBots.push({
      id: reporterTeam.botId,
      name: `${prefix}-reporter-bot`,
      api: reporterApi,
    })
    createdTeams.push({
      id: reporterTeam.teamId,
      name: reporterTeam.teamName,
      api: reporterApi,
    })

    return {
      groupName,
      groupTeamId: groupTeam.teamId,
      groupTeamBotId: groupTeam.botId,
      developerToken: developerLogin.data!.access_token,
      ownerApi: adminApi,
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
  for (const suffix of ['member', 'self'] as const) {
    test(`group owner can edit a ${suffix}-created agent without replacing dependencies`, async ({
      browser,
      request,
    }) => {
      const prefix = `e2e-group-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const fixture = await createShareScopeFixture(request, prefix)
      const ownerApi = fixture.developerApi
      const groupData = DataBuilders.group()
      const teams: Array<Awaited<ReturnType<typeof createGroupTeam>> & { api: ApiClient }> = []
      const models: Array<{ api: ApiClient; path: string }> = []
      let groupCreated = false
      let page: Page | undefined
      type TeamDetail = Omit<Team, 'bots'> & {
        bots: Array<{ bot_id: number; role?: string; bot: Bot & { user_id: number } }>
      }
      const readTeam = async (api: ApiClient, teamId: number) => {
        const response = await api.get<TeamDetail>(`/api/teams/${teamId}`)
        expect(response.status, JSON.stringify(response.data)).toBe(200)
        return response.data!
      }

      try {
        const owner = await ownerApi.get<User>('/api/users/me')
        expect(owner.status, JSON.stringify(owner.data)).toBe(200)
        expect(owner.data?.role).toBe('user')
        const createdGroup = await ownerApi.createGroup(groupData)
        expect(createdGroup.status, JSON.stringify(createdGroup.data)).toBe(201)
        groupCreated = true
        const group = await ownerApi.get<Group>(`/api/groups/${groupData.name}`)
        expect(group.status, JSON.stringify(group.data)).toBe(200)
        expect(group.data).toMatchObject({ owner_user_id: owner.data!.id, my_role: 'Owner' })
        const member = await ownerApi.addGroupMember(groupData.name, {
          user_id: fixture.reporterUserId,
          role: 'Developer',
        })
        expect([200, 201], JSON.stringify(member.data)).toContain(member.status)
        page = await openUserPage(browser, fixture.developerToken)

        const creatorApi = suffix === 'member' ? fixture.reporterApi : ownerApi
        const creatorId = suffix === 'member' ? fixture.reporterUserId : owner.data!.id
        await test.step(`Owner edits the ${suffix}-created agent and reloads it`, async () => {
          const modelName = `${prefix}-${suffix}-private-model`
          const modelPath = `/api/v1/namespaces/default/models/${modelName}`
          const createdModel = await creatorApi.post('/api/v1/namespaces/default/models', {
            apiVersion: 'agent.wecode.io/v1',
            kind: 'Model',
            metadata: { name: modelName, namespace: 'default' },
            spec: { modelConfig: { model_id: `${modelName}-provider` } },
          })
          expect(createdModel.status, JSON.stringify(createdModel.data)).toBe(201)
          models.push({ api: creatorApi, path: modelPath })
          const team = await createGroupTeam(
            creatorApi,
            prefix,
            groupData.name,
            suffix,
            'default',
            { bind_model: modelName, bind_model_type: 'user' }
          )
          teams.push({ api: creatorApi, ...team })
          const configured = await creatorApi.put(`/api/bots/${team.botId}`, {
            secondary_model_name: modelName,
          })
          expect(configured.status, JSON.stringify(configured.data)).toBe(200)
          const original = await readTeam(creatorApi, team.teamId)
          const definitionPath = `/api/v1/namespaces/default/bots/${prefix}-${suffix}-bot`
          const definition = await creatorApi.get<{ spec: Record<string, unknown> }>(definitionPath)
          expect(definition.status, JSON.stringify(definition.data)).toBe(200)
          expect(original.user_id).toBe(creatorId)
          expect(original.bots).toHaveLength(1)
          const originalBot = original.bots[0].bot
          expect(originalBot).toMatchObject({
            id: team.botId,
            user_id: creatorId,
            namespace: 'default',
            agent_config: { bind_model: modelName, bind_model_type: 'user' },
            secondary_model_name: modelName,
          })
          if (suffix === 'member') {
            const denied = await ownerApi.put(`/api/bots/${team.botId}`, {
              system_prompt: 'A group Owner cannot edit a private Bot without Team context.',
            })
            expect(denied.status, JSON.stringify(denied.data)).toBe(403)
            await assertShellRecoveryPermission(
              creatorApi,
              ownerApi,
              team,
              definitionPath,
              groupData.name
            )
          }
          await page!.goto('/resource-library?tab=mine&type=agent&source=group')
          const card = page!.getByTestId(`team-card-${team.teamId}`)
          await expect(card).toBeVisible()
          await card.getByTestId(`edit-team-button-${team.teamId}`).click()
          const dialog = page!.getByTestId('team-edit-dialog')
          await expect(dialog.getByTestId('simple-model-select')).toHaveText(modelName)
          await expect(dialog.getByTestId('simple-prompt-textarea')).toHaveValue(
            originalBot.system_prompt
          )
          const displayName = `${prefix} ${suffix} edited by Owner`
          const prompt = `Owner updated the ${suffix}-created agent.`
          await dialog.getByTestId('team-display-name-input').fill(displayName)
          await dialog.getByTestId('simple-prompt-textarea').fill(prompt)
          await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
          await expect(dialog).toBeHidden()
          const saved = await readTeam(creatorApi, team.teamId)
          expect(saved).toMatchObject({
            id: original.id,
            name: original.name,
            namespace: original.namespace,
            user_id: creatorId,
            displayName,
          })
          expect(saved.bots).toHaveLength(1)
          expect(saved.bots[0]).toMatchObject({
            bot_id: team.botId,
            role: original.bots[0].role,
            bot: {
              id: originalBot.id,
              name: originalBot.name,
              user_id: creatorId,
              namespace: originalBot.namespace,
              shell_name: originalBot.shell_name,
              shell_type: originalBot.shell_type,
              agent_config: originalBot.agent_config,
              secondary_model_name: originalBot.secondary_model_name,
              secondary_model_namespace: originalBot.secondary_model_namespace,
              system_prompt: prompt,
            },
          })
          expect(saved.bots[0].bot.agent_config).toEqual(originalBot.agent_config)
          const savedDefinition = await creatorApi.get<{ spec: Record<string, unknown> }>(
            definitionPath
          )
          expect(savedDefinition.status, JSON.stringify(savedDefinition.data)).toBe(200)
          for (const ref of ['ghostRef', 'shellRef', 'modelRef', 'secondaryModelRef']) {
            expect(savedDefinition.data!.spec[ref]).toEqual(definition.data!.spec[ref])
          }

          await page!.reload()
          await expect(card).toBeVisible()
          await card.getByTestId(`edit-team-button-${team.teamId}`).click()
          await expect(dialog.getByTestId('team-display-name-input')).toHaveValue(displayName)
          await expect(dialog.getByTestId('simple-prompt-textarea')).toHaveValue(prompt)
          await expect(dialog.getByTestId('simple-model-select')).toHaveText(modelName)
          console.log(`Owner edited and reloaded ${suffix}-created agent ${team.teamId}`)
        })
      } finally {
        await page?.context().close()
        for (const team of teams) {
          const removed = await team.api.delete(
            `/api/teams/${team.teamId}?${new URLSearchParams({
              force: 'true',
              confirm_name: team.teamName,
            })}`
          )
          expect(removed.status, JSON.stringify(removed.data)).toBe(200)
          const botRemoved = await team.api.delete(`/api/bots/${team.botId}?force=true`)
          expect(botRemoved.status, JSON.stringify(botRemoved.data)).toBe(200)
        }
        for (const model of models) {
          const removed = await model.api.delete(model.path)
          expect(removed.status, JSON.stringify(removed.data)).toBe(200)
        }
        if (groupCreated) {
          const removed = await ownerApi.deleteGroup(groupData.name)
          expect(removed.status, JSON.stringify(removed.data)).toBe(204)
        }
        await fixture.cleanup()
      }
    })
  }

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
    const page = await openUserPage(browser, fixture.developerToken)
    let privateSkillId: number | undefined
    let otherGroupName: string | undefined
    let otherBotId: number | undefined

    try {
      const privateSkillName = `${prefix}-owner-private-skill`
      const archive = new JSZip()
      archive.file(
        `${privateSkillName}/SKILL.md`,
        '---\ndescription: "Private Agent edit regression"\nversion: "1.0.0"\n---\n\n# Private Skill'
      )
      const upload = await fixture.ownerApi.uploadSkill({
        name: privateSkillName,
        namespace: 'default',
        file: await archive.generateAsync({ type: 'nodebuffer' }),
      })
      expect(upload.status, JSON.stringify(upload.data)).toBe(201)
      const skills = await fixture.ownerApi.get<Array<{ id: number; name: string }>>(
        '/api/v1/kinds/skills/unified?scope=personal&limit=100'
      )
      expect(skills.status, JSON.stringify(skills.data)).toBe(200)
      privateSkillId = skills.data?.find(skill => skill.name === privateSkillName)?.id
      expect(privateSkillId).toBeDefined()
      const refs = {
        [privateSkillName]: {
          skill_id: privateSkillId!,
          namespace: 'default',
          is_public: false,
        },
      }
      const configured = await fixture.ownerApi.put(`/api/bots/${fixture.groupTeamBotId}`, {
        skills: [privateSkillName],
        skill_refs: refs,
        preload_skills: [privateSkillName],
        preload_skill_refs: refs,
      })
      expect(configured.status, JSON.stringify(configured.data)).toBe(200)

      const withoutContext = await fixture.developerApi.put(`/api/bots/${fixture.groupTeamBotId}`, {
        system_prompt: 'Must not be saved without Team context.',
      })
      expect(withoutContext.status).toBe(403)
      const reporterUpdate = await fixture.reporterApi.put(`/api/bots/${fixture.groupTeamBotId}`, {
        team_id: fixture.groupTeamId,
        system_prompt: 'Reporter must not edit.',
      })
      expect(reporterUpdate.status).toBe(403)

      await page.goto('/resource-library?tab=mine&type=agent&source=group')
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
        .poll(() => readLeaderBotPrompt(fixture.ownerApi, fixture.groupTeamBotId), {
          timeout: 20000,
        })
        .toBe('Updated by a group editor with only Team permission.')

      const saved = await fixture.ownerApi.get<{
        skills: string[]
        skill_refs: Record<string, { skill_id: number }>
        preload_skills: string[]
      }>(`/api/bots/${fixture.groupTeamBotId}`)
      expect(saved.status, JSON.stringify(saved.data)).toBe(200)
      expect(saved.data?.skills).toEqual([privateSkillName])
      expect(saved.data?.skill_refs[privateSkillName].skill_id).toBe(privateSkillId)
      expect(saved.data?.preload_skills).toEqual([privateSkillName])

      await page.reload()
      await expect(card).toBeVisible({ timeout: 20000 })
      await card.getByTestId(`edit-team-button-${fixture.groupTeamId}`).click()
      await expect(dialog.getByTestId('simple-prompt-textarea')).toHaveValue(
        'Updated by a group editor with only Team permission.'
      )

      // A reference from an editable Team cannot grant another group's
      // source-edit permission, even if its owner installed that reference.
      const otherGroup = DataBuilders.group()
      const otherGroupResponse = await fixture.ownerApi.createGroup(otherGroup)
      expect(otherGroupResponse.status, JSON.stringify(otherGroupResponse.data)).toBe(201)
      otherGroupName = otherGroup.name
      const otherBot = await fixture.ownerApi.createBot({
        name: `${prefix}-other-group-bot`,
        namespace: otherGroupName,
        shell_name: 'Chat',
        agent_config: {},
        system_prompt: 'Other group original prompt.',
      })
      expect(otherBot.status, JSON.stringify(otherBot.data)).toBe(201)
      otherBotId = (otherBot.data as { id: number }).id
      const otherBots = [{ bot_id: otherBotId, role: 'leader' }]
      const installed = await fixture.ownerApi.put(`/api/teams/${fixture.groupTeamId}`, {
        bots: otherBots,
      })
      expect(installed.status, JSON.stringify(installed.data)).toBe(200)

      const crossGroupUpdate = await fixture.developerApi.put(`/api/bots/${otherBotId}`, {
        team_id: fixture.groupTeamId,
        system_prompt: 'Cross-group overwrite must fail.',
      })
      expect(crossGroupUpdate.status).toBe(403)
      const crossGroupReference = await fixture.developerApi.put(
        `/api/teams/${fixture.groupTeamId}`,
        { bots: otherBots }
      )
      expect(crossGroupReference.status).toBe(403)
      const forgedTeam = await fixture.developerApi.createTeam({
        name: `${prefix}-forged-team`,
        namespace: fixture.groupName,
        bots: otherBots,
        workflow: { mode: 'solo' },
      })
      expect(forgedTeam.status).toBe(403)
      expect(await readLeaderBotPrompt(fixture.ownerApi, otherBotId)).toBe(
        'Other group original prompt.'
      )
    } finally {
      await page.context().close()
      await fixture.cleanup()
      if (privateSkillId !== undefined) {
        const removed = await fixture.ownerApi.delete(`/api/v1/kinds/skills/${privateSkillId}`)
        expect(removed.status, JSON.stringify(removed.data)).toBe(204)
      }
      if (otherBotId !== undefined && otherGroupName !== undefined) {
        const removed = await fixture.ownerApi.delete(`/api/bots/${otherBotId}?force=true`)
        expect(removed.status, JSON.stringify(removed.data)).toBe(200)
        // Bot deletion preserves its dedicated Model; remove that fixture
        // explicitly before the group enforces its empty-resource requirement.
        const modelRemoved = await fixture.ownerApi.delete(
          `/api/v1/namespaces/${otherGroupName}/models/${prefix}-other-group-bot-model`
        )
        expect(modelRemoved.status, JSON.stringify(modelRemoved.data)).toBe(200)
      }
      if (otherGroupName !== undefined) {
        const removed = await fixture.ownerApi.deleteGroup(otherGroupName)
        expect(removed.status, JSON.stringify(removed.data)).toBe(204)
      }
    }
  })
  test('group editor model selections persist in the creator scope without private shadowing', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-model-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createShareScopeFixture(request, prefix)
    const privateModels: Array<{ api: ApiClient; path: string }> = []
    const publicModelIds: number[] = []
    const botPath = `/api/bots/${fixture.groupTeamBotId}`
    const ownerModelName = `${prefix}-owner-model`
    const editorModelName = `${prefix}-editor-model`
    const publicModelName = `${prefix}-public-model`
    let page: Page | undefined

    const readSelection = async () => {
      const response = await fixture.ownerApi.get<{
        agent_config: { bind_model: string; bind_model_type: string }
        system_prompt: string
        secondary_model_name: string | null
        secondary_model_namespace: string | null
      }>(botPath)
      expect(response.status, JSON.stringify(response.data)).toBe(200)
      return response.data!
    }

    try {
      for (const [api, name] of [
        [fixture.ownerApi, ownerModelName],
        [fixture.developerApi, editorModelName],
      ] as const) {
        const path = '/api/v1/namespaces/default/models'
        const created = await api.post(path, {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name, namespace: 'default' },
          spec: { modelConfig: { model_id: `${name}-provider` } },
        })
        expect(created.status, JSON.stringify(created.data)).toBe(201)
        privateModels.push({ api, path: `${path}/${name}` })
      }
      for (const name of [ownerModelName, publicModelName]) {
        const created = await fixture.ownerApi.adminCreatePublicModel({
          name,
          json: {
            apiVersion: 'agent.wecode.io/v1',
            kind: 'Model',
            metadata: { name, namespace: 'default' },
            spec: { modelConfig: { model_id: `${name}-public-provider` } },
          },
        })
        expect([200, 201], JSON.stringify(created.data)).toContain(created.status)
        publicModelIds.push((created.data as { id: number }).id)
      }

      const configured = await fixture.ownerApi.put(botPath, {
        agent_config: { bind_model: ownerModelName, bind_model_type: 'user' },
        secondary_model_name: ownerModelName,
      })
      expect(configured.status, JSON.stringify(configured.data)).toBe(200)

      page = await openUserPage(browser, fixture.developerToken)
      await page.goto('/resource-library?tab=mine&type=agent&source=group')
      const card = page.getByTestId(`team-card-${fixture.groupTeamId}`)
      await expect(card).toBeVisible({ timeout: 20000 })
      await card.getByTestId(`edit-team-button-${fixture.groupTeamId}`).click()
      const dialog = page.getByTestId('team-edit-dialog')
      await expect(dialog.getByTestId('simple-model-select')).toHaveText(ownerModelName)
      await dialog.getByTestId('simple-prompt-textarea').fill('Browser retains the private model.')
      await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
      await expect(dialog).toBeHidden({ timeout: 30000 })
      const browserSaved = await readSelection()
      expect(browserSaved.agent_config).toMatchObject({
        bind_model: ownerModelName,
        bind_model_type: 'user',
      })
      expect(browserSaved.system_prompt).toBe('Browser retains the private model.')
      expect(browserSaved.secondary_model_name).toBe(ownerModelName)

      const retained = await fixture.developerApi.put(botPath, {
        team_id: fixture.groupTeamId,
        agent_config: { bind_model: ownerModelName, bind_model_type: 'user' },
        secondary_model_name: ownerModelName,
        system_prompt: 'Creator model remains bound after a group editor save.',
      })
      expect(retained.status, JSON.stringify(retained.data)).toBe(200)
      const original = await readSelection()
      expect(original.agent_config).toMatchObject({
        bind_model: ownerModelName,
        bind_model_type: 'user',
      })
      expect(original.system_prompt).toBe('Creator model remains bound after a group editor save.')
      expect(original.secondary_model_name).toBe(ownerModelName)

      const restricted = await fixture.ownerApi.adminUpdatePublicModel(publicModelIds[1], {
        json: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name: publicModelName, namespace: 'default' },
          spec: {
            modelConfig: { model_id: `${publicModelName}-public-provider` },
            allowedUsersEnabled: true,
            allowedUsers: [REGULAR_USER.username],
          },
        },
      })
      expect(restricted.status, JSON.stringify(restricted.data)).toBe(200)
      const ownerDenied = await fixture.developerApi.put(botPath, {
        team_id: fixture.groupTeamId,
        agent_config: { bind_model: publicModelName, bind_model_type: 'public' },
      })
      expect(ownerDenied.status, JSON.stringify(ownerDenied.data)).toBe(403)
      expect((await readSelection()).agent_config).toEqual(original.agent_config)
      const unrestricted = await fixture.ownerApi.adminUpdatePublicModel(publicModelIds[1], {
        json: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name: publicModelName, namespace: 'default' },
          spec: { modelConfig: { model_id: `${publicModelName}-public-provider` } },
        },
      })
      expect(unrestricted.status, JSON.stringify(unrestricted.data)).toBe(200)

      const secondarySelected = await fixture.developerApi.put(botPath, {
        team_id: fixture.groupTeamId,
        secondary_model_name: publicModelName,
      })
      expect(secondarySelected.status, JSON.stringify(secondarySelected.data)).toBe(200)
      expect((await readSelection()).secondary_model_name).toBe(publicModelName)
      for (const name of [`${prefix}-missing-model`, editorModelName, ownerModelName]) {
        const rejected = await fixture.developerApi.put(botPath, {
          team_id: fixture.groupTeamId,
          secondary_model_name: name,
          system_prompt: 'Invalid secondary selections must not persist.',
        })
        expect(rejected.status, JSON.stringify(rejected.data)).toBe(403)
        const unchanged = await readSelection()
        expect(unchanged.secondary_model_name).toBe(publicModelName)
        expect(unchanged.system_prompt).toBe(original.system_prompt)
      }

      for (const agentConfig of [
        { bind_model: `${prefix}-missing-model` },
        { bind_model: editorModelName },
        { bind_model: ownerModelName, bind_model_type: 'public' },
      ]) {
        const rejected = await fixture.developerApi.put(botPath, {
          team_id: fixture.groupTeamId,
          agent_config: agentConfig,
          system_prompt: 'An invalid selection must not change the prompt.',
        })
        expect(rejected.status, JSON.stringify(rejected.data)).toBe(403)
        const unchanged = await readSelection()
        expect(unchanged.agent_config).toEqual(original.agent_config)
        expect(unchanged.system_prompt).toBe(original.system_prompt)
      }

      for (const agentConfig of [
        { bind_model: publicModelName },
        { bind_model: publicModelName, bind_model_type: 'public' },
      ]) {
        const selected = await fixture.developerApi.put(botPath, {
          team_id: fixture.groupTeamId,
          agent_config: agentConfig,
        })
        expect(selected.status, JSON.stringify(selected.data)).toBe(200)
        expect((await readSelection()).agent_config).toMatchObject({
          bind_model: publicModelName,
          bind_model_type: 'public',
        })
      }

      // A different name also must not install a public reference shadowed
      // by a creator-private model when the creator subsequently reloads it.
      const shadowed = await fixture.developerApi.put(botPath, {
        team_id: fixture.groupTeamId,
        agent_config: { bind_model: ownerModelName, bind_model_type: 'public' },
      })
      expect(shadowed.status, JSON.stringify(shadowed.data)).toBe(403)
      expect((await readSelection()).agent_config).toMatchObject({
        bind_model: publicModelName,
        bind_model_type: 'public',
      })

      const groupModelName = `${prefix}-group-model`
      const groupModelPath = `/api/v1/namespaces/${fixture.groupName}/models`
      // Generic CRD creation requires Maintainer-or-higher permission; the
      // Developer remains the actor selecting this independently shared Model.
      const groupModel = await fixture.ownerApi.post(groupModelPath, {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: { name: groupModelName, namespace: fixture.groupName },
        spec: { modelConfig: { model_id: `${prefix}-group-provider` } },
      })
      expect(groupModel.status, JSON.stringify(groupModel.data)).toBe(201)
      privateModels.push({
        api: fixture.ownerApi,
        path: `${groupModelPath}/${groupModelName}`,
      })
      for (const agentConfig of [
        { bind_model: groupModelName, bind_model_namespace: fixture.groupName },
        {
          bind_model: groupModelName,
          bind_model_namespace: fixture.groupName,
          bind_model_type: 'group',
        },
      ]) {
        const selected = await fixture.developerApi.put(botPath, {
          team_id: fixture.groupTeamId,
          agent_config: agentConfig,
          secondary_model_name: groupModelName,
          secondary_model_namespace: fixture.groupName,
        })
        expect(selected.status, JSON.stringify(selected.data)).toBe(200)
        expect((await readSelection()).agent_config).toMatchObject({
          bind_model: groupModelName,
          bind_model_namespace: fixture.groupName,
          bind_model_type: 'group',
        })
        expect(await readSelection()).toMatchObject({
          secondary_model_name: groupModelName,
          secondary_model_namespace: fixture.groupName,
        })
      }
    } finally {
      await page?.context().close()
      for (const { api, path } of privateModels) {
        const removed = await api.delete(path)
        expect([200, 204], JSON.stringify(removed.data)).toContain(removed.status)
      }
      for (const modelId of publicModelIds) {
        const removed = await fixture.ownerApi.adminDeletePublicModel(modelId)
        expect([200, 204], JSON.stringify(removed.data)).toContain(removed.status)
      }
      await fixture.cleanup()
    }
  })
})
