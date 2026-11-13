// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test'
import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import { ADMIN_USER, REGULAR_USER } from '../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'
import { ApiClient, createApiClient } from '../utils/api-client'
import { DataBuilders } from '../fixtures/data-builders'

const APP_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'
// Public fixture repository with a single `demo-skill/SKILL.md`.
const SKILL_GIT_FIXTURE_REPO =
  process.env.E2E_SKILL_GIT_REPO_URL || 'https://github.com/hustfisher/wegent-skill-e2e-fixture'

interface UnifiedSkill {
  id: number
  name: string
  namespace: string
  user_id: number
  version?: string | null
}

interface TeamRecord {
  id: number
  name: string
  namespace: string
}

interface SkillScopeFixture {
  groupName: string
  teamId: number
  teamName: string
  botId: number
  adminApi: ApiClient
  adminUserId: number
  userApi: ApiClient
  userToken: string
  personalSkillName: string
  personalSkillId: number
  teamSkillName: string
  teamSkillId: number
  createdSkillIds: number[]
  cleanup: () => Promise<void>
}

async function buildSkillZip(name: string, version: string): Promise<Buffer> {
  const zip = new JSZip()
  const folder = zip.folder(name)
  if (!folder) throw new Error(`Unable to create skill folder for ${name}`)
  folder.file(
    'SKILL.md',
    [
      '---',
      `description: "E2E skill ${name}"`,
      `version: "${version}"`,
      'author: "Wegent E2E"',
      '---',
      '',
      `# ${name}`,
      '',
      'Fixture used by the skill management scope E2E test.',
    ].join('\n')
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function listUnifiedSkills(
  api: ApiClient,
  params: { scope: 'personal' | 'group'; groupName?: string }
): Promise<UnifiedSkill[]> {
  const query = new URLSearchParams({ scope: params.scope, limit: '100' })
  if (params.groupName) query.set('group_name', params.groupName)
  const response = await api.get<UnifiedSkill[]>(`/api/v1/kinds/skills/unified?${query}`)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return response.data || []
}

async function findUserId(api: ApiClient, userName: string): Promise<number> {
  // The user search endpoint hides the caller, so resolve ids through the
  // administrator directory instead.
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

async function findUploadedSkill(
  api: ApiClient,
  params: { scope: 'personal' | 'group'; groupName?: string; name: string }
): Promise<UnifiedSkill> {
  let found: UnifiedSkill | undefined
  await expect
    .poll(
      async () => {
        const skills = await listUnifiedSkills(api, params)
        found = skills.find(skill => skill.name === params.name)
        return Boolean(found)
      },
      { timeout: 15000 }
    )
    .toBe(true)
  return found as UnifiedSkill
}

async function expectSkill(
  api: ApiClient,
  params: { scope: 'personal' | 'group'; groupName?: string; name: string }
): Promise<UnifiedSkill> {
  const skills = await listUnifiedSkills(api, params)
  const skill = skills.find(item => item.name === params.name)
  expect(skill, `Skill ${params.name} should exist in ${params.scope} scope`).toBeDefined()
  return skill as UnifiedSkill
}

async function createSkillScopeFixture(
  request: APIRequestContext,
  prefix: string
): Promise<SkillScopeFixture> {
  const adminApi = createApiClient(request)
  const adminLogin = await adminApi.login(ADMIN_USER.username, ADMIN_USER.password, 1)
  expect(adminLogin.status, JSON.stringify(adminLogin.data)).toBe(200)

  const adminUserId = await findUserId(adminApi, ADMIN_USER.username)

  const groupData = DataBuilders.group()
  const groupResponse = await adminApi.createGroup(groupData)
  expect(groupResponse.status, JSON.stringify(groupResponse.data)).toBe(201)
  const groupName = groupData.name

  const userApi = createApiClient(request)
  const userLogin = await userApi.login(REGULAR_USER.username, REGULAR_USER.password, 1)
  expect(userLogin.status, JSON.stringify(userLogin.data)).toBe(200)
  const userToken = userLogin.data!.access_token

  const createdSkillIds: number[] = []
  let botId = 0
  let teamId = 0
  let teamName = ''
  let personalSkillId = 0

  const cleanup = async () => {
    for (const skillId of createdSkillIds) {
      const response = await adminApi
        .delete(`/api/v1/kinds/skills/${skillId}`)
        .catch(() => undefined)
      console.log(`E2E cleanup group skill ${skillId}: ${response?.status ?? 'request failed'}`)
    }
    if (personalSkillId) {
      const response = await userApi
        .delete(`/api/v1/kinds/skills/${personalSkillId}`)
        .catch(() => undefined)
      console.log(
        `E2E cleanup personal skill ${personalSkillId}: ${response?.status ?? 'request failed'}`
      )
    }
    if (teamId) {
      const response = await adminApi
        .delete(
          `/api/teams/${teamId}?${new URLSearchParams({ force: 'true', confirm_name: teamName })}`
        )
        .catch(() => undefined)
      console.log(`E2E cleanup team ${teamId}: ${response?.status ?? 'request failed'}`)
    }
    if (botId) {
      const response = await adminApi.delete(`/api/bots/${botId}?force=true`).catch(() => undefined)
      console.log(`E2E cleanup bot ${botId}: ${response?.status ?? 'request failed'}`)
    }
    const modelName = `${prefix}-group-bot-model`
    const modelResponse = await adminApi
      .delete(
        `/api/v1/namespaces/${encodeURIComponent(groupName)}/models/${encodeURIComponent(modelName)}`
      )
      .catch(() => undefined)
    console.log(`E2E cleanup model ${modelName}: ${modelResponse?.status ?? 'request failed'}`)
    const groupResponse = await adminApi.deleteGroup(groupName).catch(() => undefined)
    console.log(`E2E cleanup group ${groupName}: ${groupResponse?.status ?? 'request failed'}`)
  }

  try {
    const regularUserId = await findUserId(adminApi, REGULAR_USER.username)

    const memberResponse = await adminApi.addGroupMember(groupName, {
      user_id: regularUserId,
      role: 'Developer',
    })
    expect([200, 201], JSON.stringify(memberResponse.data)).toContain(memberResponse.status)

    const botName = `${prefix}-group-bot`
    const botResponse = await adminApi.createBot({
      name: botName,
      shell_name: 'Chat',
      agent_config: {},
      system_prompt: 'Skill management scope E2E leader bot.',
      namespace: groupName,
      is_active: true,
    })
    expect(botResponse.status, JSON.stringify(botResponse.data)).toBe(201)
    botId = (botResponse.data as { id: number }).id

    teamName = `${prefix}-group-agent`
    const teamResponse = await adminApi.createTeam({
      name: teamName,
      description: 'Skill management scope E2E group agent',
      bots: [{ bot_id: botId, bot_prompt: 'Skill scope E2E leader prompt.', role: 'leader' }],
      bind_mode: ['chat', 'code'],
      namespace: groupName,
      is_active: true,
      requires_workspace: false,
      workflow: { mode: 'solo' },
    })
    expect(teamResponse.status, JSON.stringify(teamResponse.data)).toBe(201)
    teamId = (teamResponse.data as TeamRecord).id

    const teamSkillName = `${prefix}-team-skill`
    const teamUpload = await adminApi.uploadSkill({
      name: teamSkillName,
      namespace: groupName,
      file: await buildSkillZip(teamSkillName, '1.0.0'),
    })
    expect(teamUpload.status, JSON.stringify(teamUpload.data)).toBe(201)

    const personalSkillName = `${prefix}-personal-skill`
    const personalUpload = await userApi.uploadSkill({
      name: personalSkillName,
      namespace: 'default',
      file: await buildSkillZip(personalSkillName, '1.0.0'),
    })
    expect(personalUpload.status, JSON.stringify(personalUpload.data)).toBe(201)

    const teamSkill = await findUploadedSkill(adminApi, {
      scope: 'group',
      groupName,
      name: teamSkillName,
    })
    const personalSkill = await findUploadedSkill(userApi, {
      scope: 'personal',
      name: personalSkillName,
    })
    createdSkillIds.push(teamSkill.id)
    personalSkillId = personalSkill.id

    return {
      groupName,
      teamId,
      teamName,
      botId,
      adminApi,
      adminUserId,
      userApi,
      userToken,
      personalSkillName,
      personalSkillId,
      teamSkillName,
      teamSkillId: teamSkill.id,
      createdSkillIds,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function openUserContext(
  browser: Browser,
  token: string
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: APP_BASE_URL,
    storageState: buildStorageState(APP_BASE_URL, token, getJwtExpiryMs(token)),
    viewport: { width: 1280, height: 720 },
  })
  return { context, page: await context.newPage() }
}

async function openGroupAgentEditor(
  page: Page,
  groupName: string,
  teamId: number
): Promise<Locator> {
  await page.goto(
    `/resource-library?tab=mine&type=agent&source=group&group=${encodeURIComponent(groupName)}`
  )
  await expect(page.getByTestId('my-resources')).toBeVisible({ timeout: 20000 })

  const card = page.getByTestId(`team-card-${teamId}`)
  await expect(card).toBeVisible({ timeout: 20000 })
  await card.getByTestId(`edit-team-button-${teamId}`).click()

  const dialog = page.getByTestId('team-edit-dialog')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  return dialog
}

async function openSkillManagement(dialog: Locator): Promise<Locator> {
  const manageButton = dialog.getByTestId('simple-manage-skills-button')
  if (!(await manageButton.isVisible())) {
    await dialog.getByTestId('simple-additional-capabilities-toggle').click()
  }
  await manageButton.click()
  const manager = dialog.page().getByTestId('skill-management-dialog')
  await expect(manager).toBeVisible({ timeout: 15000 })
  return manager
}

test.describe('Agent skill management scope', () => {
  test('cloning from a group through personal space uses each creation target', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-clone-skills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)
    const targetGroup = DataBuilders.group()
    const clones: Array<{ id: number; name: string; namespace: string }> = []
    try {
      const group = await fixture.adminApi.createGroup(targetGroup)
      expect(group.status, JSON.stringify(group.data)).toBe(201)
      const userId = await findUserId(fixture.adminApi, REGULAR_USER.username)
      const member = await fixture.adminApi.addGroupMember(targetGroup.name, {
        user_id: userId,
        role: 'Developer',
      })
      expect([200, 201], JSON.stringify(member.data)).toContain(member.status)
      const targetSkillName = `${prefix}-target-skill`
      const upload = await fixture.adminApi.uploadSkill({
        name: targetSkillName,
        namespace: targetGroup.name,
        file: await buildSkillZip(targetSkillName, '1.0.0'),
      })
      expect(upload.status, JSON.stringify(upload.data)).toBe(201)
      const targetSkill = await findUploadedSkill(fixture.adminApi, {
        scope: 'group',
        groupName: targetGroup.name,
        name: targetSkillName,
      })
      fixture.createdSkillIds.push(targetSkill.id)

      const source = await fixture.adminApi.put(`/api/bots/${fixture.botId}`, {
        shell_name: 'ClaudeCode',
      })
      expect(source.status, JSON.stringify(source.data)).toBe(200)
      const team = await fixture.adminApi.put(`/api/teams/${fixture.teamId}`, {
        workflow: { mode: 'pipeline', leader_bot_id: fixture.botId },
        bind_mode: ['code'],
      })
      expect(team.status, JSON.stringify(team.data)).toBe(200)

      const cloneBot = async (
        dialog: Locator,
        sourceId: number,
        namespace: string,
        name: string,
        skillId: number,
        skillName: string
      ) => {
        const [options] = await Promise.all([
          page.waitForRequest(request => {
            const url = new URL(request.url())
            return (
              url.pathname.endsWith('/v1/kinds/skills') && url.searchParams.has('binding_namespace')
            )
          }),
          dialog.getByTestId(`copy-bot-button-${sourceId}`).click(),
        ])
        const query = new URL(options.url()).searchParams
        expect(query.get('binding_namespace')).toBe(namespace)
        expect(query.has('binding_bot_id')).toBe(false)
        expect((await options.response())?.status()).toBe(200)
        const drawer = page.locator('[data-team-edit-drawer="true"]')
        await drawer.getByPlaceholder(/^(Code Assistant|输入机器人名称)$/).fill(name)
        await drawer.getByTestId('skill-selector-trigger').click()
        await expect(page.getByTestId(`skill-selector-option-${skillId}`)).toBeVisible()
        await expect(page.getByTestId(`skill-selector-option-${fixture.teamSkillId}`)).toHaveCount(
          0
        )
        await page.getByTestId(`skill-selector-option-${skillId}`).click()
        const [saved] = await Promise.all([
          page.waitForResponse(
            response =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/api/bots'
          ),
          drawer.getByTestId('save-button').click(),
        ])
        expect(saved.status(), await saved.text()).toBe(201)
        const created = (await saved.json()) as { id: number; name: string; namespace: string }
        clones.push(created)
        expect(created.id).not.toBe(sourceId)
        expect(saved.request().postDataJSON().namespace || 'default').toBe(namespace)
        expect(saved.request().postDataJSON().skill_refs[skillName].skill_id).toBe(skillId)
        await expect(drawer).toBeHidden()
        const persisted = await fixture.userApi.get(`/api/bots/${created.id}`)
        expect(persisted.status, JSON.stringify(persisted.data)).toBe(200)
        expect(persisted.data).toMatchObject({
          name,
          namespace,
          shell_type: 'ClaudeCode',
          skill_refs: { [skillName]: { skill_id: skillId } },
        })
        return created
      }

      // The library's all-sources editor clones into personal space.
      await page.goto('/resource-library?tab=mine&type=agent&source=all')
      await page.getByTestId(`edit-team-button-${fixture.teamId}`).click()
      const dialog = page.getByTestId('team-edit-dialog')
      await expect(dialog.getByTestId('select-mode-radio-pipeline')).toBeChecked()
      const personal = await cloneBot(
        dialog,
        fixture.botId,
        'default',
        `${prefix}-personal-clone`,
        fixture.personalSkillId,
        fixture.personalSkillName
      )

      // Group creation loads personal source Bots while saving into the selected group.
      await page.goto('/resource-library?tab=mine&type=agent&source=all')
      await page.getByTestId('new-capability-button').click()
      await page.getByTestId('new-capability-type-agent').click()
      const scope = dialog.getByTestId('capability-scope-team')
      await scope.focus()
      await scope.press('Enter')
      const target = dialog.getByTestId(`capability-scope-group-${targetGroup.name}`)
      await expect(target).toBeVisible()
      if (!(await target.isChecked())) {
        await target.focus()
        await target.press('Space')
      }
      const groupChoices = dialog.locator('[data-testid^="capability-scope-group-"]')
      for (const choice of await groupChoices.all()) {
        if (
          (await choice.getAttribute('data-testid')) !==
            `capability-scope-group-${targetGroup.name}` &&
          (await choice.isChecked())
        ) {
          await choice.focus()
          await choice.press('Space')
        }
      }
      await expect(
        dialog.locator('[data-testid^="capability-scope-group-"][data-state="checked"]')
      ).toHaveCount(1)
      await expect(target).toBeChecked()
      await dialog.getByTestId('select-mode-label-pipeline').click()
      await expect(dialog.getByTestId('select-mode-radio-pipeline')).toBeChecked()
      await cloneBot(
        dialog,
        personal.id,
        targetGroup.name,
        `${prefix}-group-clone`,
        targetSkill.id,
        targetSkillName
      )
      const unchanged = await fixture.userApi.get(`/api/bots/${fixture.botId}`)
      expect(unchanged.status).toBe(200)
      expect(unchanged.data).toEqual(source.data)
    } finally {
      await context.close()
      for (const clone of clones.reverse()) {
        await fixture.userApi.delete(`/api/bots/${clone.id}?force=true`)
        await fixture.userApi.delete(
          `/api/v1/namespaces/${clone.namespace}/models/${clone.name}-model`
        )
      }
      await fixture.cleanup()
      await fixture.adminApi.deleteGroup(targetGroup.name)
    }
  })

  test('binding choices match save permissions across independent groups', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)
    const otherGroup = DataBuilders.group()
    const skillName = `${prefix}-shared`
    try {
      const created = await fixture.adminApi.createGroup(otherGroup)
      expect(created.status, JSON.stringify(created.data)).toBe(201)
      const userId = await findUserId(fixture.adminApi, REGULAR_USER.username)
      const member = await fixture.adminApi.addGroupMember(otherGroup.name, {
        user_id: userId,
        role: 'Owner',
      })
      expect([200, 201], JSON.stringify(member.data)).toContain(member.status)
      const upload = await fixture.adminApi.uploadSkill({
        name: skillName,
        namespace: 'default',
        file: await buildSkillZip(skillName, '1.0.0'),
      })
      expect(upload.status, JSON.stringify(upload.data)).toBe(201)
      const shared = await findUploadedSkill(fixture.adminApi, {
        scope: 'personal',
        name: skillName,
      })
      fixture.createdSkillIds.push(shared.id)
      const share = async (groups: string[]) => {
        const response = await fixture.adminApi.post(
          `/api/v1/kinds/skills/${shared.id}/bindings/groups`,
          { group_names: groups }
        )
        expect(response.status, JSON.stringify(response.data)).toBe(200)
      }
      await share([otherGroup.name])
      const browse = await fixture.userApi.get<UnifiedSkill[]>(
        '/api/v1/kinds/skills/unified?scope=all'
      )
      expect(browse.status).toBe(200)
      expect(browse.data?.some(skill => skill.id === shared.id)).toBe(true)

      const openEditor = async () => {
        await page.goto('/resource-library?tab=mine&type=agent&source=all')
        const card = page.getByTestId(`team-card-${fixture.teamId}`)
        await expect(card).toBeVisible({ timeout: 20000 })
        const options = page.waitForResponse(response => {
          const url = new URL(response.url())
          return (
            url.pathname.endsWith('/v1/kinds/skills') &&
            url.searchParams.get('binding_bot_id') === String(fixture.botId)
          )
        })
        await card.getByTestId(`edit-team-button-${fixture.teamId}`).click()
        expect((await options).status()).toBe(200)
        const dialog = page.getByTestId('team-edit-dialog')
        await dialog.getByTestId('simple-additional-capabilities-toggle').click()
        await dialog.getByTestId('skill-selector-trigger').click()
        return dialog
      }
      await openEditor()
      await expect(
        page.getByTestId(`skill-selector-option-${fixture.personalSkillId}`)
      ).toBeVisible()
      await expect(page.getByTestId(`skill-selector-option-${fixture.teamSkillId}`)).toBeVisible()
      await expect(page.getByTestId(`skill-selector-option-${shared.id}`)).toHaveCount(0)
      const denied = await fixture.userApi.put(`/api/bots/${fixture.botId}`, {
        skills: [skillName],
        skill_refs: {
          [skillName]: { skill_id: shared.id, namespace: 'default', is_public: false },
        },
      })
      expect(denied.status).toBe(403)

      await share([otherGroup.name, fixture.groupName])
      const dialog = await openEditor()
      await page.getByTestId(`skill-selector-option-${shared.id}`).click()
      const saved = page.waitForResponse(
        response =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname.endsWith(`/bots/${fixture.botId}`)
      )
      await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
      const response = await saved
      expect(response.status()).toBe(200)
      expect(response.request().postDataJSON().skill_refs[skillName].skill_id).toBe(shared.id)
      const persisted = await fixture.userApi.get<{
        skill_refs: Record<string, { skill_id: number }>
      }>(`/api/bots/${fixture.botId}`)
      expect(persisted.status).toBe(200)
      expect(persisted.data?.skill_refs[skillName].skill_id).toBe(shared.id)
    } finally {
      await context.close()
      await fixture.userApi.put(`/api/bots/${fixture.botId}`, { skills: [], preload_skills: [] })
      await fixture.cleanup()
      await fixture.adminApi.deleteGroup(otherGroup.name)
    }
  })

  test('regular user sees personal and team skills in the editor and management list', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-skill-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)

    try {
      const dialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      await dialog.getByTestId('simple-additional-capabilities-toggle').click()

      const selector = dialog.getByTestId('skill-selector-trigger')
      await expect(selector).toBeVisible({ timeout: 15000 })
      await selector.click()
      await expect(
        page.getByTestId(`skill-selector-option-${fixture.personalSkillId}`)
      ).toBeVisible({ timeout: 15000 })
      await expect(page.getByTestId(`skill-selector-option-${fixture.teamSkillId}`)).toBeVisible()
      await selector.click()

      const manager = await openSkillManagement(dialog)
      await expect(manager.getByTestId(`managed-skill-${fixture.personalSkillId}`)).toBeVisible({
        timeout: 15000,
      })
      await expect(manager.getByTestId(`managed-skill-${fixture.teamSkillId}`)).toBeVisible()

      const personalSource = manager.getByTestId(`managed-skill-source-${fixture.personalSkillId}`)
      const teamSource = manager.getByTestId(`managed-skill-source-${fixture.teamSkillId}`)
      await expect(personalSource).toBeVisible()
      await expect(teamSource).toContainText(fixture.groupName)
      await expect(personalSource).not.toContainText(fixture.groupName)
    } finally {
      await context.close()
      await fixture.cleanup()
    }
  })

  test('skill uploaded from the management modal survives reload and reopen', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-skill-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)
    const uploadedSkillName = `${prefix}-managed-upload`

    try {
      const dialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      const manager = await openSkillManagement(dialog)

      await manager.getByTestId('manage-skills-upload-button').click()
      const uploadDialog = page.getByTestId('skill-upload-dialog')
      await expect(uploadDialog).toBeVisible({ timeout: 15000 })
      await uploadDialog.locator('#skill-name').fill(uploadedSkillName)
      await uploadDialog.locator('#file-input').setInputFiles({
        name: `${uploadedSkillName}.zip`,
        mimeType: 'application/zip',
        buffer: await buildSkillZip(uploadedSkillName, '1.0.0'),
      })

      const uploadResponsePromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return (
          response.request().method() === 'POST' && url.pathname === '/api/v1/kinds/skills/upload'
        )
      })
      await uploadDialog.getByTestId('skill-upload-submit-button').click()
      const uploadResponse = await uploadResponsePromise
      expect(uploadResponse.status(), await uploadResponse.text()).toBe(201)
      await expect(uploadDialog).toBeHidden({ timeout: 15000 })

      const uploaded = await findUploadedSkill(fixture.userApi, {
        scope: 'group',
        groupName: fixture.groupName,
        name: uploadedSkillName,
      })
      fixture.createdSkillIds.push(uploaded.id)
      await expect(manager.getByTestId(`managed-skill-${uploaded.id}`)).toBeVisible({
        timeout: 15000,
      })

      await page.reload()
      const reopenedDialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      const reopenedManager = await openSkillManagement(reopenedDialog)
      await expect(reopenedManager.getByTestId(`managed-skill-${uploaded.id}`)).toBeVisible({
        timeout: 20000,
      })
      await expectSkill(fixture.userApi, {
        scope: 'group',
        groupName: fixture.groupName,
        name: uploadedSkillName,
      })
    } finally {
      await context.close()
      await fixture.cleanup()
    }
  })

  test('personal skill download and edit only change that skill', async ({ browser, request }) => {
    const prefix = `e2e-skill-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)
    const updatedVersion = '2.0.0'

    try {
      const dialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      const manager = await openSkillManagement(dialog)

      const downloadPromise = page.waitForEvent('download')
      await manager.getByTestId(`download-skill-button-${fixture.personalSkillId}`).click()
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe(`${fixture.personalSkillName}.zip`)
      expect(await download.failure()).toBeNull()
      const downloadedPath = await download.path()
      expect(downloadedPath).toBeTruthy()
      const downloadedZip = await readFile(downloadedPath as string)
      expect(downloadedZip.subarray(0, 2).toString('latin1')).toBe('PK')
      expect(downloadedZip.byteLength).toBeGreaterThan(0)

      await manager.getByTestId(`edit-skill-button-${fixture.personalSkillId}`).click()
      const uploadDialog = page.getByTestId('skill-upload-dialog')
      await expect(uploadDialog).toBeVisible({ timeout: 15000 })
      await uploadDialog.locator('#file-input').setInputFiles({
        name: `${fixture.personalSkillName}.zip`,
        mimeType: 'application/zip',
        buffer: await buildSkillZip(fixture.personalSkillName, updatedVersion),
      })

      const updateResponsePromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return (
          response.request().method() === 'PUT' &&
          url.pathname === `/api/v1/kinds/skills/${fixture.personalSkillId}`
        )
      })
      await uploadDialog.getByTestId('skill-upload-submit-button').click()
      const updateResponse = await updateResponsePromise
      expect(updateResponse.status(), await updateResponse.text()).toBe(200)
      await expect(uploadDialog).toBeHidden({ timeout: 15000 })

      await expect
        .poll(
          async () => {
            const skills = await listUnifiedSkills(fixture.userApi, { scope: 'personal' })
            return skills.find(skill => skill.id === fixture.personalSkillId)?.version
          },
          { timeout: 15000 }
        )
        .toBe(updatedVersion)

      const teamSkill = await expectSkill(fixture.userApi, {
        scope: 'group',
        groupName: fixture.groupName,
        name: fixture.teamSkillName,
      })
      expect(teamSkill.id).toBe(fixture.teamSkillId)
      expect(teamSkill.version).toBe('1.0.0')
      expect(teamSkill.user_id).toBe(fixture.adminUserId)
      expect(teamSkill.namespace).toBe(fixture.groupName)

      const personalSkill = await expectSkill(fixture.userApi, {
        scope: 'personal',
        name: fixture.personalSkillName,
      })
      expect(personalSkill.id).toBe(fixture.personalSkillId)
      expect(personalSkill.namespace).toBe('default')
      expect(personalSkill.user_id).not.toBe(fixture.adminUserId)
    } finally {
      await context.close()
      await fixture.cleanup()
    }
  })

  test('regular user cannot delete a team skill and sees the failure', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-skill-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)

    try {
      const dialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      const manager = await openSkillManagement(dialog)

      await manager.getByTestId(`delete-skill-button-${fixture.teamSkillId}`).click()
      const deleteResponsePromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return (
          response.request().method() === 'DELETE' &&
          url.pathname === `/api/v1/kinds/skills/${fixture.teamSkillId}`
        )
      })
      await page.getByTestId('confirm-delete-skill-button').click()
      const deleteResponse = await deleteResponsePromise
      expect(deleteResponse.status()).toBe(403)

      await expect(
        page
          .locator('[role="status"], [data-sonner-toast]')
          .filter({ hasText: /Failed to delete skill|删除技能失败/ })
          .first()
      ).toBeVisible({ timeout: 15000 })

      await expectSkill(fixture.userApi, {
        scope: 'group',
        groupName: fixture.groupName,
        name: fixture.teamSkillName,
      })
    } finally {
      await context.close()
      await fixture.cleanup()
    }
  })

  test('management upload follows the personal target after switching scope', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-skill-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)
    const personalSkillName = `${prefix}-personal-target`

    try {
      const dialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      const manager = await openSkillManagement(dialog)

      await manager.getByTestId('manage-skills-upload-button').click()
      const uploadDialog = page.getByTestId('skill-upload-dialog')
      await expect(uploadDialog).toBeVisible({ timeout: 15000 })
      await expect(uploadDialog.getByTestId('capability-scope-team')).toHaveAttribute(
        'aria-pressed',
        'true'
      )

      await uploadDialog.getByTestId('capability-scope-personal').click()
      await uploadDialog.locator('#skill-name').fill(personalSkillName)
      await uploadDialog.locator('#file-input').setInputFiles({
        name: `${personalSkillName}.zip`,
        mimeType: 'application/zip',
        buffer: await buildSkillZip(personalSkillName, '1.0.0'),
      })

      const uploadPromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return (
          response.request().method() === 'POST' && url.pathname === '/api/v1/kinds/skills/upload'
        )
      })
      await uploadDialog.getByTestId('skill-upload-submit-button').click()
      const uploadResponse = await uploadPromise
      expect(uploadResponse.status(), await uploadResponse.text()).toBe(201)

      const uploaded = await findUploadedSkill(fixture.userApi, {
        scope: 'personal',
        name: personalSkillName,
      })
      fixture.createdSkillIds.push(uploaded.id)
      expect(uploaded.namespace).toBe('default')

      const groupSkills = await listUnifiedSkills(fixture.userApi, {
        scope: 'group',
        groupName: fixture.groupName,
      })
      expect(groupSkills.some(skill => skill.name === personalSkillName)).toBe(false)
    } finally {
      await context.close()
      await fixture.cleanup()
    }
  })

  test('management git import lands in the selected team namespace', async ({
    browser,
    request,
  }) => {
    const prefix = `e2e-skill-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)

    try {
      const dialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      const manager = await openSkillManagement(dialog)

      await manager.getByTestId('manage-skills-upload-button').click()
      const uploadDialog = page.getByTestId('skill-upload-dialog')
      await expect(uploadDialog).toBeVisible({ timeout: 15000 })
      await expect(uploadDialog.getByTestId('capability-scope-team')).toHaveAttribute(
        'aria-pressed',
        'true'
      )

      await uploadDialog.getByTestId('skill-update-git-tab').click()
      await uploadDialog.locator('#git-url').fill(SKILL_GIT_FIXTURE_REPO)
      await uploadDialog.getByRole('button', { name: /Scan Skills|扫描技能/ }).click()

      const skillCheckbox = uploadDialog.locator('#skill-demo-skill')
      await expect(skillCheckbox).toBeVisible({ timeout: 60000 })
      await skillCheckbox.click()

      const importPromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return (
          response.request().method() === 'POST' &&
          url.pathname === '/api/v1/kinds/skills/git/import'
        )
      })
      await uploadDialog.getByTestId('git-import-submit').click()
      const importResponse = await importPromise
      expect(importResponse.status(), await importResponse.text()).toBe(200)

      const imported = await findUploadedSkill(fixture.userApi, {
        scope: 'group',
        groupName: fixture.groupName,
        name: 'demo-skill',
      })
      fixture.createdSkillIds.push(imported.id)
      expect(imported.namespace).toBe(fixture.groupName)
    } finally {
      await context.close()
      await fixture.cleanup()
    }
  })

  test('marketplace creation publishes the skill with its tags', async ({ browser, request }) => {
    const prefix = `e2e-skill-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixture = await createSkillScopeFixture(request, prefix)
    const { context, page } = await openUserContext(browser, fixture.userToken)
    const marketplaceSkillName = `${prefix}-marketplace-skill`

    try {
      const tagsResponse = await fixture.adminApi.get<{
        items: Array<{ id: string; enabled: boolean }>
      }>('/api/resource-library/tags')
      expect(tagsResponse.status, JSON.stringify(tagsResponse.data)).toBe(200)
      const tag = (tagsResponse.data?.items ?? []).find(item => item.enabled)
      expect(tag, 'At least one enabled marketplace tag must exist').toBeDefined()

      const dialog = await openGroupAgentEditor(page, fixture.groupName, fixture.teamId)
      const manager = await openSkillManagement(dialog)

      await manager.getByTestId('manage-skills-upload-button').click()
      const uploadDialog = page.getByTestId('skill-upload-dialog')
      await expect(uploadDialog).toBeVisible({ timeout: 15000 })

      await uploadDialog.getByTestId('capability-scope-marketplace').click()
      const tagOption = uploadDialog.getByTestId(`marketplace-tag-option-${tag!.id}`)
      await expect(tagOption).toBeVisible({ timeout: 15000 })
      await tagOption.click()

      await uploadDialog.locator('#skill-name').fill(marketplaceSkillName)
      await uploadDialog.locator('#file-input').setInputFiles({
        name: `${marketplaceSkillName}.zip`,
        mimeType: 'application/zip',
        buffer: await buildSkillZip(marketplaceSkillName, '1.0.0'),
      })

      const listingPromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return (
          response.request().method() === 'POST' &&
          url.pathname === '/api/resource-library/listings'
        )
      })
      await uploadDialog.getByTestId('skill-upload-submit-button').click()
      const listingResponse = await listingPromise
      expect([200, 201], await listingResponse.text()).toContain(listingResponse.status())

      const payload = listingResponse.request().postDataJSON() as {
        source_id: number
        resource_type: string
        tags: string[]
      }
      expect(payload.resource_type).toBe('skill')
      expect(payload.tags).toContain(tag!.id)
      fixture.createdSkillIds.push(payload.source_id)

      const createdListing = (await listingResponse.json()) as {
        id: number
        tags?: string[]
      }
      expect(createdListing.tags).toContain(tag!.id)

      const storedListing = await fixture.userApi.get<{ tags?: string[] }>(
        `/api/resource-library/listings/${createdListing.id}`
      )
      expect(storedListing.status, JSON.stringify(storedListing.data)).toBe(200)
      expect(storedListing.data?.tags).toContain(tag!.id)
    } finally {
      await context.close()
      await fixture.cleanup()
    }
  })
})
