// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import type { DeviceInfo, DeviceListResponse } from '../../../src/apis/devices'
import {
  configureIssueDispatchModelScenario,
  createCollaborationGroup,
  createIssueDispatchMockModel,
  createProjectAgent,
  createProjectFixture,
  initializeProjectExecutionEnvironment,
  deleteIssueDispatchMockModel,
  type IssueDispatchMockModel,
} from '../../utils/issue-dispatch-test-support'
import {
  authHeaders,
  configureHeldStreamResponse,
  getScenarioModelBodies,
  getScenarioRequestHeaders,
  getToolScenarioState,
  modelRequestText,
  modelToolNames,
  PROVIDER_NATIVE_API_URL,
  releaseHeldStreamResponse,
  waitForHeldStreamResponse,
} from '../../utils/provider-native-test-support'

const suiteSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const DEVICE_ID = process.env.E2E_DEVICE_ID || 'e2e-claudecode-device'

interface CollaborationIssue {
  id: string
  status: string
  assignee_group_id: string | null
  assignee_agent_id: string | null
  execution_state: string | null
}

interface CollaborationExecution {
  id: number
  loopItemId: string
  agentId: string | null
  status: string
  executorType: string
  backendTaskId: number | null
  runtimeTaskId: string | null
  executionEnvironment: string | null
  executionDeviceId: string | null
  runtimeDeviceId: string | null
}

function expectCanonicalAppRoute(execution: CollaborationExecution, device: DeviceInfo): void {
  expect(execution.executionDeviceId).toMatch(/^app-record-\d+$/)
  expect(execution.executionDeviceId).toBe(device.execution_target_id)
  expect(execution.runtimeDeviceId).toBe(execution.executionDeviceId)
}

test.describe.configure({ mode: 'serial' })

test.describe('Collaboration group Executor coordination', () => {
  let model: IssueDispatchMockModel | undefined
  let appDevice: DeviceInfo

  test.beforeAll(async ({ request }) => {
    model = await createIssueDispatchMockModel(request, suiteSuffix)
    const response = await request.get(`${PROVIDER_NATIVE_API_URL}/api/devices`, {
      headers: authHeaders(model.token),
    })
    expect(response.status(), await response.text()).toBe(200)
    const devices = (await response.json()) as DeviceListResponse
    const device = devices.items.find(item => item.device_id === DEVICE_ID)
    expect(device, `Configured Executor device ${DEVICE_ID} must be registered`).toBeDefined()
    expect(device).toMatchObject({ device_type: 'app', status: 'online' })
    expect(device!.execution_target_id).toMatch(/^app-record-\d+$/)
    appDevice = device!
  })

  test.afterAll(async ({ request }) => {
    if (model) await deleteIssueDispatchMockModel(request, model)
  })

  for (const deviceSetup of ['authorized', 'configure'] as const) {
    test(`applies a marketplace template with an ${deviceSetup} project APP device and preserves edits across refresh`, async ({
      page,
      request,
    }) => {
      if (!model) throw new Error('Issue Dispatch mock model was not provisioned')
      const fixture = await createProjectFixture(
        page,
        `template-${Date.now()}`,
        'Template fixture issue'
      )
      try {
        const originalAgents = await apiRequest<Array<{ id: string }>>(
          request,
          model.token,
          `/api/v1/cloud-projects/${fixture.projectId}/chat-agents`
        )
        if (deviceSetup === 'configure') {
          const removed = await request.delete(
            `${PROVIDER_NATIVE_API_URL}/api/v1/cloud-projects/${fixture.projectId}/execution-environments/${appDevice.id}`,
            {
              headers: authHeaders(model.token),
            }
          )
          expect(removed.status(), await removed.text()).toBe(204)
        }
        await page.goto('/resource-library?type=template')
        await page.getByTestId('template-details-product-lifecycle').click()
        await page.getByTestId('template-use').click()
        await page.getByTestId(`template-project-${fixture.projectId}`).click()
        await page.getByTestId('template-bindings-toggle').click()
        const environment = page.getByTestId('template-project-environment-select')
        const environmentValue = environment.locator('[data-value]')
        await expect(environment).toBeEnabled()
        await expect(environmentValue).toHaveAttribute(
          'data-value',
          deviceSetup === 'authorized' ? String(appDevice.id) : ''
        )
        const groupName = `Imported project team ${Date.now()}`
        const name = page.locator('[data-testid^="template-group-name-"]')
        await name.fill(groupName)
        if (deviceSetup === 'configure') {
          const popup = page.waitForEvent('popup')
          await page.getByTestId('template-project-environment-settings').click()
          const settings = await popup
          await expect(settings).toHaveURL(
            `${fixture.projectPath}?view=manage&section=environments`
          )
          await initializeProjectExecutionEnvironment(settings)
          await settings.close()
        }
        await page.getByTestId('template-project-environment-refresh').click()
        await expect(environment).toBeEnabled()
        await expect(environmentValue).toHaveAttribute('data-value', String(appDevice.id))
        await expect(name).toHaveValue(groupName)
        await expect(page.getByTestId('template-project-environment-settings')).toHaveAttribute(
          'href',
          `${fixture.projectPath}?view=manage&section=environments`
        )
        // Web imports retain user-selected model routing until actual execution.
        await expect(page.getByTestId('template-model-codex')).toHaveCount(0)
        await page.getByTestId('template-bindings-apply').click()
        await expect(page).toHaveURL(new RegExp(`${fixture.projectPath}$`))
        await page.reload()
        await expect(page.getByTestId('collaboration-board')).toBeVisible()
        const agents = await apiRequest<
          Array<{
            id: string
            executionPolicy: { mode: string; environment_id: string }
            modelPolicy: { mode: string }
          }>
        >(request, model.token, `/api/v1/cloud-projects/${fixture.projectId}/chat-agents`)
        const imported = agents.filter(
          agent => !originalAgents.some(original => original.id === agent.id)
        )
        expect(imported).toHaveLength(6)
        for (const agent of imported) {
          expect(agent.executionPolicy).toEqual({
            mode: 'fixed',
            environment_id: String(appDevice.id),
          })
          expect(agent.modelPolicy.mode).toBe('user_select')
        }
        const groups = await apiRequest<{ items: Array<{ name: string }> }>(
          request,
          model.token,
          `/api/v1/cloud-projects/${fixture.projectId}/collaboration-groups`
        )
        expect(groups.items.map(group => group.name)).toContain(groupName)
      } finally {
        for (const path of [
          `/api/v1/cloud-projects/${fixture.projectId}`,
          `/api/v1/workspaces/${fixture.workspaceId}`,
        ]) {
          const current = await apiRequest<{ version: number }>(request, model.token, path)
          const removed = await request.delete(
            `${PROVIDER_NATIVE_API_URL}${path}?version=${current.version}`,
            { headers: authHeaders(model.token) }
          )
          expect(removed.status(), await removed.text()).toBe(204)
        }
      }
    })
  }

  test('dispatches a directly assigned agent and moves only to review', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000)
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')

    const suffix = `${Date.now()}`
    const issueTitle = `Direct agent dispatch ${suffix}`
    const result = `DIRECT_AGENT_RESULT_${suffix}`
    const fixture = await createProjectFixture(page, suffix, issueTitle)
    const agent = await createProjectAgent(page, `Direct Agent ${suffix}`, model.modelName)
    const scenarioMatch = `task_id: ${fixture.issueId}`
    const clearScenario = await configureIssueDispatchModelScenario(request, scenarioMatch, [
      {
        toolCalls: [
          {
            toolName: 'wework_space__get_current_context',
            arguments: {},
            inspectToolNames: [
              'submit_workflow_plan',
              'update_issue_status',
              'spawn_agent',
              'wait_agent',
            ],
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: 'wework_space__get_board_item',
            arguments: {
              space_id: fixture.projectId,
              item_id: fixture.issueId,
            },
          },
        ],
      },
      { responseContent: result },
    ])

    try {
      await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.getByTestId('cloud-todo-detail-assignee').click()
      await page.getByTestId(`cloud-todo-detail-assignee-option-agent:${agent.id}`).click()
      await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        `agent:${agent.id}`
      )
      await captureEvidence(page, testInfo, '01-direct-agent-assigned')

      const executions = await waitForCollaborationExecutions(
        request,
        model.token,
        fixture.projectId,
        fixture.issueId,
        1
      )
      expect(executions[0].agentId).toBe(agent.id)
      expect(executions[0].executorType).not.toBe('collaboration_group_dispatch')
      expect(executions[0].backendTaskId).toBeNull()
      expect(executions[0].runtimeTaskId).toMatch(/^codex-queue-\d+$/)
      expect(executions[0].executionEnvironment).toBe('local')
      expectCanonicalAppRoute(executions[0], appDevice)

      const completed = await waitForIssueStatus(request, model.token, fixture.issueId, 'in_review')
      expect(completed.execution_state).not.toBe('failed')

      const modelBodies = await getScenarioModelBodies(request, scenarioMatch)
      expect(modelBodies.length).toBeGreaterThan(2)
      expect(modelRequestText(modelBodies.slice(1))).toContain(issueTitle)
      expect(modelRequestText(modelBodies)).toContain('ALL_TOOLS.filter')
      expect(modelToolNames(modelBodies).some(isSubmitWorkflowPlan)).toBe(false)
      expect(modelToolNames(modelBodies).some(isUpdateIssueStatus)).toBe(false)
      expect(modelToolNames(modelBodies).some(isNativeSubagentTool)).toBe(false)

      await page.reload()
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveAttribute(
        'data-value',
        'in_review'
      )
      await expect(page.getByText(result, { exact: false }).first()).toBeVisible()
      await captureEvidence(page, testInfo, '02-direct-agent-in-review')
    } finally {
      await clearScenario()
    }
  })

  test('human lead dispatches a member from the Issue and submits its decision', async ({
    page,
    request,
  }, info) => {
    test.setTimeout(150_000)
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')
    const fixture = await createProjectFixture(
      page,
      Date.now().toString(36),
      'Human release review'
    )
    const me = await apiRequest<{ id: number }>(request, model.token, '/api/users/me')
    const agent = await createProjectAgent(page, 'Release reviewer', model.modelName)
    const group = await createCollaborationGroup(page, 'Release group', {
      agentIds: [String(agent.wegentTeamId)],
      humanId: String(me.id),
      leader: { id: String(me.id), type: 'human' },
    })
    const instruction = 'Check the release log ' + fixture.issueId
    const clear = await configureIssueDispatchModelScenario(request, instruction, [
      { responseContent: 'Release log checked.' },
    ])
    try {
      await page.goto(fixture.projectPath + '/issues/' + fixture.issueId)
      await page.getByTestId('cloud-todo-detail-assignee').click()
      await page.getByTestId('cloud-todo-detail-assignee-option-group:' + group).click()
      const submit = page.getByTestId('issue-coordination-submit')
      await expect(submit).toBeDisabled()
      await page.getByTestId(/^issue-dispatch-instructions-/).fill(instruction)
      await captureEvidence(page, info, 'human-lead-round')
      const posted = page.waitForResponse(
        resp => resp.url().endsWith('/executions/batch') && resp.request().method() === 'POST'
      )
      await submit.click()
      expect((await posted).ok()).toBe(true)
      const executions = await waitForCollaborationExecutions(
        request,
        model.token,
        fixture.projectId,
        fixture.issueId,
        1
      )
      expect(executions[0]).toMatchObject({
        agentId: agent.id,
        status: 'completed',
        executionNote: 'Release log checked.',
      })
      await page.reload()
      await page.getByTestId('issue-coordination-action').click()
      await page.getByTestId('issue-coordination-action-option-decision').click()
      await page.getByTestId('issue-decision-reason').fill('The reviewer verified the release log.')
      await captureEvidence(page, info, 'human-lead-decision')
      const decided = page.waitForResponse(
        resp =>
          resp.url().endsWith('/executions/manager-decision') && resp.request().method() === 'POST'
      )
      await submit.click()
      expect((await decided).ok()).toBe(true)
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveAttribute(
        'data-value',
        'in_review'
      )
      const activity = page.locator('[data-testid^="cloud-task-activity-card-"]')
      await expect(activity.filter({ hasText: instruction })).toContainText('Release reviewer')
      await expect(activity.filter({ hasText: 'Release log checked.' })).toContainText(
        'Release reviewer'
      )
      await captureEvidence(page, info, 'human-lead-delivered')
    } finally {
      await clear()
      for (const path of [
        '/api/v1/cloud-projects/' + fixture.projectId,
        '/api/v1/workspaces/' + fixture.workspaceId,
      ]) {
        const current = await apiRequest<{ version: number }>(request, model.token, path)
        const deleted = await request.delete(
          `${PROVIDER_NATIVE_API_URL}${path}?version=${current.version}`,
          { headers: authHeaders(model.token) }
        )
        expect(deleted.ok(), await deleted.text()).toBe(true)
      }
    }
  })

  test('registers an assistant and creates an idempotent risk-scoped dispatch', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')

    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(
      page,
      `assistant-${suffix}`,
      `Assistant dispatch fixture ${suffix}`
    )
    try {
      const me = await apiRequest<{ id: number }>(request, model.token, '/api/users/me')
      const roster = await apiJson<{ id: string; endpointRef: string }>(
        request,
        model.token,
        'POST',
        `/api/v1/cloud-projects/${fixture.projectId}/assistant-roster`,
        {
          userId: me.id,
          roleId: 'review',
          endpointRef: `local_wework:${me.id}:review`,
          displayName: `Dispatch reviewer ${suffix}`,
          enabled: true,
          capabilityTags: ['review'],
          autonomyPolicy: {
            automatic: true,
            askBeforeAct: false,
            riskCeiling: 'low',
          },
          availability: 'online',
          version: 0,
        }
      )
      const inaccessibleAgent = await request.fetch(
        `${PROVIDER_NATIVE_API_URL}/api/v1/cloud-projects/${fixture.projectId}/assistant-roster`,
        {
          method: 'POST',
          headers: authHeaders(model.token),
          data: {
            userId: me.id,
            roleId: 'review',
            endpointRef: `wegent_agent:${me.id}:missing-${suffix}:review`,
            displayName: `Inaccessible agent ${suffix}`,
            enabled: true,
            capabilityTags: ['review'],
            autonomyPolicy: { automatic: false, askBeforeAct: true },
            availability: 'online',
            version: 0,
          },
        }
      )
      expect(inaccessibleAgent.status(), await inaccessibleAgent.text()).toBe(403)
      const input = {
        intentId: `assistant-intent-${suffix}`,
        goal: `Assistant dispatch ${suffix}`,
        riskLevel: 'high' as const,
        description: 'Review the high-risk request before execution.',
        managerUserId: me.id,
        confirmationState: 'confirmed' as const,
        assignments: [
          {
            rosterEntryId: roster.id,
            userId: me.id,
            brief: 'Review the high-risk request before execution.',
          },
        ],
      }
      const dispatched = await apiJson<{
        dispatchId: string
        rootIssueId: string
        children: Array<{ issueId: string; status: string; rosterEntryId: string }>
        replayed: boolean
      }>(
        request,
        model.token,
        'POST',
        `/api/v1/cloud-projects/${fixture.projectId}/assistant-dispatches`,
        input
      )
      expect(dispatched.replayed).toBe(false)
      expect(dispatched.children).toHaveLength(1)
      expect(dispatched.children[0]).toMatchObject({
        rosterEntryId: roster.id,
        status: 'waiting_confirmation',
      })

      const replayed = await apiJson<typeof dispatched>(
        request,
        model.token,
        'POST',
        `/api/v1/cloud-projects/${fixture.projectId}/assistant-dispatches`,
        input
      )
      expect(replayed).toMatchObject({
        dispatchId: dispatched.dispatchId,
        rootIssueId: dispatched.rootIssueId,
        replayed: true,
      })

      const automatic = await apiJson<typeof dispatched>(
        request,
        model.token,
        'POST',
        `/api/v1/cloud-projects/${fixture.projectId}/assistant-dispatches`,
        {
          ...input,
          intentId: `assistant-low-risk-${suffix}`,
          goal: `Automatic assistant dispatch ${suffix}`,
          riskLevel: 'low',
          description: 'Use the explicitly authorized low-risk assistant policy.',
        }
      )
      expect(automatic.children[0].status).toBe('queued')

      const root = await apiRequest<{
        id: string
        status: string
        automation: { assistant_dispatch?: boolean }
      }>(request, model.token, `/api/v1/loop-items/${dispatched.rootIssueId}`)
      const child = await apiRequest<{
        id: string
        parent_id: string | null
        automation: { risk_level?: string }
      }>(request, model.token, `/api/v1/loop-items/${dispatched.children[0].issueId}`)
      expect(root.automation.assistant_dispatch).toBe(true)
      expect(child).toMatchObject({
        parent_id: root.id,
        automation: { risk_level: 'high' },
      })
    } finally {
      for (const path of [
        `/api/v1/cloud-projects/${fixture.projectId}`,
        `/api/v1/workspaces/${fixture.workspaceId}`,
      ]) {
        const current = await apiRequest<{ version: number }>(request, model.token, path)
        const removed = await request.delete(
          `${PROVIDER_NATIVE_API_URL}${path}?version=${current.version}`,
          { headers: authHeaders(model.token) }
        )
        expect(removed.status(), await removed.text()).toBe(204)
      }
    }
  })

  test('runs two collaboration rounds with parallel members in one manager session', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(300_000)
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')

    const suffix = `${Date.now()}`
    const issueTitle = `Coordinate CPU investigation ${suffix}`
    const firstRoundId = `collect-${suffix}`
    const secondRoundId = `synthesize-${suffix}`
    const collectorTask = `Collect CPU evidence ${suffix}`
    const reviewerTask = `Review CPU evidence ${suffix}`
    const synthesisTask = `Synthesize CPU findings ${suffix}`
    const collectorEvidence = `COLLECTOR_EVIDENCE_${suffix}`
    const reviewerEvidence = `REVIEWER_EVIDENCE_${suffix}`
    const synthesisEvidence = `SYNTHESIS_EVIDENCE_${suffix}`
    const finalComment =
      'The manager reviewed both collaboration rounds and submitted the Issue for confirmation.'
    const fixture = await createProjectFixture(page, suffix, issueTitle)
    const leader = await createProjectAgent(page, `Coordinate Leader ${suffix}`, model.modelName)
    const collector = await createProjectAgent(
      page,
      `Coordinate Collector ${suffix}`,
      model.modelName
    )
    const reviewer = await createProjectAgent(
      page,
      `Coordinate Reviewer ${suffix}`,
      model.modelName
    )
    const groupName = `Coordinate Group ${suffix}`
    const groupId = await createCollaborationGroup(page, groupName, {
      agentIds: [leader, collector, reviewer].map(agent => String(agent.wegentTeamId)),
      humanId: '',
      leader: { id: String(leader.wegentTeamId), type: 'agent' },
    })

    const clearManagerScenario = await configureIssueDispatchModelScenario(request, issueTitle, [
      {
        toolCalls: [
          {
            toolName: 'wework_space__submit_workflow_plan',
            arguments: {
              plan: {
                round_id: firstRoundId,
                summary: 'Collect and independently review CPU evidence in parallel.',
                items: [
                  {
                    assignment_id: `collector-${suffix}`,
                    title: collectorTask,
                    instructions: `${collectorTask}. Return ${collectorEvidence}.`,
                    assignee_type: 'agent',
                    assignee_id: collector.id,
                  },
                  {
                    assignment_id: `reviewer-${suffix}`,
                    title: reviewerTask,
                    instructions: `${reviewerTask}. Return ${reviewerEvidence}.`,
                    assignee_type: 'agent',
                    assignee_id: reviewer.id,
                  },
                ],
              },
            },
          },
        ],
      },
      {
        responseContent:
          'The first collaboration round was dispatched. Waiting for Executor results.',
      },
      {
        toolCalls: [
          {
            toolName: 'wework_space__submit_workflow_plan',
            arguments: {
              plan: {
                round_id: secondRoundId,
                summary: 'Synthesize the independently collected and reviewed CPU evidence.',
                items: [
                  {
                    assignment_id: `synthesis-${suffix}`,
                    title: synthesisTask,
                    instructions: `${synthesisTask}. Use ${collectorEvidence} and ${reviewerEvidence}. Return ${synthesisEvidence}.`,
                    assignee_type: 'agent',
                    assignee_id: collector.id,
                  },
                ],
              },
            },
          },
        ],
      },
      {
        responseContent:
          'The second collaboration round was dispatched. Waiting for Executor results.',
      },
      {
        toolCalls: [
          {
            toolName: 'wework_space__update_issue_status',
            arguments: {
              status: 'in_review',
              reason: `Both rounds were evaluated: ${collectorEvidence}, ${reviewerEvidence}, ${synthesisEvidence}.`,
              comment: finalComment,
            },
          },
        ],
      },
      {
        responseContent: `Manager evaluated ${synthesisEvidence} and moved the Issue to review.`,
      },
    ])
    const clearCollectorScenario = await configureIssueDispatchModelScenario(
      request,
      collectorTask,
      [{ responseContent: collectorEvidence }]
    )
    const clearReviewerScenario = await configureIssueDispatchModelScenario(request, reviewerTask, [
      { responseContent: reviewerEvidence },
    ])
    const clearCollectorGate = await configureHeldStreamResponse(
      request,
      collectorTask,
      collectorEvidence
    )
    const clearReviewerGate = await configureHeldStreamResponse(
      request,
      reviewerTask,
      reviewerEvidence
    )
    const clearSynthesisScenario = await configureIssueDispatchModelScenario(
      request,
      synthesisTask,
      [{ responseContent: synthesisEvidence }]
    )

    try {
      await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.getByTestId('cloud-todo-detail-assignee').click()
      const groupAssigned = page.waitForResponse(
        response =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === `/api/v1/loop-items/${fixture.issueId}` &&
          response.request().postDataJSON()?.assignee_group_id === groupId
      )
      await page.getByTestId(`cloud-todo-detail-assignee-option-group:${groupId}`).click()
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        `group:${groupId}`
      )
      // The manager can reassign the Issue before a subsequent read reaches the server.
      const assignmentResponse = await groupAssigned
      expect(assignmentResponse.ok()).toBe(true)
      const assigned: CollaborationIssue = await assignmentResponse.json()
      expect(assigned.id).toBe(fixture.issueId)
      expect(assigned.assignee_group_id).toBe(groupId)
      await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
      await captureEvidence(page, testInfo, '01-group-assigned')

      const memberExecutionCard = (agentName: string) =>
        page
          .locator('[data-testid^="cloud-task-activity-card-"]')
          .filter({ hasText: agentName })
          .filter({
            has: page.locator('[data-testid^="cloud-task-activity-execution-badge-"]'),
          })
      const collectorCard = memberExecutionCard(`Coordinate Collector ${suffix}`)
      const reviewerCard = memberExecutionCard(`Coordinate Reviewer ${suffix}`)
      const managerAssignment = page
        .locator('[data-testid^="cloud-task-activity-card-"]')
        .filter({ hasText: collectorTask })
        .filter({
          has: page.locator('[data-testid^="cloud-task-manager-execution-"]'),
        })
      await expect(managerAssignment).toBeVisible({ timeout: 60_000 })
      await expect(managerAssignment).toContainText(reviewerTask)
      await expect(collectorCard).toBeVisible({ timeout: 60_000 })
      await expect(reviewerCard).toBeVisible({ timeout: 60_000 })
      await waitForHeldStreamResponse(request, collectorTask)
      await waitForHeldStreamResponse(request, reviewerTask)
      await expect(
        collectorCard.locator('[data-testid^="cloud-task-activity-execution-badge-"]')
      ).toHaveAttribute('data-status', 'running')
      await expect(
        reviewerCard.locator('[data-testid^="cloud-task-activity-execution-badge-"]')
      ).toHaveAttribute('data-status', 'running')
      await captureEvidence(page, testInfo, '02-first-round-members-running-in-parallel')
      await releaseHeldStreamResponse(request, collectorTask)
      await releaseHeldStreamResponse(request, reviewerTask)

      const executions = await waitForCollaborationExecutions(
        request,
        model.token,
        fixture.projectId,
        fixture.issueId,
        4
      )
      const managers = executions.filter(row => row.executorType === 'collaboration_group_dispatch')
      expect(managers).toHaveLength(1)
      const [manager] = managers
      expect(manager.executorType).toBe('collaboration_group_dispatch')
      expect(manager.backendTaskId).toBeNull()
      expect(manager.runtimeTaskId).toMatch(/^codex-queue-\d+$/)
      expect(manager.executionEnvironment).toBe('local')
      expectCanonicalAppRoute(manager, appDevice)
      expect(manager.status).toBe('completed')

      const completed = await waitForIssueStatus(request, model.token, fixture.issueId, 'in_review')
      expect(completed.execution_state).not.toBe('failed')
      expect(completed.assignee_group_id).toBeNull()
      // The manager takes ownership again after evaluating the delivered rounds.
      expect(completed.assignee_agent_id).toBe(leader.id)

      // The status tool commits before the manager's final model response.
      await expect
        .poll(async () => (await getToolScenarioState(request, issueTitle)).nextStep, {
          timeout: 60_000,
          message: 'The final manager model step should finish before capturing its evidence',
        })
        .toBe(6)
      const managerBodies = await getScenarioModelBodies(request, issueTitle)
      const managerHeaders = await getScenarioRequestHeaders(request, issueTitle)
      const managerScenario = await getToolScenarioState(request, issueTitle)
      const managerSessionIds = distinctSessionIds(managerHeaders)
      const managerToolNames = modelToolNames(managerBodies)
      expect(managerBodies.length).toBeGreaterThanOrEqual(6)
      expect(managerScenario.nextStep).toBe(6)
      expect(managerSessionIds).toEqual([`${manager.runtimeTaskId}-manager-initial`])
      expect(managerToolNames.some(isSubmitWorkflowPlan)).toBe(true)
      expect(managerToolNames.some(isUpdateIssueStatus)).toBe(true)
      expect(managerToolNames.some(isNativeSubagentTool)).toBe(false)
      expect(modelRequestText(managerBodies.slice(0, 1))).toContain(
        'Project collaboration rules and workflow'
      )
      expect(modelRequestText(managerBodies.slice(2, 4))).toContain(collectorEvidence)
      expect(modelRequestText(managerBodies.slice(2, 4))).toContain(reviewerEvidence)
      expect(modelRequestText(managerBodies.slice(4))).toContain(synthesisEvidence)

      const collectorScenario = await getToolScenarioState(request, collectorTask)
      const reviewerScenario = await getToolScenarioState(request, reviewerTask)
      const synthesisScenario = await getToolScenarioState(request, synthesisTask)
      const collectorSessionIds = distinctSessionIds(
        await getScenarioRequestHeaders(request, collectorTask)
      )
      const reviewerSessionIds = distinctSessionIds(
        await getScenarioRequestHeaders(request, reviewerTask)
      )
      const synthesisSessionIds = distinctSessionIds(
        await getScenarioRequestHeaders(request, synthesisTask)
      )
      expect(collectorScenario.nextStep).toBe(1)
      expect(reviewerScenario.nextStep).toBe(1)
      expect(synthesisScenario.nextStep).toBe(1)
      expect(collectorSessionIds).toHaveLength(1)
      expect(reviewerSessionIds).toHaveLength(1)
      expect(synthesisSessionIds).toHaveLength(1)
      const memberRuntimeSessionIds = [
        collectorSessionIds[0],
        reviewerSessionIds[0],
        synthesisSessionIds[0],
      ]
      expect(new Set(memberRuntimeSessionIds).size).toBe(3)
      expect(
        memberRuntimeSessionIds.every(sessionId => !managerSessionIds.includes(sessionId))
      ).toBe(true)
      for (const [sessionId, agentId] of [
        [collectorSessionIds[0], collector.id],
        [reviewerSessionIds[0], reviewer.id],
        [synthesisSessionIds[0], collector.id],
      ]) {
        const member = executions.find(row => row.runtimeTaskId === sessionId)
        expect(member).toMatchObject({ agentId, status: 'completed' })
      }

      await page.reload()
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveAttribute(
        'data-value',
        'in_review'
      )
      await expect(page.getByText(collectorTask, { exact: false }).first()).toBeVisible()
      await expect(page.getByText(reviewerTask, { exact: false }).first()).toBeVisible()
      await expect(page.getByText(synthesisTask, { exact: false }).first()).toBeVisible()
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        `agent:${leader.id}`
      )
      await expect(page.getByText(finalComment, { exact: false }).first()).toBeVisible()
      await captureEvidence(page, testInfo, '03-manager-reviewed-two-rounds')
    } finally {
      await clearReviewerGate()
      await clearCollectorGate()
      await clearSynthesisScenario()
      await clearReviewerScenario()
      await clearCollectorScenario()
      await clearManagerScenario()
    }
  })
})

function distinctSessionIds(
  headers: Array<Record<string, string | string[] | undefined>>
): string[] {
  const values = headers.flatMap(header => {
    const value = header['wecode-session-id']
    return Array.isArray(value) ? value : value ? [value] : []
  })
  return [...new Set(values)]
}

function isSubmitWorkflowPlan(name: string): boolean {
  return name.endsWith('submit_workflow_plan')
}

function isNativeSubagentTool(name: string): boolean {
  return name.endsWith('spawn_agent') || name.endsWith('wait_agent')
}

function isUpdateIssueStatus(name: string): boolean {
  return name.endsWith('update_issue_status')
}

async function waitForCollaborationExecutions(
  request: APIRequestContext,
  token: string,
  projectId: string,
  issueId: string,
  expectedCount: number
): Promise<CollaborationExecution[]> {
  let matching: CollaborationExecution[] = []
  await expect
    .poll(
      async () => {
        const response = await apiRequest<{ items: CollaborationExecution[] }>(
          request,
          token,
          `/api/v1/cloud-projects/${projectId}/executions?include_terminal=true`
        )
        matching = response.items.filter(item => item.loopItemId === issueId)
        return {
          count: matching.length,
          terminal: matching.filter(item =>
            ['completed', 'failed', 'cancelled'].includes(item.status)
          ).length,
        }
      },
      {
        timeout: 180_000,
        message: `Collaboration executions for Issue ${issueId} should finish`,
      }
    )
    .toEqual({ count: expectedCount, terminal: expectedCount })
  return matching
}

async function waitForIssueStatus(
  request: APIRequestContext,
  token: string,
  issueId: string,
  status: string
): Promise<CollaborationIssue> {
  let issue: CollaborationIssue | undefined
  await expect
    .poll(
      async () => {
        issue = await apiRequest<CollaborationIssue>(
          request,
          token,
          `/api/v1/loop-items/${issueId}`
        )
        return issue.status
      },
      {
        timeout: 60_000,
        message: `Issue ${issueId} should move to ${status} through the manager MCP call`,
      }
    )
    .toBe(status)
  return issue!
}

async function apiRequest<T>(
  request: APIRequestContext,
  token: string,
  pathname: string
): Promise<T> {
  const response = await request.get(`${PROVIDER_NATIVE_API_URL}${pathname}`, {
    headers: authHeaders(token),
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as T
}

async function apiJson<T>(
  request: APIRequestContext,
  token: string,
  method: 'POST',
  pathname: string,
  data: unknown
): Promise<T> {
  const response = await request.fetch(`${PROVIDER_NATIVE_API_URL}${pathname}`, {
    method,
    headers: authHeaders(token),
    data,
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as T
}

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
