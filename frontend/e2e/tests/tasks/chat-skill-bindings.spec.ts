// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { executorMockUrl, expect, test } from '../../fixtures/executor-test'
import { checked } from '../../fixtures/recent-team-history'
import { type ApiClient, createApiClient } from '../../utils/api-client'
import {
  collectTaskToolCalls,
  configureToolScenario,
  extractTaskAnswer,
  getScenarioModelBodies,
  getTask,
  waitForTaskTerminal,
} from '../../utils/provider-native-test-support'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const SKILL_PATH = '/api/v1/kinds/skills'

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
// Redis and Chat Shell. This test only mocks the model and uses one Chat turn.
test('Chat consumes Ghost skills and automatic bindings with legacy shell metadata', async ({
  request,
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
  } finally {
    client.dispose()
    for (const { path, status } of resources.reverse()) {
      const response = await api.delete(path)
      expect.soft(response.status, `DELETE ${path}: ${JSON.stringify(response.data)}`).toBe(status)
    }
  }
})
