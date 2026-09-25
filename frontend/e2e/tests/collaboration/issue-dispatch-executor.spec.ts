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
const parentHeaders = { 'x-openai-subagent': null }
const childHeaders = { 'x-openai-subagent': 'collab_spawn' }

interface CollaborationIssue {
  id: string
  status: string
  assignee_group_id: string | null
  execution_state: string | null
}

interface CollaborationExecution {
  loopItemId: string
  status: string
  observedState: string
  displayState: string
  teamId: number | null
  runtimeTaskId: string | null
}

test.describe.configure({ mode: 'serial' })

test.describe('Collaboration group native coordinate execution', () => {
  let model: IssueDispatchMockModel | undefined

  test.beforeAll(async ({ request }) => {
    model = await createIssueDispatchMockModel(request, suiteSuffix)
  })

  test.afterAll(async ({ request }) => {
    if (model) await deleteIssueDispatchMockModel(request, model)
  })

  test('assigns one manager execution, runs two native subagents, and lets the manager update status', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(240_000)
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')

    const suffix = `${Date.now()}`
    const issueTitle = `Coordinate CPU investigation ${suffix}`
    const collectorTask = `Collect CPU evidence ${suffix}`
    const reviewerTask = `Review CPU evidence ${suffix}`
    const collectorEvidence = `COLLECTOR_EVIDENCE_${suffix}`
    const reviewerEvidence = `REVIEWER_EVIDENCE_${suffix}`
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

    const clearManagerScenario = await configureIssueDispatchModelScenario(
      request,
      issueTitle,
      [
        {
          toolCalls: [
            {
              toolName: 'spawn_agent',
              arguments: {
                agent_type: 'wegent_member_1',
                message: `${collectorTask}. Return ${collectorEvidence}.`,
              },
            },
            {
              toolName: 'spawn_agent',
              arguments: {
                agent_type: 'wegent_member_2',
                message: `${reviewerTask}. Return ${reviewerEvidence}.`,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolName: 'wait_agent',
              arguments: {
                targets: ['$scenario.agent_id:0'],
                timeout_ms: 120_000,
              },
            },
            {
              toolName: 'wait_agent',
              arguments: {
                targets: ['$scenario.agent_id:1'],
                timeout_ms: 120_000,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolName: 'wework_space__update_issue_status',
              arguments: {
                target_status: 'in_review',
                reason: `Both native member results were evaluated: ${collectorEvidence}, ${reviewerEvidence}.`,
              },
            },
          ],
        },
        {
          responseContent: `Manager evaluated ${collectorEvidence} and ${reviewerEvidence}.`,
        },
      ],
      { matchHeaders: parentHeaders }
    )
    const clearCollectorScenario = await configureIssueDispatchModelScenario(
      request,
      collectorTask,
      [{ responseContent: collectorEvidence }],
      { matchHeaders: childHeaders }
    )
    const clearReviewerScenario = await configureIssueDispatchModelScenario(
      request,
      reviewerTask,
      [{ responseContent: reviewerEvidence }],
      { matchHeaders: childHeaders }
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

      const execution = await waitForManagerExecution(
        request,
        model.token,
        fixture.projectId,
        fixture.issueId
      )
      expect(execution.observedState).toBe('succeeded')
      expect(execution.displayState).toBe('succeeded')
      expect(execution.teamId).toBeTruthy()
      expect(execution.runtimeTaskId).toMatch(/^codex-queue-\d+$/)
      const executions = await apiRequest<{ items: CollaborationExecution[] }>(
        request,
        model.token,
        `/api/v1/cloud-projects/${fixture.projectId}/executions`
      )
      expect(executions.items.filter(item => item.loopItemId === fixture.issueId)).toHaveLength(1)

      const completed = await waitForIssueStatus(request, model.token, fixture.issueId, 'in_review')
      expect(completed.execution_state).toBe('succeeded')

      const managerBodies = await getScenarioModelBodies(request, issueTitle)
      const managerHeaders = await getScenarioRequestHeaders(request, issueTitle)
      const managerScenario = await getToolScenarioState(request, issueTitle)
      expect(managerBodies.length).toBeGreaterThanOrEqual(4)
      expect(managerScenario.nextStep).toBe(4)
      expect(managerHeaders).toHaveLength(managerBodies.length)
      expect(managerHeaders.every(headers => headers['x-openai-subagent'] === undefined)).toBe(true)
      expect(modelToolNames(managerBodies).some(isSpawnAgent)).toBe(true)
      expect(modelToolNames(managerBodies).some(isWaitAgent)).toBe(true)
      expect(modelToolNames(managerBodies).some(isUpdateIssueStatus)).toBe(true)
      expect(modelRequestText(managerBodies.slice(0, 1))).toContain(
        'Project collaboration rules and workflow'
      )
      expect(modelRequestText(managerBodies.slice(2))).toContain(collectorEvidence)
      expect(modelRequestText(managerBodies.slice(2))).toContain(reviewerEvidence)

      const collectorHeaders = await getScenarioRequestHeaders(request, collectorTask)
      const reviewerHeaders = await getScenarioRequestHeaders(request, reviewerTask)
      const collectorScenario = await getToolScenarioState(request, collectorTask)
      const reviewerScenario = await getToolScenarioState(request, reviewerTask)
      expect(collectorScenario.nextStep).toBe(1)
      expect(reviewerScenario.nextStep).toBe(1)
      expect(collectorHeaders).not.toHaveLength(0)
      expect(reviewerHeaders).not.toHaveLength(0)
      expect(
        collectorHeaders.every(headers => headers['x-openai-subagent'] === 'collab_spawn')
      ).toBe(true)
      expect(
        reviewerHeaders.every(headers => headers['x-openai-subagent'] === 'collab_spawn')
      ).toBe(true)

      await page.reload()
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
      await expect(page.getByText(collectorEvidence, { exact: false }).first()).toBeVisible()
      await expect(page.getByText(reviewerEvidence, { exact: false }).first()).toBeVisible()
      await captureEvidence(page, testInfo, '02-manager-reviewed-native-members')
    } finally {
      await clearReviewerScenario()
      await clearCollectorScenario()
      await clearManagerScenario()
    }
  })
})

function isSpawnAgent(name: string): boolean {
  return name.endsWith('spawn_agent')
}

function isWaitAgent(name: string): boolean {
  return name.endsWith('wait_agent')
}

function isUpdateIssueStatus(name: string): boolean {
  return name.endsWith('update_issue_status')
}

async function waitForManagerExecution(
  request: APIRequestContext,
  token: string,
  projectId: string,
  issueId: string
): Promise<CollaborationExecution> {
  let completed: CollaborationExecution | undefined
  await expect
    .poll(
      async () => {
        const response = await apiRequest<{ items: CollaborationExecution[] }>(
          request,
          token,
          `/api/v1/cloud-projects/${projectId}/executions?status=completed`
        )
        completed = response.items.find(item => item.loopItemId === issueId)
        return completed?.status ?? 'missing'
      },
      {
        timeout: 180_000,
        message: `Manager execution for Issue ${issueId} should complete`,
      }
    )
    .toBe('completed')
  return completed!
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
