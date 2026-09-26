// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import {
  configureIssueDispatchModelScenario,
  createCollaborationGroup,
  createIssueDispatchMockModel,
  createProjectAgent,
  createProjectFixture,
  deleteIssueDispatchMockModel,
  type IssueDispatchMockModel,
} from '../../utils/issue-dispatch-test-support'
import {
  authHeaders,
  getScenarioModelBodies,
  getScenarioRequestHeaders,
  getToolScenarioState,
  modelRequestText,
  modelToolNames,
  PROVIDER_NATIVE_API_URL,
} from '../../utils/provider-native-test-support'

const suiteSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
interface CollaborationIssue {
  id: string
  status: string
  assignee_group_id: string | null
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

function expectCanonicalAppRoute(execution: CollaborationExecution): void {
  expect(execution.executionDeviceId).toMatch(/^app-record-\d+$/)
  expect(execution.runtimeDeviceId).toBe(execution.executionDeviceId)
}

test.describe.configure({ mode: 'serial' })

test.describe('Collaboration group Executor coordination', () => {
  let model: IssueDispatchMockModel | undefined

  test.beforeAll(async ({ request }) => {
    model = await createIssueDispatchMockModel(request, suiteSuffix)
  })

  test.afterAll(async ({ request }) => {
    if (model) await deleteIssueDispatchMockModel(request, model)
  })

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
    const clearScenario = await configureIssueDispatchModelScenario(request, issueTitle, [
      { responseContent: result },
    ])

    try {
      await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.getByTestId('cloud-todo-detail-assignee').click()
      await page.getByTestId(`cloud-todo-detail-assignee-option-agent:${agent.id}`).click()
      await page.getByTestId('cloud-todo-save').click()
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
      expectCanonicalAppRoute(executions[0])

      const completed = await waitForIssueStatus(request, model.token, fixture.issueId, 'in_review')
      expect(completed.execution_state).not.toBe('failed')

      const modelBodies = await getScenarioModelBodies(request, issueTitle)
      expect(modelRequestText(modelBodies)).toContain(issueTitle)
      expect(modelToolNames(modelBodies).some(isSubmitWorkflowPlan)).toBe(false)
      expect(modelToolNames(modelBodies).some(isUpdateIssueStatus)).toBe(false)
      expect(modelToolNames(modelBodies).some(isNativeSubagentTool)).toBe(false)

      await page.reload()
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
      await expect(page.getByText(result, { exact: false }).first()).toBeVisible()
      await captureEvidence(page, testInfo, '02-direct-agent-in-review')
    } finally {
      await clearScenario()
    }
  })

  test('runs two collaboration rounds with parallel members and fresh manager tasks', async ({
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
      agentIds: [leader.id, collector.id, reviewer.id],
      humanId: '',
      leader: { id: leader.id, type: 'agent' },
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
      [{ responseContent: collectorEvidence, doneDelayMs: 15_000 }]
    )
    const clearReviewerScenario = await configureIssueDispatchModelScenario(request, reviewerTask, [
      { responseContent: reviewerEvidence, doneDelayMs: 15_000 },
    ])
    const clearSynthesisScenario = await configureIssueDispatchModelScenario(
      request,
      synthesisTask,
      [{ responseContent: synthesisEvidence }]
    )

    try {
      await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.getByTestId('cloud-todo-detail-assignee').click()
      await page.getByTestId(`cloud-todo-detail-assignee-option-group:${groupId}`).click()
      await page.getByTestId('cloud-todo-save').click()
      await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        `group:${groupId}`
      )
      await captureEvidence(page, testInfo, '01-group-assigned')

      const assigned = await apiRequest<CollaborationIssue>(
        request,
        model.token,
        `/api/v1/loop-items/${fixture.issueId}`
      )
      expect(assigned.assignee_group_id).toBe(groupId)

      const collectorCard = page
        .locator('[data-testid^="cloud-task-activity-card-"]')
        .filter({ hasText: collectorTask })
      const reviewerCard = page
        .locator('[data-testid^="cloud-task-activity-card-"]')
        .filter({ hasText: reviewerTask })
      await expect(collectorCard).toBeVisible({ timeout: 60_000 })
      await expect(reviewerCard).toBeVisible({ timeout: 60_000 })
      await expect(
        collectorCard.locator('[data-testid^="cloud-task-activity-execution-badge-"]')
      ).toHaveAttribute('data-status', 'running')
      await expect(
        reviewerCard.locator('[data-testid^="cloud-task-activity-execution-badge-"]')
      ).toHaveAttribute('data-status', 'running')
      await captureEvidence(page, testInfo, '02-first-round-members-running-in-parallel')

      const executions = await waitForCollaborationExecutions(
        request,
        model.token,
        fixture.projectId,
        fixture.issueId,
        1
      )
      expect(executions[0].executorType).toBe('collaboration_group_dispatch')
      expect(executions[0].backendTaskId).toBeNull()
      expect(executions[0].runtimeTaskId).toMatch(/^codex-queue-\d+$/)
      expect(executions[0].executionEnvironment).toBe('local')
      expectCanonicalAppRoute(executions[0])
      expect(executions[0].status).toBe('completed')

      const completed = await waitForIssueStatus(request, model.token, fixture.issueId, 'in_review')
      expect(completed.execution_state).not.toBe('failed')

      const managerBodies = await getScenarioModelBodies(request, issueTitle)
      const managerHeaders = await getScenarioRequestHeaders(request, issueTitle)
      const managerScenario = await getToolScenarioState(request, issueTitle)
      const managerSessionIds = distinctSessionIds(managerHeaders)
      const managerToolNames = modelToolNames(managerBodies)
      expect(managerBodies.length).toBeGreaterThanOrEqual(6)
      expect(managerScenario.nextStep).toBe(6)
      expect(managerSessionIds).toHaveLength(3)
      expect(managerSessionIds.some(id => id.endsWith(`manager-after-${firstRoundId}`))).toBe(true)
      expect(managerSessionIds.some(id => id.endsWith(`manager-after-${secondRoundId}`))).toBe(true)
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
      expect(collectorSessionIds[0]).toBe(
        `${executions[0].runtimeTaskId}-member-${firstRoundId}-collector-${suffix}`
      )
      expect(reviewerSessionIds[0]).toBe(
        `${executions[0].runtimeTaskId}-member-${firstRoundId}-reviewer-${suffix}`
      )
      expect(synthesisSessionIds[0]).toBe(
        `${executions[0].runtimeTaskId}-member-${secondRoundId}-synthesis-${suffix}`
      )

      await page.reload()
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
      await expect(page.getByText(collectorTask, { exact: false }).first()).toBeVisible()
      await expect(page.getByText(reviewerTask, { exact: false }).first()).toBeVisible()
      await expect(page.getByText(synthesisTask, { exact: false }).first()).toBeVisible()
      await expect(page.getByText(finalComment, { exact: false }).first()).toBeVisible()
      await captureEvidence(page, testInfo, '03-manager-reviewed-two-rounds')
    } finally {
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

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
