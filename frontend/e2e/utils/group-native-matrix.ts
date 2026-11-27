// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { createCollaborationGroup } from './issue-dispatch-test-support'
import { selectCollaborationProjectView } from './collaboration-test-support'
import {
  configureToolScenario,
  getScenarioModelBodies,
  modelRequestText,
  PROVIDER_NATIVE_MOCK_URL,
  type ToolScenarioStep,
} from './provider-native-test-support'

import {
  createGroupBotCapability,
  groupBotProbe,
  verifyGroupBotProbe,
} from './group-bot-capabilities'

interface Run {
  errorMessage?: string
  id: number
  agentId: string | null
  teamId: number | null
  backendTaskId: number | null
  status: string
}

interface Context {
  client: import('./api-client').ApiClient
  skillCleanup: number[]
  request: APIRequestContext
  page: Page
  info: TestInfo
  projectId: string
  projectPath: string
  leaderName: string
  leader: { id: string; wegentTeamId: number }
  suffix: string
  cleanup: string[]
  configuredPrompts: Set<string>
  api<T>(path: string, data?: unknown): Promise<T>
  assign(issueId: string, value: string): Promise<void>
  executions(issueId: string): Promise<Run[]>
}

export async function verifyGroupNativeMatrix(ctx: Context) {
  const { api, request, page, info, projectId, projectPath, leader, suffix } = ctx
  const cases = []
  const lead = await createGroupBotCapability(ctx.client, 'leader', suffix, ctx.skillCleanup)
  const worker = await createGroupBotCapability(ctx.client, 'worker', suffix, ctx.skillCleanup)
  async function scenario(
    key: string,
    steps: ToolScenarioStep[],
    headers?: Record<string, string>
  ) {
    ctx.configuredPrompts.add(key)
    await configureToolScenario(request, key, steps, { matchHeaders: headers })
  }
  for (const shell of ['ClaudeCode', 'Codex'] as const) {
    const model = `group-${shell.toLowerCase()}-${suffix}`
    const claude = shell === 'ClaudeCode'
    const providerUrl =
      (claude ? process.env.E2E_CLAUDE_MODEL_SERVER_URL : process.env.E2E_CODEX_MODEL_SERVER_URL) ||
      PROVIDER_NATIVE_MOCK_URL
    const shellName = `${model}-shell`
    await api('/api/shells', {
      name: shellName,
      baseShellRef: shell,
      baseImage: process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest',
    })
    ctx.cleanup.unshift(`shells/${shellName}`)
    await api('/api/v1/namespaces/default/models', {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: { name: model, namespace: 'default' },
      spec: {
        protocol: claude ? 'claude' : 'openai-responses',
        modelConfig: {
          env: {
            model: claude ? 'claude' : 'openai',
            model_id: claude ? 'claude-3-5-sonnet-20241022' : 'gpt-5.1-codex',
            api_key: 'mock-api-key',
            base_url: `${providerUrl}/v1`,
          },
        },
      },
    })
    ctx.cleanup.unshift(`models/${model}`)
    for (const mode of ['solo', 'pipeline', 'coordinate'] as const) {
      const name = `${model}-${mode}`
      const instructions = `Carry out ${name}`
      const leadPrompt = `Lead native execution for ${name}`
      const workerPrompt = `Handle delegated work for ${name}`
      const assignment = `Inspect the release notes for ${name}`
      const workerResult = `Worker delivery ${name}`
      const final = `Finished ${name}`
      const bots = []
      for (const role of mode === 'solo' ? ['leader'] : ['leader', 'worker']) {
        const botName = `${name}-${role}`
        const bot = await api<{ id: number }>('/api/bots', {
          name: botName,
          namespace: 'default',
          shell_name: shellName,
          system_prompt: role === 'worker' ? workerPrompt : leadPrompt,
          agent_config: { bind_model: model, bind_model_type: 'user' },
          inherit_base_capabilities: false,
          ...(mode === 'pipeline' && role === 'worker' ? worker : lead).config,
        })
        ctx.cleanup.unshift(`bots/${botName}`)
        bots.push({ bot_id: bot.id, role, requireConfirmation: false, contextPassing: 'none' })
      }
      const team = await api<{ id: number }>('/api/teams', {
        name,
        namespace: 'default',
        bots,
        ...(mode === 'solo' ? {} : { workflow: { mode, leader_bot_id: bots[0].bot_id } }),
        requires_workspace: false,
        bind_mode: ['chat'],
      })
      ctx.cleanup.unshift(`teams/${name}`)
      const agent = await api<{ id: string; wegentTeamId: number }>(
        `/api/v1/cloud-projects/${projectId}/chat-agents`,
        {
          name,
          runtime: 'wegent',
          wegent_team_id: team.id,
          share_with_workspace: true,
        }
      )
      expect(agent.wegentTeamId).toBe(team.id)
      if (mode === 'coordinate') {
        const type = `${name}-worker-${bots[1].bot_id}`
        await scenario(leadPrompt, [
          ...groupBotProbe(shell, lead, worker),
          {
            toolCalls: [
              claude
                ? {
                    toolName: 'Agent',
                    arguments: {
                      subagent_type: type,
                      description: 'Review',
                      prompt: 'Inspect the release notes.',
                    },
                  }
                : {
                    toolName: 'spawn_agent',
                    arguments: {
                      task_name: 'review',
                      agent_type: type,
                      message: assignment,
                      fork_turns: 'none',
                    },
                  },
            ],
          },
          ...(claude
            ? []
            : [{ toolCalls: [{ toolName: 'wait_agent', arguments: { timeout_ms: 10000 } }] }]),
          { responseContent: final },
        ])
        await scenario(
          claude ? workerPrompt : assignment,
          [...groupBotProbe(shell, lead, worker), { responseContent: workerResult }],
          claude ? undefined : { 'x-openai-subagent': 'collab_spawn' }
        )
      } else {
        await scenario(leadPrompt, [
          ...groupBotProbe(shell, lead, worker),
          { responseContent: final },
        ])
        if (mode === 'pipeline')
          await scenario(workerPrompt, [
            ...groupBotProbe(shell, worker, lead),
            { responseContent: workerResult },
          ])
      }
      cases.push({
        shell,
        mode,
        name,
        instructions,
        leadPrompt,
        workerPrompt,
        assignment,
        workerResult,
        final,
        bots,
        teamId: team.id,
        agentId: agent.id,
      })
    }
  }
  await page.goto(projectPath)
  await selectCollaborationProjectView(page, 'manage')
  const groupId = await createCollaborationGroup(page, `Native release ${suffix}`, {
    agentIds: [leader.wegentTeamId, ...cases.map(cell => cell.teamId)].map(String),
    humanId: '',
    leader: { id: String(leader.wegentTeamId), type: 'agent' },
  })
  await info.attach('native-group-members', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  const title = `Native dispatch round ${suffix}`
  const issue = await api<{ id: string }>(`/api/v1/cloud-projects/${projectId}/loop-items`, {
    title,
    status: 'pending',
    priority: 'high',
  })
  await scenario(title, [
    {
      toolCalls: [
        {
          toolName: 'wegent-wework-space_submit_workflow_plan',
          arguments: {
            plan: {
              round_id: 'native',
              summary: 'Run all six Teams',
              items: cases.map(cell => ({
                assignment_id: cell.name,
                title: cell.name,
                instructions: cell.instructions,
                assignee_type: 'agent',
                assignee_id: cell.agentId,
              })),
            },
          },
        },
      ],
    },
    { responseContent: 'Waiting for all six deliveries.' },
    {
      toolCalls: [
        {
          toolName: 'wegent-wework-space_update_issue_status',
          arguments: {
            idempotency_key: 'accept-native',
            target_status: 'in_review',
            reason: 'All Teams delivered',
            comment: 'Native deliveries accepted.',
          },
        },
      ],
    },
    { responseContent: 'Accepted.' },
  ])
  await ctx.assign(issue.id, `group:${groupId}`)
  await expect
    .poll(
      async () => {
        const rows = await ctx.executions(issue.id)
        const failed = rows.find(row => ['failed', 'cancelled'].includes(row.status))
        if (failed)
          throw new Error(
            `Group execution ${failed.id} for Team ${failed.teamId} ended ${failed.status}: ${failed.errorMessage ?? ''}`
          )
        return rows.filter(row => row.status === 'completed' && row.agentId !== leader.id).length
      },
      {
        timeout: 240000,
        message: 'All six native member executions must complete',
      }
    )
    .toBe(cases.length)
  const rows = await ctx.executions(issue.id)
  const evidence = []
  for (const cell of cases) {
    const members = rows.filter(row => row.agentId === cell.agentId)
    expect(members).toHaveLength(1)
    const [run] = members
    expect(run).toMatchObject({ teamId: cell.teamId, status: 'completed' })
    expect(run.backendTaskId).toBeGreaterThan(0)
    const task = await api<{
      id: number
      subtasks: Array<{
        id: number
        team_id: number
        executor_name: string
        bots: Array<{ id: number; shell_type: string }>
        bot_ids: number[]
        role: string
        status: string
      }>
    }>(`/api/tasks/${run.backendTaskId}`)
    const turns = task.subtasks.filter(row => row.role === 'ASSISTANT')
    expect(turns.length).toBeGreaterThan(0)
    for (const turn of turns) {
      expect(turn).toMatchObject({ team_id: cell.teamId, status: 'COMPLETED' })
      expect(turn.executor_name).toMatch(/^wegent-task-/)
      expect(turn.bots.map(bot => bot.shell_type)).toEqual(turn.bot_ids.map(() => cell.shell))
    }
    if (cell.mode === 'pipeline' || cell.mode === 'solo')
      expect(turns.map(turn => turn.bot_ids)).toEqual(cell.bots.map(bot => [bot.bot_id]))
    if (cell.mode === 'coordinate')
      expect(modelRequestText(await getScenarioModelBodies(request, cell.leadPrompt))).toContain(
        cell.workerResult
      )
    if (cell.mode === 'coordinate' && cell.shell === 'Codex')
      expect(modelRequestText(await getScenarioModelBodies(request, cell.assignment))).toContain(
        cell.workerPrompt
      )
    const capabilities = []
    for (const [index, bot] of cell.bots.entries()) {
      const workerStage = index === 1 && cell.mode === 'pipeline'
      const key =
        index === 0
          ? cell.leadPrompt
          : cell.mode === 'coordinate' && cell.shell === 'Codex'
            ? cell.assignment
            : cell.workerPrompt
      const captured = await getScenarioModelBodies(request, key)
      capabilities.push({
        botId: bot.bot_id,
        role: bot.role,
        ...verifyGroupBotProbe(captured, workerStage ? worker : lead, workerStage ? lead : worker),
      })
    }
    expect(new Set(capabilities.map(row => row.receipt)).size).toBe(cell.bots.length)
    evidence.push({
      capabilities,
      shell: cell.shell,
      mode: cell.mode,
      teamId: cell.teamId,
      taskId: task.id,
      executionId: run.id,
      turns: turns.map(({ bots, ...turn }) => ({
        id: turn.id,
        teamId: turn.team_id,
        botIds: turn.bot_ids,
        status: turn.status,
        executorName: turn.executor_name,
        shells: bots.map(bot => bot.shell_type),
      })),
    })
  }
  expect(new Set(evidence.map(row => row.taskId)).size).toBe(cases.length)
  await page.reload()
  await expect(page.getByTestId('cloud-todo-detail-status')).toHaveAttribute(
    'data-value',
    'in_review',
    { timeout: 60000 }
  )
  const signoff = page
    .locator('[data-testid^="cloud-task-activity-card-"]')
    .filter({ hasText: ctx.leaderName })
    .filter({ hasText: 'Native deliveries accepted.' })
  await expect(signoff).toHaveCount(1)
  await expect(signoff).toBeVisible()
  await expect
    .poll(async () =>
      (await ctx.executions(issue.id))
        .filter(row => row.agentId === leader.id)
        .map(row => row.status)
    )
    .toEqual(['completed'])
  const [manager] = (await ctx.executions(issue.id)).filter(row => row.agentId === leader.id)
  expect(manager.backendTaskId).toBeGreaterThan(0)
  const receipts = modelRequestText((await getScenarioModelBodies(request, title)).slice(2))
  for (const cell of cases) {
    expect(receipts).toContain(cell.mode === 'pipeline' ? cell.workerResult : cell.final)
  }
  await info.attach('native-group-signed', {
    body: await signoff.screenshot(),
    contentType: 'image/png',
  })
  await info.attach('native-group-executions', {
    body: JSON.stringify({ groupId, issueId: issue.id, manager, evidence }),
    contentType: 'application/json',
  })

  const native = cases.filter(cell => cell.mode === 'coordinate')
  for (const cell of native) {
    const updated = await ctx.client.put(`/api/bots/${cell.bots[1].bot_id}`, worker.config)
    expect(updated.status).toBe(200)
  }
  const deniedTitle = `Verify distinct native role grants ${suffix}`
  const denied = await api<{ id: string }>(`/api/v1/cloud-projects/${projectId}/loop-items`, {
    title: deniedTitle,
    status: 'pending',
    priority: 'high',
  })
  await scenario(deniedTitle, [
    {
      toolCalls: [
        {
          toolName: 'wegent-wework-space_submit_workflow_plan',
          arguments: {
            plan: {
              round_id: 'isolation',
              summary: 'Check distinct role grants',
              items: native.map(cell => ({
                assignment_id: cell.name,
                title: cell.name,
                instructions: cell.instructions,
                assignee_type: 'agent',
                assignee_id: cell.agentId,
              })),
            },
          },
        },
      ],
    },
    { responseContent: 'Waiting for both capability checks.' },
  ])
  await ctx.assign(denied.id, `group:${groupId}`)
  const failures = async () =>
    (await ctx.executions(denied.id)).filter(row => row.agentId !== leader.id)
  await expect
    .poll(async () => (await failures()).filter(row => row.status === 'failed').length, {
      timeout: 90000,
      message: 'Both native member Teams must reject distinct role grants before running a Bot',
    })
    .toBe(native.length)
  const rejected = await failures()
  for (const cell of native) {
    const rows = rejected.filter(row => row.agentId === cell.agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].teamId).toBe(cell.teamId)
    expect(rows[0].errorMessage).toContain(
      'native subagents cannot isolate distinct Bot tool grants'
    )
  }
  await info.attach('native-group-role-grant-rejections', {
    body: JSON.stringify({ groupId, issueId: denied.id, rejected }),
    contentType: 'application/json',
  })
  for (const row of await ctx.executions(denied.id)) {
    if (row.agentId === leader.id && !['completed', 'failed', 'cancelled'].includes(row.status))
      await api(`/api/v1/cloud-projects/${projectId}/executions/${row.id}/stop`, {})
  }
}
