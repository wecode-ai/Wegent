// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createGroupBotCapability, verifyLegacyBotProbe } from '../../utils/group-bot-capabilities'
import { createApiClient } from '../../utils/api-client'
import { verifyGroupNativeMatrix } from '../../utils/group-native-matrix'
import { writeFile } from 'node:fs/promises'
import {
  test as base,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import {
  initializeProjectExecutionEnvironment,
  createCollaborationGroup,
  createIssueDispatchMockModel,
  deleteIssueDispatchMockModel,
} from '../../utils/issue-dispatch-test-support'
import {
  configureToolScenario,
  getScenarioModelBodies,
  modelRequestText,
  configureHeldStreamResponse,
  releaseHeldStreamResponse,
  waitForHeldStreamResponse,
  clearToolScenario,
  PROVIDER_NATIVE_API_URL,
  authHeaders,
} from '../../utils/provider-native-test-support'
import { selectCollaborationProjectView } from '../../utils/collaboration-test-support'
import { runIsolatedDatabasePython } from '../../utils/isolated-database-state'

const TEST_PREFIX = `e2e-collaboration-agents-${Date.now()}`
interface CollaborationExecution {
  id: number
  loopItemId: string
  displayState: string
  agentId: string | null
  status: string
  teamId: number | null
  backendTaskId: number | null
}
interface CollaborationAgent {
  id: string
  wegentTeamId: number
}
interface CollaborationIssue {
  status: string
}
async function capture(surface: Page | Locator, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`)
  await surface.screenshot({ path, animations: 'disabled' })
  await info.attach(name, { path, contentType: 'image/png' })
}
const leaderName = 'Coordinator'
async function createScenario(request: APIRequestContext, page: Page) {
  const model = await createIssueDispatchMockModel(request, TEST_PREFIX)
  const { modelName, token } = model
  const suffix = Date.now().toString(36).slice(-6)
  const configuredPrompts = new Set<string>()
  const cleanup: string[] = []
  const skillCleanup: number[] = []
  const client = createApiClient(request, PROVIDER_NATIVE_API_URL, token)
  const projectCleanup: string[] = []
  async function apiRequest<T>(
    api: APIRequestContext,
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT'; data?: unknown } = {}
  ): Promise<T> {
    const response = await api.fetch(`${PROVIDER_NATIVE_API_URL}${path}`, {
      ...options,
      headers: authHeaders(token),
    })
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
    return response.json() as Promise<T>
  }
  const apiBot = (name: string, prompt: string, grants?: Record<string, unknown>) =>
    apiRequest<{ id: number }>(request, '/api/bots', {
      method: 'POST',
      data: {
        name,
        namespace: 'default',
        shell_name: 'Chat',
        system_prompt: prompt,
        ...grants,
        agent_config: { bind_model: modelName, bind_model_type: 'user' },
      },
    })
  async function createProject() {
    const workspace = await apiRequest<{ id: string }>(request, '/api/v1/workspaces', {
      method: 'POST',
      data: { name: `Release ${suffix}` },
    })
    projectCleanup.push(`/api/v1/workspaces/${workspace.id}`)
    const project = await apiRequest<{ id: string }>(
      request,
      `/api/v1/workspaces/${workspace.id}/projects`,
      {
        method: 'POST',
        data: { name: 'Release review', task_provider: 'local', visibility: 'private' },
      }
    )
    const projectId = project.id
    const projectPath = `/collaboration/workspaces/${workspace.id}/projects/${projectId}`
    projectCleanup.unshift(`/api/v1/cloud-projects/${projectId}`)
    async function assign(issueId: string, value: string) {
      await page.goto(`${projectPath}/issues/${issueId}`)
      await page.getByTestId('cloud-todo-detail-assignee').click()
      await page.getByTestId(`cloud-todo-detail-assignee-option-${value}`).click()
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        value
      )
    }
    async function executions(id: string) {
      const rows = await apiRequest<{ items: CollaborationExecution[] }>(
        request,
        `/api/v1/cloud-projects/${projectId}/executions?include_terminal=true`
      )
      return rows.items.filter(row => row.loopItemId === id)
    }
    return { projectId, projectPath, assign, executions }
  }
  async function createLeader(projectId: string) {
    const coordinatorName = `coordinator-${suffix}`
    const plannerName = `planner-${suffix}`
    const coordinator = await apiBot(coordinatorName, 'Coordinate the release review.')
    const planner = await apiBot(plannerName, 'Help the coordinator plan release reviews.')
    cleanup.unshift(`bots/${coordinatorName}`, `bots/${plannerName}`)
    const leaderTeamName = `release-coordinators-${suffix}`
    const leaderTeam = await apiRequest<{ id: number; bots: Array<{ bot_id: number }> }>(
      request,
      '/api/teams',
      {
        method: 'POST',
        data: {
          name: leaderTeamName,
          namespace: 'default',
          workflow: { mode: 'coordinate', leader_bot_id: coordinator.id },
          bots: [
            { bot_id: coordinator.id, role: 'leader' },
            { bot_id: planner.id, role: 'worker' },
          ],
        },
      }
    )
    cleanup.unshift(`teams/${leaderTeamName}`)
    expect(leaderTeam.bots.map(member => member.bot_id)).toEqual([coordinator.id, planner.id])
    const leader = await apiRequest<CollaborationAgent>(
      request,
      `/api/v1/cloud-projects/${projectId}/chat-agents`,
      {
        method: 'POST',
        data: {
          name: leaderName,
          runtime: 'wegent',
          wegent_team_id: leaderTeam.id,
          share_with_workspace: true,
        },
      }
    )
    expect(leader.wegentTeamId).toBe(leaderTeam.id)
    return { leader, leaderTeam, coordinator, planner }
  }
  async function dispose() {
    for (const prompt of configuredPrompts) await clearToolScenario(request, prompt)
    for (const path of projectCleanup) {
      const item = await apiRequest<{ version: number }>(request, path)
      const deleted = await request.delete(
        `${PROVIDER_NATIVE_API_URL}${path}?version=${item.version}`,
        { headers: authHeaders(token) }
      )
      expect(deleted.status(), `${path}: ${await deleted.text()}`).toBe(204)
    }
    for (const path of cleanup) {
      const deleted = await request.delete(
        `${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/${path}`,
        {
          headers: authHeaders(token),
        }
      )
      expect(deleted.ok(), await deleted.text()).toBe(true)
    }
    for (const id of skillCleanup)
      expect((await client.delete(`/api/v1/kinds/skills/${id}`)).status).toBe(204)
    await deleteIssueDispatchMockModel(request, model)
  }
  return {
    suffix,
    client,
    skillCleanup,
    configuredPrompts,
    cleanup,
    apiRequest,
    apiBot,
    createProject,
    createLeader,
    dispose,
  }
}
const test = base.extend<{ scenario: Awaited<ReturnType<typeof createScenario>> }>({
  scenario: async ({ request, page }, use) => {
    const scenario = await createScenario(request, page)
    await use(scenario)
    await scenario.dispose()
  },
})

test('runs one legacy two-Bot Team directly, as Issue assignee and as a dispatched group member', async ({
  request,
  page,
  scenario,
}, testInfo) => {
  test.setTimeout(240_000)
  const { suffix, configuredPrompts, cleanup, apiRequest, apiBot, createProject, createLeader } =
    scenario
  const botName = `draft-${suffix}`
  const agentName = 'Review team'
  const memberWork = 'Check the release notes'
  let clearGate: (() => Promise<void>) | undefined
  try {
    const firstGrant = await createGroupBotCapability(
      scenario.client,
      'leader',
      suffix,
      scenario.skillCleanup
    )
    const secondGrant = await createGroupBotCapability(
      scenario.client,
      'worker',
      suffix,
      scenario.skillCleanup
    )
    const firstPrompt = `Perform the initial review for ${suffix}.`
    const first = await apiBot(botName, firstPrompt, firstGrant.config)
    cleanup.unshift(`bots/${botName}`)
    const secondBotName = `review-${suffix}`
    const teamName = `${TEST_PREFIX}-pipeline`
    const reviewPrompt = `Review the first stage ${TEST_PREFIX}`
    const reviewAnswer = 'Release notes checked and approved.'
    const stages = [
      {
        prompt: firstPrompt,
        grant: firstGrant,
        other: secondGrant,
        args: { owner: 'group', repo: 'legacy', issue_number: 1 },
        answer: 'Draft release notes checked.',
      },
      {
        prompt: reviewPrompt,
        grant: secondGrant,
        other: firstGrant,
        args: { code: '7 * 12' },
        answer: reviewAnswer,
      },
    ]
    for (const stage of stages) {
      configuredPrompts.add(stage.prompt)
      await configureToolScenario(
        request,
        stage.prompt,
        Array.from({ length: 3 }, () => [
          {
            toolCalls: [
              { toolName: `${stage.grant.serverId}_${stage.grant.tool}`, arguments: stage.args },
            ],
          },
          { responseContent: stage.answer },
        ]).flat()
      )
    }
    const bot = await apiBot(secondBotName, reviewPrompt, secondGrant.config)
    cleanup.unshift(`bots/${secondBotName}`)
    const owner = await apiRequest<{ id: number }>(request, '/api/users/me')
    const team: { id: number } = JSON.parse(
      await runIsolatedDatabasePython('tests/e2e/legacy_pipeline_team.py', {
        name: teamName,
        owner: owner.id,
        bots: [
          { id: first.id, name: botName },
          { id: bot.id, name: secondBotName },
        ],
      })
    )
    cleanup.unshift(`teams/${teamName}`)
    const taskIds = new Set<number>()
    const modelOffsets = [0, 0]
    const usedReceipts = new Set<string>()
    async function verifyPipeline(taskId: number) {
      expect(taskId).toBeGreaterThan(0)
      expect(taskIds.has(taskId)).toBe(false)
      taskIds.add(taskId)
      await expect
        .poll(() => apiRequest(request, `/api/tasks/${taskId}/pipeline-stage-info`), {
          timeout: 60_000,
          message: `Both original Bots must complete Task ${taskId}`,
        })
        .toMatchObject({
          total_stages: 2,
          stages: [
            { name: botName, status: 'completed' },
            { name: secondBotName, status: 'completed' },
          ],
        })
      const task = await apiRequest<{
        id: number
        subtasks: Array<{
          id: number
          role: string
          team_id: number
          bot_ids: number[]
          status: string
        }>
      }>(request, `/api/tasks/${taskId}`)
      expect(task.id).toBe(taskId)
      const subtasks = task.subtasks.filter(row => row.role === 'ASSISTANT')
      expect(subtasks).toMatchObject([
        { team_id: team.id, bot_ids: [first.id], status: 'COMPLETED' },
        { team_id: team.id, bot_ids: [bot.id], status: 'COMPLETED' },
      ])
      const subtaskIds = subtasks.map(row => row.id)
      expect(subtaskIds.every(id => Number.isSafeInteger(id) && id > 0)).toBe(true)
      expect(new Set(subtaskIds).size).toBe(2)
      const capabilities = []
      for (const [index, stage] of stages.entries()) {
        const bodies = await getScenarioModelBodies(request, stage.prompt)
        const result = verifyLegacyBotProbe(
          bodies.slice(modelOffsets[index]),
          stage.grant,
          stage.other
        )
        expect(usedReceipts.has(result.receipt)).toBe(false)
        usedReceipts.add(result.receipt)
        modelOffsets[index] = bodies.length
        capabilities.push({
          botId: subtasks[index].bot_ids[0],
          subtaskId: subtaskIds[index],
          ...result,
        })
      }
      return {
        taskId: task.id,
        capabilities,
        subtasks: subtasks.map(({ id, team_id, bot_ids, status }) => ({
          subtaskId: id,
          teamId: team_id,
          botIds: bot_ids,
          status,
        })),
      }
    }

    await page.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
    await page.goto(`/chat?teamId=${team.id}`, { waitUntil: 'domcontentloaded' })
    const input = page.getByTestId('message-input')
    await expect(input).toHaveAttribute('data-team-id', String(team.id), { timeout: 30_000 })
    await expect(input).toHaveAttribute('contenteditable', 'true')
    await input.fill('Draft the release notes and ask the reviewer to check them.')
    const send = page.getByTestId('send-button')
    await expect(send).toBeEnabled()
    await capture(page, testInfo, '01-direct-team-input')
    clearGate = await configureHeldStreamResponse(request, reviewPrompt, reviewAnswer)
    await send.click()
    await expect(page).toHaveURL(url => Boolean(url.searchParams.get('taskId')), {
      timeout: 20_000,
    })
    const taskId = Number(new URL(page.url()).searchParams.get('taskId'))
    await waitForHeldStreamResponse(request, reviewPrompt)
    await expect
      .poll(() => apiRequest(request, `/api/tasks/${taskId}/pipeline-stage-info`), {
        timeout: 15_000,
        message: 'The first Bot should finish while the review Bot is running',
      })
      .toMatchObject({
        current_stage: 1,
        stages: [
          { name: botName, status: 'completed' },
          { name: secondBotName, status: 'running' },
        ],
      })
    const progress = page.getByText('Pipeline Progress (2/2)', { exact: true }).locator('../..')
    await expect(progress).toContainText(botName)
    await expect(progress).toContainText(secondBotName)
    await capture(progress, testInfo, '02a-pipeline-handoff')
    await releaseHeldStreamResponse(request, reviewPrompt)
    await clearGate()
    clearGate = undefined
    const directPipeline = await verifyPipeline(taskId)
    await expect(page.getByTestId('messages-container')).toContainText(reviewAnswer)
    await capture(page, testInfo, '02-direct-team-delivery')
    const { projectId, projectPath, assign, executions } = await createProject()
    const agent = await apiRequest<CollaborationAgent>(
      request,
      `/api/v1/cloud-projects/${projectId}/chat-agents`,
      {
        method: 'POST',
        data: {
          name: agentName,
          runtime: 'wegent',
          wegent_team_id: team.id,
          share_with_workspace: true,
        },
      }
    )
    expect(agent.wegentTeamId).toBe(team.id)
    const issue = await apiRequest<{ id: string }>(
      request,
      `/api/v1/cloud-projects/${projectId}/loop-items`,
      {
        method: 'POST',
        data: { title: 'Check the release notes', status: 'pending', priority: 'high' },
      }
    )
    clearGate = await configureHeldStreamResponse(request, reviewPrompt, reviewAnswer)
    await assign(issue.id, `agent:${agent.id}`)
    await capture(page, testInfo, '03-issue-team-assigned')
    await waitForHeldStreamResponse(request, reviewPrompt)
    await expect
      .poll(async () => (await executions(issue.id))[0]?.displayState, {
        timeout: 20_000,
        message: 'The completed first Bot must confirm runtime activity for the Issue',
      })
      .toBe('running')
    const [activeIssueRun] = await executions(issue.id)
    expect(activeIssueRun).toMatchObject({ teamId: team.id, status: 'running' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    const activeCard = page
      .getByTestId('collaboration-issue-detail')
      .locator('[data-testid^="cloud-task-activity-card-"]')
      .filter({
        has: page
          .locator('[data-testid^="cloud-task-activity-backend-task-"]')
          .filter({ hasText: String(activeIssueRun.backendTaskId) }),
      })
    await expect(activeCard).toContainText(agentName)
    await expect(activeCard.getByText('Running', { exact: true }).first()).toBeVisible()
    await capture(activeCard, testInfo, '03a-issue-team-running')
    await releaseHeldStreamResponse(request, reviewPrompt)
    await clearGate()
    clearGate = undefined
    await expect
      .poll(async () => (await executions(issue.id)).map(row => row.status), {
        timeout: 90_000,
        message: 'Direct Issue execution should reach completion',
      })
      .toEqual(['completed'])
    const [assigned] = await executions(issue.id)
    expect(assigned.teamId).toBe(team.id)
    const issuePipeline = await verifyPipeline(assigned.backendTaskId!)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(url => url.pathname === `${projectPath}/issues/${issue.id}`)
    const activityCards = page
      .getByTestId('collaboration-issue-detail')
      .locator('[data-testid^="cloud-task-activity-card-"]')
    const delivery = activityCards.filter({
      has: page
        .locator('[data-testid^="cloud-task-activity-backend-task-"]')
        .filter({ hasText: String(assigned.backendTaskId) }),
      hasText: reviewAnswer,
    })
    await expect(delivery).toHaveCount(1)
    await expect(delivery).toContainText(agentName)
    await capture(page, testInfo, '04-issue-team-delivery')

    await page.goto(projectPath)
    await initializeProjectExecutionEnvironment(page)
    const { leader, leaderTeam, coordinator, planner } = await createLeader(projectId)
    expect(leader.wegentTeamId).not.toBe(team.id)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await selectCollaborationProjectView(page, 'manage')
    const group = await createCollaborationGroup(page, 'Release review', {
      agentIds: [String(leader.wegentTeamId), String(team.id)],
      humanId: '',
      leader: { id: String(leader.wegentTeamId), type: 'agent' },
    })
    const groupDetail = page.getByTestId(`collaboration-group-detail-${group}`)
    await capture(groupDetail, testInfo, '04a-group-configuration')
    const title = `Sign off release ${suffix}`
    const grouped = await apiRequest<{ id: string }>(
      request,
      `/api/v1/cloud-projects/${projectId}/loop-items`,
      {
        method: 'POST',
        data: { title, description: title, status: 'pending', priority: 'high' },
      }
    )
    configuredPrompts.add(title)
    await configureToolScenario(request, title, [
      {
        toolCalls: [
          {
            toolName: 'wegent-wework-space_submit_workflow_plan',
            arguments: {
              plan: {
                round_id: 'review',
                summary: 'Request review',
                items: [
                  {
                    assignment_id: 'review',
                    title: memberWork,
                    instructions: 'Run both review stages.',
                    assignee_type: 'agent',
                    assignee_id: agent.id,
                  },
                ],
              },
            },
          },
        ],
      },
      { responseContent: 'Waiting for the team.' },
      {
        toolCalls: [
          {
            toolName: 'wegent-wework-space_update_issue_status',
            arguments: {
              idempotency_key: 'release-review-accepted',
              target_status: 'in_review',
              reason: 'Member review completed',
              comment: 'Release review accepted.',
            },
          },
        ],
      },
      { responseContent: 'Reviewed' },
    ])
    await assign(grouped.id, `group:${group}`)
    await capture(page, testInfo, '05-group-issue-assigned')
    const dispatchCard = activityCards.filter({
      has: page.locator('[data-testid^="cloud-task-manager-execution-"]'),
      hasText: memberWork,
    })
    await expect(dispatchCard).toContainText(leaderName, { timeout: 60_000 })
    const [dispatchingManager] = (await executions(grouped.id)).filter(
      run => run.agentId === leader.id
    )
    expect(dispatchingManager.teamId).toBe(leaderTeam.id)
    expect(dispatchingManager.backendTaskId).toBeGreaterThan(0)
    await capture(page, testInfo, '05a-manager-dispatched-member')
    await expect
      .poll(
        async () =>
          (await apiRequest<CollaborationIssue>(request, `/api/v1/loop-items/${grouped.id}`))
            .status,
        {
          timeout: 90_000,
          message: 'Coordinator must receive the member result and submit the Issue',
        }
      )
      .toBe('in_review')
    const members = (await executions(grouped.id)).filter(row => row.agentId === agent.id)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ teamId: team.id, status: 'completed' })
    const memberPipeline = await verifyPipeline(members[0].backendTaskId!)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('cloud-todo-detail-status')).toHaveAttribute(
      'data-value',
      'in_review'
    )
    const signoff = activityCards
      .filter({ hasText: 'Release review accepted.' })
      .filter({ hasText: leaderName })
    await expect(signoff).toHaveCount(1)
    await expect(signoff).toBeVisible()
    await capture(page, testInfo, '06-group-issue-delivery')
    await capture(signoff, testInfo, '06a-manager-signoff')
    const managerRequests = await getScenarioModelBodies(request, title)
    expect(modelRequestText(managerRequests.slice(2))).toContain(reviewAnswer)
    await expect
      .poll(
        async () =>
          (await executions(grouped.id))
            .filter(run => run.agentId === leader.id)
            .map(run => run.status),
        {
          timeout: 30_000,
          message: 'The original manager Task must finish after accepting the member result',
        }
      )
      .toEqual(['completed'])
    const groupedRuns = (await executions(grouped.id)).map(
      ({ id, agentId, teamId, backendTaskId, status }) => ({
        id,
        agentId,
        teamId,
        backendTaskId,
        status,
      })
    )
    expect(groupedRuns.filter(run => run.agentId === leader.id)).toEqual([
      {
        id: dispatchingManager.id,
        agentId: leader.id,
        teamId: leaderTeam.id,
        backendTaskId: dispatchingManager.backendTaskId,
        status: 'completed',
      },
    ])
    const evidencePath = testInfo.outputPath('team-execution-evidence.json')
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          teamId: team.id,
          botIds: [first.id, bot.id],
          direct: { ...directPipeline, status: 'completed' },
          issue: {
            issueId: issue.id,
            executionId: assigned.id,
            ...issuePipeline,
            status: assigned.status,
          },
          group: {
            groupId: group,
            issueId: grouped.id,
            status: 'in_review',
            managerId: leader.id,
            memberId: agent.id,
            managerTeamId: leaderTeam.id,
            managerBotIds: [coordinator.id, planner.id],
            memberPipeline,
            executions: groupedRuns,
          },
        },
        null,
        2
      )
    )
    await testInfo.attach('team-execution-evidence', {
      contentType: 'application/json',
      path: evidencePath,
    })
  } finally {
    if (clearGate) await clearGate()
  }
})
test('dispatches six native Team configurations in one collaboration group', async ({
  page,
  request,
  scenario,
}, testInfo) => {
  test.setTimeout(420_000)
  const { suffix, configuredPrompts, cleanup, apiRequest, createProject, createLeader } = scenario
  const { projectId, projectPath, assign, executions } = await createProject()
  await page.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
  await page.goto(projectPath)
  await initializeProjectExecutionEnvironment(page)
  const { leader } = await createLeader(projectId)
  await verifyGroupNativeMatrix({
    client: scenario.client,
    skillCleanup: scenario.skillCleanup,
    leaderName,
    page,
    request,
    info: testInfo,
    projectId,
    projectPath,
    suffix,
    leader,
    api: (path, data) =>
      apiRequest(request, path, data === undefined ? {} : { method: 'POST', data }),
    assign,
    executions,
    cleanup,
    configuredPrompts,
  })
})
