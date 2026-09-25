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
  loopItemId: string
  status: string
  observedState: string
  displayState: string
  teamId: number | null
  executorType: string
  runtimeTaskId: string | null
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

  test('dispatches independent member executions and lets a fresh manager round update status', async ({
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

    const clearManagerScenario = await configureIssueDispatchModelScenario(request, issueTitle, [
      {
        toolCalls: [
          {
            toolName: 'wework_space__submit_workflow_plan',
            arguments: {
              plan: {
                round_id: `round-${suffix}`,
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
          'The current collaboration round was dispatched. Waiting for Executor results.',
      },
      {
        toolCalls: [
          {
            toolName: 'wework_space__update_issue_status',
            arguments: {
              status: 'in_review',
              reason: `Both independent member results were evaluated: ${collectorEvidence}, ${reviewerEvidence}.`,
              comment:
                'The manager reviewed both parallel assignments and submitted the Issue for confirmation.',
            },
          },
        ],
      },
      {
        responseContent: `Manager evaluated ${collectorEvidence} and ${reviewerEvidence}.`,
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

      const executions = await waitForCollaborationExecutions(
        request,
        model.token,
        fixture.projectId,
        fixture.issueId,
        3
      )
      const dispatches = executions.filter(
        item => item.executorType === 'collaboration_group_dispatch'
      )
      const members = executions.filter(
        item => item.executorType !== 'collaboration_group_dispatch'
      )
      expect(dispatches).toHaveLength(1)
      expect(members).toHaveLength(2)
      expect(new Set(members.map(item => item.runtimeTaskId)).size).toBe(2)
      expect(members.every(item => item.status === 'completed')).toBe(true)

      const completed = await waitForIssueStatus(request, model.token, fixture.issueId, 'in_review')
      expect(completed.execution_state).not.toBe('failed')

      const managerBodies = await getScenarioModelBodies(request, issueTitle)
      const managerScenario = await getToolScenarioState(request, issueTitle)
      expect(managerBodies.length).toBeGreaterThanOrEqual(4)
      expect(managerScenario.nextStep).toBe(4)
      expect(modelToolNames(managerBodies).some(isSubmitWorkflowPlan)).toBe(true)
      expect(modelToolNames(managerBodies).some(isUpdateIssueStatus)).toBe(true)
      expect(modelToolNames(managerBodies).some(isNativeSubagentTool)).toBe(false)
      expect(modelRequestText(managerBodies.slice(0, 1))).toContain(
        'Project collaboration rules and workflow'
      )
      expect(modelRequestText(managerBodies.slice(2))).toContain(collectorEvidence)
      expect(modelRequestText(managerBodies.slice(2))).toContain(reviewerEvidence)

      const collectorScenario = await getToolScenarioState(request, collectorTask)
      const reviewerScenario = await getToolScenarioState(request, reviewerTask)
      expect(collectorScenario.nextStep).toBe(1)
      expect(reviewerScenario.nextStep).toBe(1)

      await page.reload()
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
      await expect(page.getByText(collectorTask, { exact: false }).first()).toBeVisible()
      await expect(page.getByText(reviewerTask, { exact: false }).first()).toBeVisible()
      await expect(
        page.getByText('The manager reviewed both parallel assignments', { exact: false }).first()
      ).toBeVisible()
      await captureEvidence(page, testInfo, '02-manager-reviewed-executor-members')
    } finally {
      await clearReviewerScenario()
      await clearCollectorScenario()
      await clearManagerScenario()
    }
  })
})

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
          `/api/v1/cloud-projects/${projectId}/executions`
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
