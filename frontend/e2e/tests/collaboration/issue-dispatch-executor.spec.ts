// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import {
  addProjectMember,
  configureIssueDispatchModelScenario,
  createCollaborationGroup,
  createIssueDispatchMockModel,
  createProjectAgent,
  createProjectFixture,
  deleteIssueDispatchMockModel,
  dispatchToFirstTarget,
  type IssueDispatchMockModel,
} from '../../utils/issue-dispatch-test-support'
import { PROVIDER_NATIVE_MOCK_URL } from '../../utils/provider-native-test-support'

const suiteSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test.describe.configure({ mode: 'serial' })

test.describe('Issue Dispatch executor and manager lifecycle', () => {
  let model: IssueDispatchMockModel | undefined

  test.beforeAll(async ({ request }) => {
    model = await createIssueDispatchMockModel(request, suiteSuffix)
  })

  test.afterAll(async ({ request }) => {
    if (model) await deleteIssueDispatchMockModel(request, model)
  })

  test('routes an agent automatically and exposes queued and running cancellation', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000)
    const suffix = `${Date.now()}`
    const issueTitle = `Agent dispatch ${suffix}`
    const fixture = await createProjectFixture(page, suffix, issueTitle)
    const agentName = `Dispatch Agent ${suffix}`
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')
    await createProjectAgent(page, agentName, model.modelName)
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)

    const queuedTitle = `Queued cancellation ${suffix}`
    await dispatchToFirstTarget(page, 'agent', queuedTitle)
    let queuedTask = page
      .locator('[data-testid^="issue-dispatch-task-"][data-state]')
      .filter({ hasText: queuedTitle })
      .last()
    await expect(queuedTask).toHaveAttribute('data-state', /queued|running/)
    await expect(queuedTask).toHaveAttribute('data-execution-location', /local|cloud/)
    await captureEvidence(page, testInfo, '01-agent-queued')
    await queuedTask.getByTestId('issue-dispatch-task-cancel').click()
    await expect(queuedTask).toHaveAttribute('data-state', 'cancelled')
    await expect(page.getByTestId('cloud-todo-detail-status')).not.toHaveValue('in_review')
    await captureEvidence(page, testInfo, '02-agent-queued-cancelled')

    const clearRunningScenario = await configureSlowAgentCompletion(request, queuedTitle)
    try {
      await page.getByTestId('issue-dispatch-retry').click()
      queuedTask = page
        .locator('[data-testid^="issue-dispatch-task-"][data-state]')
        .filter({ hasText: queuedTitle })
        .last()
      await expect(queuedTask).toHaveAttribute('data-state', 'running', { timeout: 60_000 })
      await queuedTask.scrollIntoViewIfNeeded()
      await captureEvidence(page, testInfo, '03-agent-running')
      await queuedTask.getByTestId('issue-dispatch-task-cancel').click()
      await expect(queuedTask).toHaveAttribute('data-state', 'cancelled')
      await captureEvidence(page, testInfo, '04-agent-running-cancelled')
    } finally {
      await clearRunningScenario()
    }

    const clearScenario = await configureAgentCompletion(request, queuedTitle, suffix)
    try {
      await page.getByTestId('issue-dispatch-retry').click()
      const completedTask = page
        .locator('[data-testid^="issue-dispatch-task-"][data-state]')
        .filter({ hasText: queuedTitle })
        .last()
      await expect(completedTask).toHaveAttribute('data-state', 'submitted', {
        timeout: 120_000,
      })
      await expect(completedTask).toContainText(queuedTitle)
      await expect(completedTask).not.toContainText(issueTitle)
      await expect(completedTask.getByTestId('issue-dispatch-assignee-avatar')).toHaveAttribute(
        'title',
        agentName
      )
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
      await completedTask.scrollIntoViewIfNeeded()
      await captureEvidence(page, testInfo, '05-agent-retry-delivered-in-review')
    } finally {
      await clearScenario()
    }
  })

  test('returns concurrent agent outcomes to an AI leader for multiple rounds', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(240_000)
    const suffix = `${Date.now()}`
    const issueTitle = `AI leader dispatch ${suffix}`
    const fixture = await createProjectFixture(page, suffix, issueTitle)
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')
    const leader = await createProjectAgent(page, `AI Leader ${suffix}`, model.modelName)
    const collector = await createProjectAgent(page, `AI Collector ${suffix}`, model.modelName)
    const reviewer = await createProjectAgent(page, `AI Reviewer ${suffix}`, model.modelName)
    const roundOneCollectorTitle = `Collect agent evidence ${suffix}`
    const roundOneReviewerTitle = `Review agent evidence ${suffix}`
    const roundTwoReviewerTitle = `Verify combined evidence ${suffix}`
    await createCollaborationGroup(page, `AI Group ${suffix}`, {
      agentIds: [leader.id, collector.id, reviewer.id],
      humanId: '',
      leader: { id: leader.id, type: 'agent' },
    })
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)

    const clearManagerScenario = await configureIssueDispatchModelScenario(request, issueTitle, [
      {
        toolCalls: [
          {
            toolName: 'wework_space__create_dispatch_round',
            arguments: {
              idempotency_key: `round-1-${suffix}`,
              tasks: [
                {
                  task_title: roundOneCollectorTitle,
                  instructions: 'Collect reproducible evidence and create a Delivery.',
                  assignee_type: 'agent',
                  assignee_id: collector.id,
                },
                {
                  task_title: roundOneReviewerTitle,
                  instructions: 'Independently review the collected evidence.',
                  assignee_type: 'agent',
                  assignee_id: reviewer.id,
                },
              ],
            },
          },
        ],
      },
      { responseContent: 'The first concurrent round has been assigned.' },
      {
        toolCalls: [
          {
            toolName: 'wework_space__create_dispatch_round',
            arguments: {
              idempotency_key: `round-2-${suffix}`,
              tasks: [
                {
                  task_title: roundTwoReviewerTitle,
                  instructions: 'Verify all evidence from the previous round.',
                  assignee_type: 'agent',
                  assignee_id: reviewer.id,
                },
              ],
            },
          },
        ],
      },
      { responseContent: 'The verification round has been assigned.' },
      {
        toolCalls: [
          {
            toolName: 'wework_space__update_issue_status',
            arguments: {
              idempotency_key: `decision-${suffix}`,
              target_status: 'in_review',
              reason: 'All round outcomes contain reproducible evidence.',
            },
          },
        ],
      },
      { responseContent: 'The Issue is ready for review.' },
    ])
    const clearRoundOneAgentDelays = await configureAgentDelays(
      request,
      [roundOneCollectorTitle, roundOneReviewerTitle],
      3_000
    )
    const clearRoundTwoAgentDelay = await configureAgentDelays(
      request,
      [roundTwoReviewerTitle],
      15_000
    )
    try {
      await dispatchToFirstTarget(page, 'group', `Investigate issue ${suffix}`)
      const roundOne = page.getByTestId('issue-dispatch-round-1')
      await expect(
        roundOne.locator('[data-testid^="issue-dispatch-task-"][data-state]')
      ).toHaveCount(2, { timeout: 60_000 })
      await expect(roundOne).toHaveAttribute('data-state', 'executing')
      await expect(roundOne.locator('[data-assignee-type="agent"]')).toHaveCount(2)
      await captureEvidence(page, testInfo, '01-ai-leader-concurrent-round')

      const roundTwo = page.getByTestId('issue-dispatch-round-2')
      await expect(roundTwo).toBeVisible({ timeout: 120_000 })
      await expect(roundOne).toHaveAttribute('data-state', 'closed')
      await expect(roundOne.getByTestId('issue-dispatch-round-progress')).toHaveText('2 / 2')
      await expect(page.getByTestId('issue-dispatch-manager-turn-count')).toHaveText('2')
      await expect(page.getByTestId('cloud-todo-detail-status')).not.toHaveValue('completed')
      await expect(roundTwo).toHaveAttribute('data-state', 'executing')
      await roundTwo.scrollIntoViewIfNeeded()
      await captureEvidence(page, testInfo, '02-ai-leader-round-returned')

      await expect(
        roundTwo.locator('[data-testid^="issue-dispatch-task-"][data-state]')
      ).toHaveCount(1)
      await expect(roundTwo).toHaveAttribute('data-state', 'closed', { timeout: 120_000 })
      await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
      await roundTwo.scrollIntoViewIfNeeded()
      await captureEvidence(page, testInfo, '03-ai-leader-final-decision')
    } finally {
      await clearRoundOneAgentDelays()
      await clearRoundTwoAgentDelay()
      await clearManagerScenario()
    }
  })

  test('lets the actual human leader create a round and make the only status decision', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000)
    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(page, suffix, `Human leader dispatch ${suffix}`)
    if (!model) throw new Error('Issue Dispatch mock model was not provisioned')
    const humanId = await addProjectMember(page, REGULAR_USER.username)
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
    const executor = await createProjectAgent(
      page,
      `Human Group Executor ${suffix}`,
      model.modelName
    )
    const groupName = `Human Leader Group ${suffix}`
    await createCollaborationGroup(page, groupName, {
      agentIds: [executor.id],
      humanId,
      leader: { id: humanId, type: 'human' },
    })
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
    await dispatchToFirstTarget(page, 'group', `Human leader investigation ${suffix}`, groupName)

    const login = await createApiClient(request).login(
      REGULAR_USER.username,
      REGULAR_USER.password,
      1
    )
    expect(login.status).toBe(200)
    const token = login.data?.access_token
    if (!token) throw new Error('Regular E2E user login did not return an access token')
    const leaderContext = await browser.newContext({
      storageState: buildStorageState(
        process.env.E2E_BASE_URL || 'http://localhost:3000',
        token,
        getJwtExpiryMs(token)
      ),
    })
    const leaderPage = await leaderContext.newPage()
    try {
      await leaderPage.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
      await expect(leaderPage.getByTestId('issue-dispatch-leader-action-required')).toBeVisible()
      await leaderPage.getByTestId('issue-dispatch-create-round').click()
      const taskRow = leaderPage.getByTestId('issue-dispatch-round-task-0')
      await taskRow
        .getByTestId('issue-dispatch-round-task-title-0')
        .fill(`Collect evidence ${suffix}`)
      await taskRow
        .getByTestId('issue-dispatch-round-task-instructions')
        .fill('Collect independently verifiable evidence and submit the result.')
      await taskRow
        .getByTestId('issue-dispatch-round-task-assignee-0')
        .selectOption({ label: `Human Group Executor ${suffix}` })
      await captureEvidence(leaderPage, testInfo, '01-human-leader-round-editor')
      await leaderPage.getByTestId('issue-dispatch-round-submit').click()

      const round = leaderPage.getByTestId('issue-dispatch-round-1')
      await expect(round.locator('[data-testid^="issue-dispatch-task-"][data-state]')).toHaveCount(
        1
      )
      await expect(round).toHaveAttribute('data-state', 'evaluating', { timeout: 120_000 })
      await expect(leaderPage.getByTestId('cloud-todo-detail-status')).not.toHaveValue('completed')
      await captureEvidence(leaderPage, testInfo, '02-human-leader-round-returned')
      await leaderPage.getByTestId('issue-dispatch-leader-decide').click()
      await leaderPage.getByTestId('issue-dispatch-decision-status').selectOption('in_review')
      await leaderPage
        .getByTestId('issue-dispatch-decision-reason')
        .fill('Evidence is ready for review.')
      await leaderPage.getByTestId('issue-dispatch-decision-submit').click()
      await expect(leaderPage.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
      await captureEvidence(leaderPage, testInfo, '03-human-leader-final-decision')
    } finally {
      await leaderContext.close()
    }
  })
})

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function configureAgentCompletion(
  request: APIRequestContext,
  taskTitle: string,
  suffix: string
): Promise<() => Promise<void>> {
  return configureIssueDispatchModelScenario(request, taskTitle, [
    {
      responseContent: `Agent delivery evidence ${suffix}. The assigned task is complete.`,
    },
  ])
}

async function configureSlowAgentCompletion(
  request: APIRequestContext,
  taskTitle: string
): Promise<() => Promise<void>> {
  const response = await request.post(`${PROVIDER_NATIVE_MOCK_URL}/stream-rules`, {
    data: {
      matchText: taskTitle,
      responseContent: 'The assigned task remains active until cancellation.',
      doneDelayMs: 60_000,
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  return async () => {
    const cleanup = await request.delete(
      `${PROVIDER_NATIVE_MOCK_URL}/stream-rules?matchText=${encodeURIComponent(taskTitle)}`
    )
    expect(cleanup.status(), await cleanup.text()).toBe(200)
  }
}

async function configureAgentDelays(
  request: APIRequestContext,
  taskTitles: string[],
  doneDelayMs = 3_000
): Promise<() => Promise<void>> {
  for (const taskTitle of taskTitles) {
    const response = await request.post(`${PROVIDER_NATIVE_MOCK_URL}/stream-rules`, {
      data: {
        matchText: taskTitle,
        responseContent: `Delivery evidence for ${taskTitle}.`,
        doneDelayMs,
      },
    })
    expect(response.status(), await response.text()).toBe(200)
  }

  return async () => {
    for (const taskTitle of taskTitles) {
      const cleanup = await request.delete(
        `${PROVIDER_NATIVE_MOCK_URL}/stream-rules?matchText=${encodeURIComponent(taskTitle)}`
      )
      expect(cleanup.status(), await cleanup.text()).toBe(200)
    }
  }
}
