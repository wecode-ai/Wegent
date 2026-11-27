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

interface Run {
  errorMessage?: string
  id: number
  agentId: string | null
  teamId: number | null
  backendTaskId: number | null
  status: string
}

interface Context {
  request: APIRequestContext
  page: Page
  info: TestInfo
  projectId: string
  projectPath: string
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
                      message: 'Inspect the release notes.',
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
          workerPrompt,
          [{ responseContent: workerResult }],
          claude ? undefined : { 'x-openai-subagent': 'collab_spawn' }
        )
      } else {
        await scenario(leadPrompt, [{ responseContent: final }])
        if (mode === 'pipeline') await scenario(workerPrompt, [{ responseContent: workerResult }])
      }
      cases.push({
        shell,
        mode,
        name,
        instructions,
        leadPrompt,
        workerPrompt,
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
        bot_ids: number[]
        role: string
        status: string
      }>
    }>(`/api/tasks/${run.backendTaskId}`)
    const turns = task.subtasks.filter(row => row.role === 'ASSISTANT')
    expect(turns.length).toBeGreaterThan(0)
    for (const turn of turns)
      expect(turn).toMatchObject({ team_id: cell.teamId, status: 'COMPLETED' })
    if (cell.mode === 'pipeline')
      expect(turns.map(turn => turn.bot_ids)).toEqual(cell.bots.map(bot => [bot.bot_id]))
    if (cell.mode === 'coordinate')
      expect(modelRequestText(await getScenarioModelBodies(request, cell.leadPrompt))).toContain(
        cell.workerResult
      )
    evidence.push({
      shell: cell.shell,
      mode: cell.mode,
      teamId: cell.teamId,
      taskId: task.id,
      executionId: run.id,
      turns,
    })
  }
  expect(new Set(evidence.map(row => row.taskId)).size).toBe(cases.length)
  await page.reload()
  await expect(page.getByTestId('cloud-todo-detail-status')).toHaveAttribute(
    'data-value',
    'in_review',
    { timeout: 60000 }
  )
  await expect(page.getByText('Native deliveries accepted.', { exact: true }).first()).toBeVisible()
  const receipts = modelRequestText((await getScenarioModelBodies(request, title)).slice(2))
  for (const cell of cases) {
    expect(receipts).toContain(cell.mode === 'pipeline' ? cell.workerResult : cell.final)
  }
  await info.attach('native-group-signed', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await info.attach('native-group-executions', {
    body: JSON.stringify({ groupId, issueId: issue.id, evidence }),
    contentType: 'application/json',
  })
}
