// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test as base } from '@playwright/test'
import type { Locator, Page, Route } from '@playwright/test'
import JSZip from 'jszip'
import { ADMIN_USER } from '../config/test-users'
import { DataBuilders } from '../fixtures/data-builders'
import { createApiClient, type ApiClient } from '../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'
import { deleteDedicatedBotModel } from '../utils/cleanup-dedicated-bot-model'

interface CreatedBot {
  id: number
  name: string
  namespace: string
}

interface MemberAgent {
  id: number
  name: string
  botId: number
  namespace: string
  group: string
}

interface MemberSkills {
  page: Page
  api: ApiClient
  agents: MemberAgent[]
  skill: { id: number; name: string }
  createdBots: CreatedBot[]
  prefix: string
}

const test = base.extend<{ memberSkills: MemberSkills }>({
  memberSkills: async ({ browser, request }, use) => {
    const admin = createApiClient(request)
    expect((await admin.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
    const prefix = 'e2e-member-skills-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const user = DataBuilders.user()
    expect((await admin.adminCreateUser(user)).status).toBe(201)
    const api = createApiClient(request)
    const login = await api.login(user.user_name, user.password, 1)
    expect(login.status).toBe(200)
    const currentUser = await api.get<{ id: number }>('/api/users/me')
    expect(currentUser.status).toBe(200)
    const userId = currentUser.data!.id
    const groups: string[] = []
    const agents: MemberAgent[] = []
    const createdBots: CreatedBot[] = []
    let skillId: number | undefined
    const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000'
    const context = await browser.newContext({
      baseURL,
      storageState: buildStorageState(
        baseURL,
        login.data!.access_token,
        getJwtExpiryMs(login.data!.access_token)
      ),
      viewport: { width: 1280, height: 900 },
    })
    await context.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
    try {
      for (const suffix of ['a', 'b']) {
        const group = DataBuilders.group({ name: prefix + '-' + suffix })
        expect((await admin.createGroup(group)).status).toBe(201)
        groups.push(group.name)
        const member = await admin.addGroupMember(group.name, {
          user_id: userId,
          role: 'Developer',
        })
        expect([200, 201]).toContain(member.status)
      }
      // The editor cannot bind another owner's personal Skill without the target group.
      const skillName = prefix + '-shared'
      const zip = new JSZip()
      zip.file(
        skillName + '/SKILL.md',
        '---\ndescription: Member drawer regression fixture\n---\n\n# Shared Skill\n'
      )
      const upload = await admin.uploadSkill({
        name: skillName,
        namespace: 'default',
        file: await zip.generateAsync({ type: 'nodebuffer' }),
      })
      expect(upload.status, JSON.stringify(upload.data)).toBe(201)
      const uploadedSkill = upload.data as { metadata: { labels: { id: string } } }
      skillId = Number(uploadedSkill.metadata.labels.id)
      expect(Number.isInteger(skillId)).toBe(true)
      expect(skillId).toBeGreaterThan(0)
      expect(
        (
          await admin.post('/api/v1/kinds/skills/' + skillId + '/bindings/groups', {
            group_names: [groups[0]],
          })
        ).status
      ).toBe(200)

      for (const [suffix, namespace, group] of [
        ['personal', 'default', groups[0]],
        ['group', groups[0], groups[0]],
        ['other', 'default', groups[1]],
      ]) {
        const bot = await api.createBot({
          name: prefix + '-' + suffix + '-bot',
          namespace,
          shell_name: 'ClaudeCode',
          agent_config: {},
          system_prompt: 'Original prompt',
          mcp_servers: {},
        })
        expect(bot.status, JSON.stringify(bot.data)).toBe(201)
        const botId = (bot.data as { id: number }).id
        createdBots.push({ id: botId, name: prefix + '-' + suffix + '-bot', namespace })
        const name = prefix + '-' + suffix + '-agent'
        const team = await api.createTeam({
          name,
          namespace,
          workflow: { mode: 'pipeline', leader_bot_id: botId },
          bots: [{ bot_id: botId, role: 'leader', bot_prompt: '' }],
          bind_mode: ['code'],
          requires_workspace: true,
        })
        expect(team.status, JSON.stringify(team.data)).toBe(201)
        const id = (team.data as { id: number }).id
        agents.push({ id, name, botId, namespace, group })
        expect(
          (
            await api.put('/api/resource-library/agents/' + id + '/bindings', {
              group_names: [group],
            })
          ).status
        ).toBe(200)
      }
      await use({
        page: await context.newPage(),
        api,
        agents,
        skill: { id: skillId, name: skillName },
        createdBots,
        prefix,
      })
    } finally {
      await context.close()
      for (const agent of agents) {
        const unbound = await api.put('/api/resource-library/agents/' + agent.id + '/bindings', {
          group_names: [],
        })
        expect(unbound.status, JSON.stringify(unbound.data)).toBe(200)
        expect(
          (
            await api.delete(
              '/api/teams/' +
                agent.id +
                '?' +
                new URLSearchParams({ force: 'true', confirm_name: agent.name })
            )
          ).status
        ).toBe(200)
      }
      for (const bot of createdBots) {
        expect((await api.delete('/api/bots/' + bot.id + '?force=true')).status).toBe(200)
        await deleteDedicatedBotModel(api, bot.name, bot.namespace)
      }
      if (skillId !== undefined) {
        for (const group of groups) {
          const unbound = await admin.delete(
            '/api/v1/kinds/skills/' +
              skillId +
              '/bindings/groups?group_name=' +
              encodeURIComponent(group)
          )
          expect([204, 404], JSON.stringify(unbound.data)).toContain(unbound.status)
        }
        expect((await admin.delete('/api/v1/kinds/skills/' + skillId)).status).toBe(204)
      }
      for (const group of groups) {
        const removed = await admin.deleteGroup(group)
        expect(removed.status, JSON.stringify(removed.data)).toBe(204)
      }
      expect((await admin.adminDeleteUser(userId)).status).toBe(204)
    }
  },
})

async function openAgent(fixture: MemberSkills, agent: MemberAgent): Promise<Locator> {
  const { page, prefix } = fixture
  const query = new URLSearchParams({
    tab: 'mine',
    type: 'agent',
    source: agent.namespace === 'default' ? 'mine' : 'group',
    keyword: prefix,
  })
  if (agent.namespace !== 'default') query.set('group', agent.namespace)
  await page.goto('/resource-library?' + query)
  await page.getByTestId('edit-team-button-' + agent.id).click()
  const dialog = page.getByTestId('team-edit-dialog')
  await expect(dialog.getByTestId('select-mode-radio-pipeline')).toBeChecked()
  return dialog
}

async function openMember(page: Page, dialog: Locator, agent: MemberAgent): Promise<Locator> {
  await dialog.getByTestId('edit-bot-button-' + agent.botId).click()
  const drawer = page.locator('[data-team-edit-drawer="true"]')
  await expect(drawer).toBeVisible()
  return drawer
}

async function closeEditors(page: Page, dialog: Locator): Promise<void> {
  const drawer = page.locator('[data-team-edit-drawer="true"]')
  await drawer.getByRole('button', { name: /^(Back|返回)$/ }).click()
  await expect(drawer).toBeHidden()
  await dialog.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
  await expect(dialog).toBeHidden()
}

test('member edit and same-namespace clones keep group Skill authority and persist', async ({
  memberSkills: f,
}) => {
  const { page, api, skill } = f
  const denied = await api.put('/api/bots/' + f.agents[0].botId, {
    skills: [skill.name],
    skill_refs: { [skill.name]: { skill_id: skill.id, namespace: 'default', is_public: false } },
  })
  expect(denied.status).toBe(403)
  for (const agent of f.agents.slice(0, 2)) {
    const dialog = await openAgent(f, agent)
    await expect(dialog.getByTestId('capability-scope-group-' + agent.group)).toBeChecked()
    const drawer = await openMember(page, dialog, agent)
    await expect(drawer.getByTestId('save-button')).toBeEnabled()
    await drawer.getByTestId('skill-selector-trigger').click()
    await expect(page.getByTestId('skill-selector-option-' + skill.id)).toBeVisible()
    await page.getByTestId('skill-selector-option-' + skill.id).click()
    const saved = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/bots/' + agent.botId
    )
    await drawer.getByTestId('save-button').click()
    const response = await saved
    expect(response.status(), await response.text()).toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({
      target_group_names: [agent.group],
      skill_refs: { [skill.name]: { skill_id: skill.id } },
    })
    await expect(drawer).toBeHidden()

    const options = page.waitForRequest(request => {
      const url = new URL(request.url())
      return (
        url.pathname.endsWith('/v1/kinds/skills') &&
        url.searchParams.get('target_group_names') === agent.group &&
        !url.searchParams.has('binding_bot_id')
      )
    })
    await dialog.getByTestId('copy-bot-button-' + agent.botId).click()
    expect(new URL((await options).url()).searchParams.get('binding_namespace')).toBe(
      agent.namespace
    )
    const cloneName = f.prefix + '-' + agent.namespace + '-clone'
    await drawer.getByPlaceholder(/^(Code Assistant|输入机器人名称)$/).fill(cloneName)
    const created = page.waitForResponse(
      response =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/bots'
    )
    await drawer.getByTestId('save-button').click()
    const cloneResponse = await created
    expect(cloneResponse.status(), await cloneResponse.text()).toBe(201)
    const cloneId = ((await cloneResponse.json()) as { id: number }).id
    f.createdBots.push({ id: cloneId, name: cloneName, namespace: agent.namespace })
    expect(cloneId).not.toBe(agent.botId)
    expect(cloneResponse.request().postDataJSON()).toMatchObject({
      target_group_names: [agent.group],
      skill_refs: { [skill.name]: { skill_id: skill.id } },
    })
    await expect(drawer).toBeHidden()

    await dialog.getByTestId('member-row-header-' + cloneId).click()
    await dialog.locator('button:has(svg.lucide-chevron-right)').click()
    await expect(dialog.getByTestId('pipeline-member-row-' + cloneId)).toBeVisible()
    const teamSaved = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/teams/' + agent.id
    )
    await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
    expect((await teamSaved).status()).toBe(200)
    await expect(dialog).toBeHidden()
    await page.reload()
    await page.getByTestId('edit-team-button-' + agent.id).click()
    await expect(dialog.getByTestId('pipeline-member-row-' + cloneId)).toBeVisible()
    for (const botId of [agent.botId, cloneId]) {
      const persisted = await api.get('/api/bots/' + botId)
      expect(persisted.status).toBe(200)
      expect(persisted.data).toMatchObject({
        namespace: agent.namespace,
        skill_refs: { [skill.name]: { skill_id: skill.id } },
      })
    }
  }
})

for (const failure of ['pending', 'failed'] as const) {
  test(
    'closing a ' + failure + ' binding load allows new member saving and later retry',
    async ({ memberSkills: f }) => {
      const { page } = f
      const agent = f.agents[0]
      let release!: () => void
      let started!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const entered = new Promise<void>(resolve => {
        started = resolve
      })
      let first = true
      const path = '**/resource-library/agents/' + agent.id + '/bindings'
      const intercept = async (route: Route) => {
        if (route.request().method() !== 'GET' || !first) return route.continue()
        first = false
        started()
        // Inject a transport fault, without replacing any Wegent service or response.
        if (failure === 'pending') await held
        await route.abort('failed')
      }
      await page.route(path, intercept)
      try {
        const dialog = await openAgent(f, agent)
        await entered
        const drawer = await openMember(page, dialog, agent)
        await expect(drawer.getByTestId('save-button')).toBeDisabled()
        if (failure === 'failed')
          await expect(drawer.getByTestId('retry-target-groups-button')).toBeVisible()
        await closeEditors(page, dialog)
        await page.getByTestId('new-capability-button').click()
        await page.getByTestId('new-capability-type-agent').click()
        await dialog.getByTestId('simple-section-advanced-trigger').click()
        await dialog.getByTestId('select-mode-label-pipeline').click()
        await dialog.getByRole('button', { name: /^(New Bot|新建机器人)$/ }).click()
        await drawer
          .getByPlaceholder(/^(Code Assistant|输入机器人名称)$/)
          .fill(f.prefix + '-after-' + failure)
        await expect(drawer.getByRole('combobox').first()).toContainText(/Codex|Claude\s*Code/)
        await expect(drawer.getByTestId('save-button')).toBeEnabled()
        await expect(drawer.getByTestId('retry-target-groups-button')).toHaveCount(0)
        const saved = page.waitForResponse(
          response =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/bots'
        )
        await drawer.getByTestId('save-button').click()
        const response = await saved
        expect(response.status(), await response.text()).toBe(201)
        f.createdBots.push((await response.json()) as CreatedBot)
        await expect(drawer).toBeHidden()
        release()
        // Drain the held abort before removing interception, which resumes pending requests.
        await page.unrouteAll({ behavior: 'wait' })

        // Reopen in the same mounted library and prove retry recovers the target group.
        await dialog.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
        await page.route(
          path,
          route => (route.request().method() === 'GET' ? route.abort('failed') : route.continue()),
          { times: 1 }
        )
        await page.getByTestId('edit-team-button-' + agent.id).click()
        await openMember(page, dialog, agent)
        await expect(drawer.getByTestId('retry-target-groups-button')).toBeVisible()
        await drawer.getByTestId('retry-target-groups-button').click()
        await expect(drawer.getByTestId('save-button')).toBeEnabled()
        await expect(drawer.getByTestId('retry-target-groups-button')).toHaveCount(0)
        await drawer.getByTestId('skill-selector-trigger').click()
        await expect(page.getByTestId('skill-selector-option-' + f.skill.id)).toBeVisible()
        await page.getByTestId('skill-selector-option-' + f.skill.id).click()
        const updated = page.waitForResponse(
          response =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname === '/api/bots/' + agent.botId
        )
        await drawer.getByTestId('save-button').click()
        const restored = await updated
        expect(restored.status(), await restored.text()).toBe(200)
        expect(restored.request().postDataJSON().target_group_names).toEqual([agent.group])
      } finally {
        release()
        await page.unrouteAll({ behavior: 'wait' })
      }
    }
  )
}

test('a late binding retry cannot overwrite another agent publication groups', async ({
  memberSkills: f,
}) => {
  const { page } = f
  const [agentA, , agentB] = f.agents
  const path = '**/resource-library/agents/' + agentA.id + '/bindings'
  let release!: () => void
  let fetched!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const received = new Promise<void>(resolve => {
    fetched = resolve
  })
  let reads = 0
  const intercept = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue()
    if (++reads === 1) return route.abort('failed')
    // Hold the actual backend response to deterministically reorder A and B.
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    fetched()
    await held
    await route.fulfill({ response })
  }
  await page.route(path, intercept)
  try {
    const dialog = await openAgent(f, agentA)
    const drawer = await openMember(page, dialog, agentA)
    await expect(drawer.getByTestId('retry-target-groups-button')).toBeVisible()
    await drawer.getByTestId('retry-target-groups-button').click()
    await received
    await closeEditors(page, dialog)
    await page.getByTestId('edit-team-button-' + agentB.id).click()
    await expect(dialog.getByTestId('capability-scope-group-' + agentB.group)).toBeChecked()
    const late = page.waitForResponse(
      response =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/agents/' + agentA.id + '/bindings')
    )
    release()
    expect((await late).status()).toBe(200)
    await openMember(page, dialog, agentB)
    await expect(drawer.getByTestId('save-button')).toBeEnabled()
    const saved = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/bots/' + agentB.botId
    )
    await drawer.getByTestId('save-button').click()
    const response = await saved
    expect(response.status(), await response.text()).toBe(200)
    expect(response.request().postDataJSON().target_group_names).toEqual([agentB.group])
    await expect(dialog.getByTestId('capability-scope-group-' + agentB.group)).toBeChecked()
    await expect(dialog.getByTestId('capability-scope-group-' + agentA.group)).not.toBeChecked()
    const persisted = await f.api.get<{ group_names: string[] }>(
      '/api/resource-library/agents/' + agentB.id + '/bindings'
    )
    expect(persisted.status).toBe(200)
    expect(persisted.data!.group_names).toEqual([agentB.group])
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
})
