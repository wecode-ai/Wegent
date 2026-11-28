// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { connectChat } from './project-mention-test-support'
import { verifySameSourceTeams } from './same-source-team'
import { scopedMockUrl } from './mock-scope'
import { createCollaborationGroup } from './issue-dispatch-test-support'
import { selectCollaborationProjectView } from './collaboration-test-support'
import {
  clearToolScenario,
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
  token: string
  put<T>(path: string, data: unknown): Promise<T>
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
  const scripts = new Map<string, { steps: ToolScenarioStep[]; headers?: Record<string, string> }>()
  async function scenario(
    key: string,
    steps: ToolScenarioStep[],
    headers?: Record<string, string>
  ) {
    scripts.set(key, { steps, headers })
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
        isWeworkAvailable: !claude,
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
                      run_in_background: true,
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
            ? [{ responseContent: 'Waiting for the delegated review.' }]
            : [{ toolCalls: [{ toolName: 'wait_agent', arguments: { timeout_ms: 10000 } }] }]),
          { responseContent: final },
        ])
        await scenario(
          workerPrompt,
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
      expect(modelRequestText(await getScenarioModelBodies(request, cell.workerPrompt))).toContain(
        cell.assignment
      )
    const capabilities = []
    for (const [index, bot] of cell.bots.entries()) {
      const workerStage = index === 1 && cell.mode === 'pipeline'
      const key = index === 0 ? cell.leadPrompt : cell.workerPrompt
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

  const shared = cases.filter(cell => cell.shell === 'Codex' && cell.mode !== 'solo')
  async function replay(cell: { leadPrompt: string; workerPrompt: string }) {
    for (const action of [
      {
        arguments: { issue_number: 7, owner: 'group', repo: 'release' },
        server: lead.serverId,
        tool: 'mcp_tool_call',
        tool_name: lead.tool,
      },
      {
        arguments: { code: '6 * 14' },
        server: worker.serverId,
        tool: 'mcp_tool_call',
        tool_name: worker.tool,
      },
    ]) {
      const responseContent = JSON.stringify({
        risk_level: 'low',
        user_authorization: 'high',
        outcome: 'allow',
        rationale: 'Run the assigned isolated fixture tool with the specified test arguments.',
      })
      await scenario(JSON.stringify(action, null, 2), [{ responseContent }, { responseContent }], {
        'x-openai-subagent': 'guardian',
      })
    }
    for (const key of [cell.leadPrompt, cell.workerPrompt]) {
      const script = scripts.get(key)!
      await configureToolScenario(request, key, script.steps, { matchHeaders: script.headers })
    }
  }
  const sharedResult = await verifySameSourceTeams(shared, {
    page,
    projectId,
    token: ctx.token,
    model: 'group-codex-' + suffix,
    grants: [lead.config, worker.config],
    api,
    put: ctx.put,
    prepare: replay,
    async receipts(cell) {
      return Promise.all(
        [cell.leadPrompt, cell.workerPrompt].map(async (key, index) => {
          const second = cell.mode === 'pipeline' && index === 1
          return verifyGroupBotProbe(
            await getScenarioModelBodies(request, key),
            second ? worker : lead,
            second ? lead : worker
          ).receipt
        })
      )
    },
  })
  const executions = []
  for (const delivery of sharedResult.deliveries) {
    const project = evidence.find(row => row.teamId === delivery.teamId)!
    expect(
      new Set([
        ...delivery.personalReceipts,
        ...delivery.platformReceipts,
        ...project.capabilities.map(bot => bot.receipt),
      ]).size
    ).toBe(6)
    expect(project.taskId).not.toBe(delivery.platformTaskId)
    executions.push({ ...delivery, ordinaryGroup: { groupId, issueId: issue.id, ...project } })
  }
  const adopter = shared.find(cell => cell.mode === 'coordinate')!
  const reviewer = shared.find(cell => cell.mode === 'pipeline')!
  const adoptedTitle = 'Verify adopted release ' + sharedResult.sourceId
  const adoptedIssue = await api<{ id: string }>(`/api/v1/cloud-projects/${projectId}/loop-items`, {
    title: adoptedTitle,
    status: 'pending',
    priority: 'high',
  })

  await clearToolScenario(request, adopter.workerPrompt)
  await replay(reviewer)
  await configureToolScenario(request, adopter.leadPrompt, [
    {
      toolCalls: [
        {
          toolName: 'wework_space__submit_workflow_plan',
          arguments: {
            plan: {
              round_id: 'adopted',
              summary: 'Review both release stages',
              items: [
                {
                  assignment_id: reviewer.name,
                  title: reviewer.name,
                  instructions: reviewer.instructions,
                  assignee_type: 'agent',
                  assignee_id: reviewer.agentId,
                },
              ],
            },
          },
        },
      ],
    },
    { responseContent: 'Waiting for both release stages.' },
    {
      toolCalls: [
        {
          toolName: 'wework_space__update_issue_status',
          arguments: {
            idempotency_key: 'accept-adopted',
            target_status: 'in_review',
            reason: 'Both stages delivered',
            comment: 'Accepted ' + sharedResult.sourceId,
          },
        },
      ],
    },
    { responseContent: 'Accepted.' },
  ])
  const adoptedId = sharedResult.adoption.group_id
  await ctx.assign(adoptedIssue.id, 'group:' + adoptedId)
  await expect
    .poll(
      async () => {
        const runs = await ctx.executions(adoptedIssue.id)
        const failure = runs.find(run => ['cancelled', 'failed'].includes(run.status))
        if (failure)
          throw Error(
            'Adopted group ' + adoptedId + ' execution ' + failure.id + ' ' + failure.errorMessage
          )
        return runs
          .filter(r => r.status === 'completed')
          .map(r => r.teamId)
          .sort()
      },
      { timeout: 120000, message: 'Adopted group manager and Pipeline must finish ' + adoptedId }
    )
    .toEqual([adopter.teamId, reviewer.teamId].sort())
  await expect
    .poll(
      async () => (await api<{ status: string }>('/api/v1/loop-items/' + adoptedIssue.id)).status
    )
    .toBe('in_review')
  const accepted = modelRequestText(
    (await getScenarioModelBodies(request, adopter.leadPrompt)).slice(2)
  )
  expect(accepted).toContain(reviewer.workerResult)
  const adoptedRuns = await ctx.executions(adoptedIssue.id)
  const member = adoptedRuns.find(r => r.agentId === reviewer.agentId)!
  const managerRun = adoptedRuns.find(r => r.agentId === adopter.agentId)!
  expect(member.backendTaskId).toBeGreaterThan(0)
  expect(managerRun.backendTaskId).toBeGreaterThan(0)
  const task = await api<{
    subtasks: { role: string; team_id: number; bot_ids: number[]; status: string }[]
  }>('/api/tasks/' + member.backendTaskId)
  expect(task.subtasks.filter(t => t.role === 'ASSISTANT')).toMatchObject(
    reviewer.bots.map(b => ({ team_id: reviewer.teamId, bot_ids: [b.bot_id], status: 'COMPLETED' }))
  )
  const adoptedCapabilities = await Promise.all(
    [reviewer.leadPrompt, reviewer.workerPrompt].map(async (key, index) => ({
      botId: reviewer.bots[index].bot_id,
      ...verifyGroupBotProbe(
        await getScenarioModelBodies(request, key),
        index ? worker : lead,
        index ? lead : worker
      ),
    }))
  )
  const earlier = executions.find(row => row.teamId === reviewer.teamId)!
  expect(
    new Set([
      ...earlier.personalReceipts,
      ...earlier.platformReceipts,
      ...earlier.ordinaryGroup.capabilities.map(bot => bot.receipt),
      ...adoptedCapabilities.map(bot => bot.receipt),
    ]).size
  ).toBe(8)
  const chat = connectChat(ctx.token)
  let signoffActivity
  try {
    const { snapshot } = await chat.subscribe(projectId, adoptedIssue.id, 0, () => {})
    const signed = snapshot.messages.filter(
      message =>
        message.metadata.activity_type === 'manager_status_comment' &&
        message.content.includes('Accepted ' + sharedResult.sourceId)
    )
    expect(signed).toHaveLength(1)
    const [message] = signed
    expect(message.sender).toMatchObject({ type: 'agent', id: adopter.agentId })
    expect(message.taskId).toBe(adoptedIssue.id)
    const dispatchId = String(message.metadata.dispatch_id)
    expect(dispatchId.startsWith('collaboration-group:' + adoptedId + ':')).toBe(true)
    expect(message.metadata.target_status).toBe('in_review')
    signoffActivity = {
      messageId: message.messageId,
      senderId: message.sender.id,
      dispatchId,
      executionId: managerRun.id,
      content: message.content,
    }
  } finally {
    chat.dispose()
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  const signoffCard = page
    .locator('[data-testid^="cloud-task-activity-card-"]')
    .filter({ hasText: signoffActivity.content })
  await expect(signoffCard).toHaveCount(1)
  await expect(signoffCard).toContainText(adopter.name)
  await expect(signoffCard).toBeVisible()
  await info.attach('same-source-team-signoff', {
    body: await signoffCard.screenshot(),
    contentType: 'image/png',
  })
  await info.attach('same-source-team-executions', {
    contentType: 'application/json',
    body: JSON.stringify({
      ...sharedResult,
      groupId: adoptedId,
      issueId: adoptedIssue.id,
      managerRun,
      signoffActivity,
      member: { ...member, capabilities: adoptedCapabilities },
      executions,
    }),
  })
  await replay(adopter)
  await page.goto(projectPath)
  const native = cases.filter(cell => cell.mode === 'coordinate')
  const nativeCaptures = async () =>
    Promise.all(
      native.map(async cell => ({
        teamId: cell.teamId,
        leader: (await getScenarioModelBodies(request, cell.leadPrompt)).length,
        worker: (await getScenarioModelBodies(request, cell.workerPrompt)).length,
      }))
    )
  const beforeRejection = await nativeCaptures()
  const scope = `group-denied-${suffix}`
  const deniedCalls = async () => {
    const response = await request.get(
      scopedMockUrl(PROVIDER_NATIVE_MOCK_URL, scope) + '/mcp-control/calls'
    )
    expect(response.status()).toBe(200)
    return response.json()
  }
  expect(await deniedCalls()).toEqual([])
  for (const cell of native) {
    const base =
      (cell.shell === 'Codex'
        ? process.env.E2E_CODEX_MODEL_SERVER_URL
        : process.env.E2E_CLAUDE_MODEL_SERVER_URL) || PROVIDER_NATIVE_MOCK_URL
    for (const [index, grant] of [lead, worker].entries()) {
      const updated = await ctx.client.put(`/api/bots/${cell.bots[index].bot_id}`, {
        ...grant.config,
        mcp_servers: {
          [grant.serverId]: { type: 'http', url: scopedMockUrl(base, scope) + '/mcp' },
        },
      })
      expect(updated.status).toBe(200)
    }
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
  const rejectedMcpCalls = await deniedCalls()
  expect(rejectedMcpCalls).toEqual([])
  expect(await nativeCaptures()).toEqual(beforeRejection)
  for (const cell of native) {
    const rows = rejected.filter(row => row.agentId === cell.agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].teamId).toBe(cell.teamId)
    expect(rows[0].errorMessage).toContain(
      'native subagents cannot isolate distinct Bot tool grants'
    )
  }
  await info.attach('native-group-role-grant-rejections', {
    body: JSON.stringify({
      groupId,
      issueId: denied.id,
      rejected,
      rejectedMcpCalls,
      unchangedModelCalls: beforeRejection,
    }),
    contentType: 'application/json',
  })
  for (const row of await ctx.executions(denied.id)) {
    const terminal = ['completed', 'failed', 'cancelled']
    if (row.agentId !== leader.id || terminal.includes(row.status)) continue
    await api(`/api/v1/cloud-projects/${projectId}/executions/${row.id}/stop`, {})
    await expect
      .poll(async () => (await ctx.executions(denied.id)).find(run => run.id === row.id)?.status, {
        timeout: 30_000,
        message: `Manager execution ${row.id} must reach a terminal state before project archival`,
      })
      .toMatch(/^(completed|failed|cancelled)$/)
  }
}
