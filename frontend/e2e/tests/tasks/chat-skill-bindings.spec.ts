// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import type { Locator } from '@playwright/test'
import JSZip from 'jszip'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { executorMockUrl, expect, test } from '../../fixtures/executor-test'
import { checked } from '../../fixtures/recent-team-history'
import { type ApiClient, createApiClient } from '../../utils/api-client'
import {
  clearToolScenario,
  collectTaskToolCalls,
  configureToolScenario,
  extractTaskAnswer,
  getScenarioModelBodies,
  getTask,
  waitForTaskTerminal,
} from '../../utils/provider-native-test-support'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const SKILL_PATH = '/api/v1/kinds/skills'
const LAYOUT_TIMEOUT = 5_000

async function expectSlashMenuPlacement(menu: Locator, label: string, side?: 'above' | 'below') {
  await expect(menu, `${label}: the slash menu should open`).toBeVisible({
    timeout: LAYOUT_TIMEOUT,
  })
  await expect
    .poll(
      () =>
        menu.evaluate(element => {
          const selection = window.getSelection()
          if (!selection?.isCollapsed || !selection.rangeCount) return null

          const caret = selection.getRangeAt(0).getBoundingClientRect()
          const rect = element.getBoundingClientRect()
          const viewport = window.visualViewport
          const left = viewport?.offsetLeft ?? 0
          const top = viewport?.offsetTop ?? 0
          const width = viewport?.width ?? window.innerWidth
          const height = viewport?.height ?? window.innerHeight
          const middle = top + height / 2
          return {
            caretHalf: caret.top < middle ? 'upper' : 'lower',
            menuSide:
              rect.bottom <= caret.top - 7
                ? 'above'
                : rect.top >= caret.bottom + 7
                  ? 'below'
                  : 'overlap',
            withinViewport:
              rect.left >= left + 7 &&
              rect.right <= left + width - 7 &&
              rect.top >= top + 7 &&
              rect.bottom <= top + height - 7,
          }
        }),
      { message: `${label}: the menu should fit and avoid the live caret`, timeout: LAYOUT_TIMEOUT }
    )
    .toMatchObject(
      side
        ? { caretHalf: side === 'above' ? 'lower' : 'upper', menuSide: side, withinViewport: true }
        : { menuSide: expect.stringMatching(/^(above|below)$/), withinViewport: true }
    )
}

async function uploadSkill(api: ApiClient, name: string, marker: string): Promise<number> {
  const zip = new JSZip()
  zip.file(
    `${name}/SKILL.md`,
    ['---', 'description: E2E Chat skill', 'bindShells: [ClaudeCode]', '---', '', marker].join('\n')
  )
  const skill = checked(
    await api.uploadSkill({
      name,
      namespace: 'default',
      file: await zip.generateAsync({ type: 'nodebuffer' }),
    }),
    201
  ) as { metadata: { labels: { id: string } }; spec: { bindShells: string[] } }
  expect(skill.spec.bindShells).toEqual(['ClaudeCode'])
  const id = Number(skill.metadata.labels.id)
  expect(id).toBeGreaterThan(0)
  return id
}

// The existing sharded Chromium project provides real Rust Socket.IO, MySQL,
// Redis and Chat Shell. This test only mocks the model.
test('Chat consumes Ghost skills and automatic bindings with legacy shell metadata', async ({
  request,
  page,
  executorAccount,
}) => {
  test.setTimeout(90_000)
  const { token } = executorAccount
  const api = createApiClient(request, API_URL, token)
  const resources: Array<{ path: string; status: number }> = []
  const prefix = `e2e-chat-skills-${randomUUID().slice(0, 8)}`
  const skills = ['ghost-preload', 'ghost-on-demand', 'binding-preload', 'binding-on-demand'].map(
    variant => ({ name: `${prefix}-${variant}`, marker: `SKILL_CONTENT_${randomUUID()}` })
  )
  const [ghostPreload, ghostOnDemand, bindingPreload, bindingOnDemand] = skills
  const preloaded = [ghostPreload, bindingPreload]
  const onDemand = [ghostOnDemand, bindingOnDemand]
  const skillIds = new Map<string, number>()
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => API_URL,
    getToken: () => token,
    namespace: '/chat',
  })

  try {
    for (const { name, marker } of skills) {
      const id = await uploadSkill(api, name, marker)
      skillIds.set(name, id)
      resources.push({ path: `${SKILL_PATH}/${id}`, status: 204 })
    }
    // Personal uploads enable defaults. Keep the Ghost skills exclusive to
    // the Ghost so a default binding cannot mask a broken Ghost lookup.
    for (const { name } of [ghostPreload, ghostOnDemand]) {
      const path = `${SKILL_PATH}/${skillIds.get(name)}/bindings/me`
      expect((await api.delete(path)).status).toBe(204)
    }
    for (const skill of [bindingPreload, bindingOnDemand]) {
      const path = `${SKILL_PATH}/${skillIds.get(skill.name)}/bindings/me`
      resources.push({ path, status: 204 })
      const forcePreload = skill === bindingPreload
      const updated = await request.patch(`${API_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { exceptions: [], force_preload: forcePreload },
      })
      expect(updated.ok(), await updated.text()).toBe(true)
      expect(await updated.json()).toMatchObject({ force_preload: forcePreload })
    }
    const bindings = checked(
      await api.get<Array<{ skill_ref: { skill_id: number } }>>(`${SKILL_PATH}/bindings/me`)
    )
    const fixtureIds = new Set(skillIds.values())
    expect(
      new Set(bindings.map(binding => binding.skill_ref.skill_id).filter(id => fixtureIds.has(id)))
    ).toEqual(new Set([skillIds.get(bindingPreload.name), skillIds.get(bindingOnDemand.name)]))

    checked(
      await api.post('/api/v1/namespaces/default/models', {
        kind: 'Model',
        metadata: { name: prefix, namespace: 'default' },
        spec: {
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'mock-chat-skills',
              api_key: 'mock-api-key',
              base_url: `${executorMockUrl()}/v1`,
            },
          },
        },
      }),
      201
    )
    resources.push({ path: `/api/v1/namespaces/default/models/${prefix}`, status: 200 })
    const skillRefs = Object.fromEntries(
      [ghostPreload, ghostOnDemand].map(({ name }) => [
        name,
        { skill_id: skillIds.get(name), namespace: 'default', is_public: false },
      ])
    )
    const bot = checked(
      await api.post<{ id: number }>('/api/bots', {
        name: prefix,
        namespace: 'default',
        shell_name: 'Chat',
        agent_config: { bind_model: prefix, bind_model_type: 'user' },
        system_prompt: 'Load the requested skills and report their markers.',
        skills: Object.keys(skillRefs),
        skill_refs: skillRefs,
        preload_skills: [ghostPreload.name],
        preload_skill_refs: { [ghostPreload.name]: skillRefs[ghostPreload.name] },
      }),
      201
    )
    resources.push({ path: `/api/bots/${bot.id}`, status: 200 })
    const team = checked(
      await api.post<{ id: number }>('/api/teams', {
        name: prefix,
        namespace: 'default',
        bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
        bind_mode: ['chat'],
        requires_workspace: false,
      }),
      201
    )
    resources.push({ path: `/api/v1/namespaces/default/teams/${prefix}`, status: 200 })

    const prompt = `Load the on-demand skills and report all four markers for ${prefix}.`
    const answer = skills.map(skill => skill.marker).join(' ')
    await configureToolScenario(request, prompt, [
      {
        toolCalls: onDemand.map(({ name }) => ({
          toolName: 'load_skill',
          arguments: { skill_name: name },
        })),
      },
      { responseContent: answer },
    ])
    await client.ensureConnected()
    const ack = (await client.getRawSocket()!.timeout(10_000).emitWithAck('chat:send', {
      team_id: team.id,
      task_type: 'chat',
      message: prompt,
    })) as { task_id: number; error?: string }
    expect(ack.error).toBeUndefined()
    expect(ack.task_id).toBeGreaterThan(0)
    resources.push({ path: `/api/tasks/${ack.task_id}`, status: 200 })
    await waitForTaskTerminal(token, ack.task_id, /^COMPLETED$/)

    const [initial, afterLoad] = await getScenarioModelBodies(request, prompt)
    const initialText = JSON.stringify(initial)
    const afterLoadText = JSON.stringify(afterLoad)
    for (const { marker } of preloaded) {
      expect(initialText).toContain(marker)
    }
    for (const { name, marker } of onDemand) {
      expect(initialText).toContain(name)
      expect(initialText).not.toContain(marker)
      expect(afterLoadText).toContain(marker)
    }

    const task = await getTask(request, token, ack.task_id)
    const loads = collectTaskToolCalls(task).filter(call => call.name === 'load_skill')
    for (const { name } of onDemand) {
      expect(loads).toContainEqual(
        expect.objectContaining({
          input: { skill_name: name },
          output: expect.stringContaining(`Skill '${name}' has been loaded.`),
        })
      )
    }
    expect(extractTaskAnswer(task)).toBe(answer)

    const followUp = `Use the selected skill for the follow-up in ${prefix}.`
    const followUpAnswer = `FOLLOW_UP_${prefix}`
    // The mock matches against the entire message history, including the first prompt.
    await clearToolScenario(request, prompt)
    await configureToolScenario(request, followUp, [{ responseContent: followUpAnswer }])
    await page.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
    await page.goto(`/chat?taskId=${ack.task_id}`, { waitUntil: 'domcontentloaded' })
    // The existing task briefly renders a disabled composer while it loads.
    const input = page.getByTestId('message-input').and(page.locator('[contenteditable="true"]'))
    await expect(input, 'The existing task composer should be editable').toBeEditable({
      timeout: 15_000,
    })
    await expect(
      page.getByText(answer, { exact: true }),
      'The existing task should be loaded'
    ).toBeVisible({
      timeout: 10_000,
    })
    const moreActions = page.getByTestId('desktop-input-more-actions-button')
    await moreActions.click({ timeout: 5_000 })
    const skillPicker = page.getByTestId('desktop-input-more-actions-menu').getByRole('button', {
      name: /^(Skills|技能)$/,
    })
    await expect(skillPicker, 'The composer should have loaded the skill catalog').toBeEnabled({
      timeout: 5_000,
    })
    await skillPicker.press('Escape')
    await expect(skillPicker).toBeHidden({ timeout: 5_000 })
    await input.pressSequentially(`/${ghostOnDemand.name}`)
    const option = page.getByTestId('slash-skill-option').filter({ hasText: ghostOnDemand.name })
    await expect(option, 'The agent skill should be selectable on a follow-up').toBeVisible({
      timeout: 5_000,
    })
    const menu = page.getByTestId('slash-skill-menu')
    await expectSlashMenuPlacement(menu, 'Existing task', 'above')
    await input.press('Enter')
    await expect(option).toBeHidden()
    await expect(input).toHaveText('')
    await input.fill(followUp)
    await page.getByTestId('send-button').click()
    await expect(page.getByText(followUpAnswer, { exact: true })).toBeVisible({ timeout: 20_000 })
    const [followUpBody] = await getScenarioModelBodies(request, followUp)
    const modelMessages = followUpBody?.messages as Array<{ content: unknown }> | undefined
    const context = modelMessages
      ?.map(({ content }) => JSON.stringify(content) ?? '')
      .find(content => content.includes('Loaded Skill Instructions'))
    expect(context).toContain(ghostOnDemand.marker)
    expect(
      context?.match(/The user has explicitly selected .* for this task: ([^*]+)/)?.[1]
    ).toContain(ghostOnDemand.name)

    await test.step('Keep slash autocomplete in view in the new task composer', async () => {
      await page.setViewportSize({ width: 1280, height: 1440 })
      await page.goto(`/chat?teamId=${team.id}`, { waitUntil: 'domcontentloaded' })
      await expect(input, 'The new task composer should use the fixture team').toHaveAttribute(
        'data-team-id',
        String(team.id),
        { timeout: 10_000 }
      )
      const command = `/${ghostOnDemand.name}`
      await input.pressSequentially(command, { timeout: LAYOUT_TIMEOUT })
      await expect(option, 'The fixture skill should be offered on a new task').toBeVisible({
        timeout: LAYOUT_TIMEOUT,
      })
      await expectSlashMenuPlacement(menu, 'New task', 'below')

      await page.setViewportSize({ width: 360, height: 760 })
      const draft = Array.from({ length: 24 }, () => 'Draft text').join('\n')
      await input.fill(`\n${draft}`, { timeout: LAYOUT_TIMEOUT })
      await input.evaluate(editor => {
        const range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(true)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        editor.closest('.custom-scrollbar')!.scrollTop = 0
      })
      await input.pressSequentially(command, { timeout: LAYOUT_TIMEOUT })
      await expect(option, 'The fixture skill should be offered on a narrow viewport').toBeVisible({
        timeout: LAYOUT_TIMEOUT,
      })
      await expectSlashMenuPlacement(menu, 'Narrow viewport')

      const scrollEditor = (toEnd: boolean) =>
        input.evaluate((editor, toEnd) => {
          const viewport = editor.closest('.custom-scrollbar')!
          viewport.scrollTop = toEnd ? viewport.scrollHeight : 0
          const caret = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
          return caret.bottom <= viewport.getBoundingClientRect().top
        }, toEnd)
      expect(await scrollEditor(true), 'The live caret should scroll above the editor').toBe(true)
      await expect(menu, 'The slash menu should hide when its caret scrolls out').toBeHidden({
        timeout: LAYOUT_TIMEOUT,
      })
      await scrollEditor(false)
      await expectSlashMenuPlacement(menu, 'Caret scrolled back into the editor')
    })
  } finally {
    client.dispose()
    for (const { path, status } of resources.reverse()) {
      const response = await api.delete(path)
      expect.soft(response.status, `DELETE ${path}: ${JSON.stringify(response.data)}`).toBe(status)
    }
  }
})
