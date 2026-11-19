// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER, type TestUser } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { createGithubQualityHttpFixture } from '../../utils/github-quality-http-fixture'
import { webApi } from '../../utils/collaboration-test-support'
import { addProjectMember, createProjectFixture } from '../../utils/issue-dispatch-test-support'
import {
  cleanupStageDispatch,
  seedStageDispatch,
  snapshotStageIssue,
  submitWorkflowPlan,
} from '../../utils/stage-dispatch-test-support'
import {
  addQualityProjectMember,
  collaborationNotificationCounts,
  configureQualityIssue,
  createPollingGithubHook,
  createQualityUsers,
  deleteQualityIncomingHook,
  issueCommentCount,
  issueEventCount,
  loginQualityUser,
  qualityWorkflow,
  removeProjectEventConnection,
  removeQualityProjectMember,
  seedProjectEventConnection,
  submitQualityReview,
  triggerProjectEventPolling,
  type QualityIncomingHook,
  type QualityIncomingEvent,
  type QualityIssue,
  type QualityAccount,
} from '../../utils/quality-handoff-test-support'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'

interface AssignmentNotification {
  kind: string
  title: string
  payload: {
    action?: string
    projectId?: string
    itemId?: string
    issueId?: string
    dispatchTaskId?: string
    humanAssignmentId?: string
    taskTitle?: string
    instructions?: string
  }
}

interface SavedIssue {
  id: string
  title: string
  description: string
  status: string
  assignee_user_id: number | null
}

interface StageIssue extends SavedIssue {
  version: number
  tags: string[]
  workflow: { current_stage_id: string | null }
}

async function saveSilently(page: Page, testId: string): Promise<void> {
  await page.getByTestId(`${testId}-options`).click()
  const action = page.getByTestId(`${testId}-without-notification`)
  await expect(action).toHaveText(/^(仅保存不通知|Save without notifying)$/)
  await action.click()
}

async function selectAssigneeSilently(page: Page, userId: string | number): Promise<void> {
  await page.getByTestId('cloud-todo-detail-assignee').click()
  await page.getByTestId('cloud-todo-assignee-notify').uncheck()
  await page.getByTestId(`cloud-todo-detail-assignee-option-user:${userId}`).click()
}

async function expectNoAssignmentNotification(
  request: APIRequestContext,
  issueId: string,
  recipient: Pick<TestUser, 'username' | 'password'> = REGULAR_USER
): Promise<void> {
  const login = await createApiClient(request).login(recipient.username, recipient.password)
  expect(login.data?.access_token).toBeTruthy()
  const response = await request.get(
    `${API_BASE_URL}/api/v1/wework-notifications?category=collaboration`,
    { headers: { Authorization: `Bearer ${login.data!.access_token}` } }
  )
  expect(response.status(), await response.text()).toBe(200)
  const inbox = (await response.json()) as { items: AssignmentNotification[] }
  expect(
    inbox.items.filter(
      item =>
        item.kind === 'issue_dispatch_assignment' &&
        (item.payload.issueId === issueId || item.payload.itemId === issueId)
    )
  ).toEqual([])
}

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function waitForAssignmentNotification(
  request: APIRequestContext,
  issueId: string
): Promise<AssignmentNotification> {
  const login = await createApiClient(request).login(REGULAR_USER.username, REGULAR_USER.password)
  const token = login.data?.access_token
  expect(token, 'Regular user login should return an access token').toBeTruthy()

  let notification: AssignmentNotification | undefined
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${API_BASE_URL}/api/v1/wework-notifications?category=collaboration`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        expect(response.status(), await response.text()).toBe(200)
        const inbox = (await response.json()) as { items: AssignmentNotification[] }
        notification = inbox.items.find(
          item => item.kind === 'issue_dispatch_assignment' && item.payload.issueId === issueId
        )
        return notification?.payload.action
      },
      {
        message: `Issue ${issueId} should produce a Wework human assignment notification`,
      }
    )
    .toBe('open_issue')
  return notification!
}

test.describe('Issue Dispatch human assignment', () => {
  test('enforces stage owners across assignment and PATCH and advances a reassigned introduction', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(page, suffix, `Stage owner ${suffix}`)
    const memberId = await addProjectMember(page, REGULAR_USER.username)
    const owner = await webApi<{ id: number }>(page, '/api/users/me')
    const issuePath = `/api/v1/loop-items/${fixture.issueId}`
    const assignmentPath = `/api/v1/cloud-projects/${fixture.projectId}/loop-items/${fixture.issueId}/assign`
    const original = await webApi<StageIssue>(page, issuePath)
    const constrained = await webApi<StageIssue>(page, issuePath, {
      method: 'PATCH',
      body: {
        version: original.version,
        assignee_user_id: owner.id,
        notify_assignee: false,
        workflow: {
          stage_mode: 'dag',
          current_stage_id: 'technical-review',
          nodes: [
            {
              id: 'technical-review',
              name: 'Technical review',
              status: 'ready',
              required_assignee_type: 'user',
              required_assignee_id: String(owner.id),
            },
          ],
        },
      },
    })

    for (const method of ['POST', 'PATCH']) {
      const rejected = await page.evaluate(
        async ({ path, requestMethod, version, assigneeId }) => {
          const response = await fetch(path, {
            method: requestMethod,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              version,
              notify_assignee: false,
              ...(requestMethod === 'POST'
                ? { assignee_type: 'user', assignee_id: assigneeId }
                : { assignee_user_id: Number(assigneeId) }),
            }),
          })
          return { status: response.status, body: await response.json() }
        },
        {
          path: method === 'POST' ? assignmentPath : issuePath,
          requestMethod: method,
          version: constrained.version,
          assigneeId: memberId,
        }
      )
      expect(rejected.status).toBe(422)
      expect(rejected.body.detail).toMatchObject({
        reason_code: 'stage_assignee_mismatch',
        issue_version: constrained.version,
        stage_id: 'technical-review',
        expected_assignee: { assignee_type: 'user', assignee_id: String(owner.id) },
        actual_assignee: { assignee_type: 'user', assignee_id: memberId },
      })
      expect(await webApi<StageIssue>(page, issuePath)).toMatchObject({
        version: constrained.version,
        assignee_user_id: owner.id,
        workflow: { current_stage_id: 'technical-review' },
      })
    }

    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
    await selectAssigneeSilently(page, memberId)
    const saveError = page.getByTestId('cloud-todo-save-error')
    await expect(saveError).toContainText(/不符合当前阶段|does not match the current stage/)
    await expect(saveError).not.toContainText('stage_assignee_mismatch')
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${owner.id}`
    )
    expect(await webApi<StageIssue>(page, issuePath)).toMatchObject({
      version: constrained.version,
      assignee_user_id: owner.id,
      workflow: { current_stage_id: 'technical-review' },
    })
    await expectNoAssignmentNotification(request, fixture.issueId)

    const assigned = await webApi<StageIssue>(page, assignmentPath, {
      method: 'POST',
      body: {
        version: constrained.version,
        assignee_type: 'user',
        assignee_id: String(owner.id),
        notify_assignee: false,
      },
    })
    expect(assigned.assignee_user_id).toBe(owner.id)

    // Applying a product introduction and changing its owner is one atomic write.
    const reviewed = await webApi<StageIssue>(page, issuePath, {
      method: 'PATCH',
      body: {
        version: assigned.version,
        status: 'pending',
        tags: ['需求提出'],
        assignee_user_id: Number(memberId),
        notify_assignee: false,
        workflow: {
          stage_mode: 'dag',
          feature_flags: { 'collab.enforceStageAssignee.v1': true },
          current_stage_id: 'introduction',
          nodes: [
            {
              id: 'introduction',
              name: '需求提出',
              status: 'ready',
              required_assignee_type: 'user',
              required_assignee_id: 'jiangyang7',
            },
            {
              id: 'common-review',
              name: '共同评审',
              depends_on: ['introduction'],
            },
          ],
        },
      },
    })
    expect(reviewed).toMatchObject({
      version: assigned.version + 1,
      status: 'pending',
      assignee_user_id: Number(memberId),
      workflow: { current_stage_id: 'common-review' },
    })
    expect(reviewed.tags).toContain('共同评审')
    expect(reviewed.tags).not.toContain('需求提出')
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${memberId}`
    )
    await expectNoAssignmentNotification(request, fixture.issueId)
    await captureEvidence(page, testInfo, 'stage-owner-common-review')
  })

  test('rejects manager materialization when a constrained owner loses project access', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const fixture = await createProjectFixture(page, suffix, `Lost stage owner ${suffix}`)
    const targetPassword = `Lost-${suffix}-${crypto.randomUUID()}`
    const target = await webApi<{ id: number; user_name: string }>(page, '/api/admin/users', {
      method: 'POST',
      body: {
        user_name: `lost-stage-owner-${suffix}`,
        password: targetPassword,
        role: 'user',
      },
    })
    const issuePath = `/api/v1/loop-items/${fixture.issueId}`
    let dispatch: Awaited<ReturnType<typeof seedStageDispatch>> | undefined
    try {
      await addQualityProjectMember(page, fixture.projectId, target.id)
      const current = await webApi<StageIssue>(page, issuePath)
      const constrained = await webApi<StageIssue>(page, issuePath, {
        method: 'PATCH',
        body: {
          version: current.version,
          status: 'in_progress',
          assignee_user_id: target.id,
          notify_assignee: false,
          tags: ['开发实现'],
          workflow: {
            stage_mode: 'dag',
            current_stage_id: 'lost-access',
            feature_flags: { 'collab.enforceStageAssignee.v1': true },
            nodes: [
              {
                id: 'lost-access',
                name: '开发实现',
                status: 'running',
                required_assignee_type: 'user',
                required_assignee_id: String(target.id),
              },
            ],
          },
        },
      })
      dispatch = await seedStageDispatch(fixture.issueId, target.id)
      await removeQualityProjectMember(page, fixture.projectId, target.id)
      const before = await snapshotStageIssue(fixture.issueId)

      const planned = await submitWorkflowPlan(page, fixture.projectId, {
        loop_item_id: fixture.issueId,
        dispatch_id: dispatch.dispatch_id,
        round_id: `lost-access-${suffix}`,
        manager_runtime_task_id: dispatch.manager_runtime_task_id,
        manager_agent_id: dispatch.manager_agent_id,
        items: [
          {
            assignment_id: `lost-access-${suffix}`,
            title: 'Review after access removal',
            instructions: 'This constrained target must not materialize.',
            assignee_type: 'human',
            assignee_id: String(target.id),
            workflow_stage_id: 'lost-access',
          },
        ],
      })

      expect(planned.status).toBe(422)
      expect(planned.body.detail).toMatchObject({
        reason_code: 'stage_assignee_mismatch',
        issue_version: constrained.version,
        stage_id: 'lost-access',
        expected_assignee: {
          assignee_type: 'user',
          assignee_id: String(target.id),
        },
        actual_assignee: {
          assignee_type: 'user',
          assignee_id: String(target.id),
        },
      })
      expect(planned.body.detail).toEqual(
        expect.objectContaining({
          reason: expect.stringContaining('project access'),
        })
      )
      expect(await snapshotStageIssue(fixture.issueId)).toEqual(before)
      expect(
        await collaborationNotificationCounts(
          request,
          { user_name: target.user_name, password: targetPassword },
          fixture.issueId
        )
      ).toEqual({ assignments: 0, total: 0 })
    } finally {
      if (dispatch) {
        await cleanupStageDispatch(fixture.issueId, dispatch.manager_agent_id).catch(
          () => undefined
        )
      }
      await removeQualityProjectMember(page, fixture.projectId, target.id).catch(() => undefined)
      await webApi(page, `/api/admin/users/${target.id}`, { method: 'DELETE' }).catch(
        () => undefined
      )
    }
  })

  test('assigns the Issue to a project member without auto-completing it', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(page, suffix, `Human dispatch ${suffix}`)
    const memberId = await addProjectMember(page, REGULAR_USER.username)
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
    await captureEvidence(page, testInfo, '01-issue-before-dispatch')

    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId(`cloud-todo-detail-assignee-option-user:${memberId}`).click()
    await expect(page.getByTestId('wework-assignment-notify-confirm')).toHaveCount(0)
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${memberId}`
    )
    await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('inbox')

    const notification = await waitForAssignmentNotification(request, fixture.issueId)
    expect(notification.payload).toMatchObject({
      action: 'open_issue',
      projectId: fixture.projectId,
      itemId: fixture.issueId,
      issueId: fixture.issueId,
      taskTitle: `Human dispatch ${suffix}`,
    })
    expect(notification.payload.dispatchTaskId).toBeTruthy()
    expect(notification.payload.humanAssignmentId).toBe(notification.payload.dispatchTaskId)
    expect(notification.payload.instructions).toContain('Collect reproducible evidence')
    await captureEvidence(page, testInfo, '02-human-assignment-recorded')
  })

  test('collects changed PR heads through quality handoffs and deduplicates replays', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const fixture = await createProjectFixture(page, suffix, `Quality handoff ${suffix}`)
    const engineer = await webApi<{ id: number }>(page, '/api/users/me')
    const users = await createQualityUsers(page, fixture.projectId, suffix)
    const provider = await createGithubQualityHttpFixture()
    const credentialRef = `quality-event-${suffix}`
    let connectionSeeded = false
    let hook: QualityIncomingHook | undefined
    try {
      await seedProjectEventConnection(engineer.id, credentialRef, provider.token)
      connectionSeeded = true
      const workflow = qualityWorkflow(engineer.id, users)
      const issueA = await configureQualityIssue(
        page,
        fixture.projectId,
        fixture.issueId,
        provider.prUrl(1),
        engineer.id,
        workflow
      )
      const createdB = await webApi<{ id: string }>(
        page,
        `/api/v1/cloud-projects/${fixture.projectId}/loop-items`,
        {
          method: 'POST',
          body: { title: `Failed head ${suffix}`, notify_assignee: false },
        }
      )
      const createdC = await webApi<{ id: string }>(
        page,
        `/api/v1/cloud-projects/${fixture.projectId}/loop-items`,
        {
          method: 'POST',
          body: { title: `Conflicted head ${suffix}`, notify_assignee: false },
        }
      )
      const issueB = await configureQualityIssue(
        page,
        fixture.projectId,
        createdB.id,
        provider.prUrl(2),
        engineer.id,
        workflow
      )
      const issueC = await configureQualityIssue(
        page,
        fixture.projectId,
        createdC.id,
        provider.prUrl(3),
        engineer.id,
        workflow
      )
      hook = await createPollingGithubHook(page, fixture.projectId, provider, credentialRef)

      const issueIds = [issueA.id, issueB.id, issueC.id]
      const readIssue = (issueId: string) =>
        webApi<QualityIssue>(page, `/api/v1/loop-items/${issueId}`)
      const readStableState = async (issueId: string, consumers: QualityAccount[]) => {
        const issue = await readIssue(issueId)
        return {
          version: issue.version,
          status: issue.status,
          stage: issue.workflow.current_stage_id,
          assignee: issue.assignee_user_id,
          assignmentHistoryLength: issue.assignment_history?.length ?? 0,
          commentCount: await issueCommentCount(page, issueId),
          notifications: await Promise.all(
            consumers.map(consumer => collaborationNotificationCounts(request, consumer, issueId))
          ),
        }
      }

      const initialRequestCount = provider.requests.length
      await triggerProjectEventPolling(hook.id)
      expect(provider.requests.length).toBeGreaterThan(initialRequestCount)
      await expect
        .poll(
          async () => {
            const issues = await Promise.all(issueIds.map(readIssue))
            return issues.map(issue => ({
              status: issue.status,
              stage: issue.workflow.current_stage_id,
              assignee: issue.assignee_user_id,
              role: issue.quality_handoff?.required_assignee_role,
            }))
          },
          {
            message: 'The real event poller should hand every green PR to the project QA',
            timeout: 30_000,
            intervals: [500],
          }
        )
        .toEqual(
          issueIds.map(() => ({
            status: 'in_review',
            stage: 'quality',
            assignee: users.qa.id,
            role: 'qa',
          }))
        )

      const qaToken = await loginQualityUser(request, users.qa)
      const beforeRemoval = await readIssue(issueA.id)
      await removeQualityProjectMember(page, fixture.projectId, users.qa.id)
      const rejected = await submitQualityReview(request, qaToken, issueA.id, {
        version: beforeRemoval.version,
        idempotency_key: `qa-without-access-${suffix}`,
        pr_head_sha: 'head-a-1',
      })
      expect(rejected.status).toBe(403)
      expect(rejected.text).toContain('quality_review_owner_required')
      expect(await readIssue(issueA.id)).toMatchObject({
        version: beforeRemoval.version,
        status: 'in_review',
        assignee_user_id: users.qa.id,
        workflow: { current_stage_id: 'quality' },
      })
      await addQualityProjectMember(page, fixture.projectId, users.qa.id)

      const qaReview = await submitQualityReview(request, qaToken, issueA.id, {
        version: beforeRemoval.version,
        idempotency_key: `qa-approved-${suffix}`,
        pr_head_sha: 'head-a-1',
        evidence: ['qa: full regression and failure-path verification'],
      })
      expect(qaReview.status, qaReview.text).toBe(200)
      const afterQa = qaReview.body as QualityIssue
      expect(afterQa).toMatchObject({
        assignee_user_id: users.product.id,
        workflow: { current_stage_id: 'quality' },
        quality_handoff: { required_assignee_role: 'product' },
      })

      const qaReplay = await submitQualityReview(request, qaToken, issueA.id, {
        version: beforeRemoval.version,
        idempotency_key: `qa-approved-${suffix}`,
        pr_head_sha: 'head-a-1',
        evidence: ['qa: full regression and failure-path verification'],
      })
      expect(qaReplay.status, qaReplay.text).toBe(200)
      expect(qaReplay.body).toMatchObject({ version: afterQa.version })

      const productToken = await loginQualityUser(request, users.product)
      const productReview = await submitQualityReview(request, productToken, issueA.id, {
        version: afterQa.version,
        idempotency_key: `product-approved-${suffix}`,
        pr_head_sha: 'head-a-1',
        evidence: ['product: acceptance criteria observed'],
      })
      expect(productReview.status, productReview.text).toBe(200)
      const afterProduct = productReview.body as QualityIssue
      expect(afterProduct).toMatchObject({
        assignee_user_id: users.ui.id,
        workflow: { current_stage_id: 'quality' },
        quality_handoff: { required_assignee_role: 'ui' },
      })

      const uiToken = await loginQualityUser(request, users.ui)
      const uiReview = await submitQualityReview(request, uiToken, issueA.id, {
        version: afterProduct.version,
        idempotency_key: `ui-approved-${suffix}`,
        pr_head_sha: 'head-a-1',
        evidence: ['ui: desktop and compact layouts inspected'],
      })
      expect(uiReview.status, uiReview.text).toBe(200)
      const afterUi = uiReview.body as QualityIssue
      expect(afterUi).toMatchObject({
        assignee_user_id: users.ui.id,
        workflow: { current_stage_id: 'quality' },
        quality_handoff: {
          acceptance_complete: true,
          required_assignee_role: 'ui',
          quality_blocked: false,
        },
      })
      expect(Object.keys(afterUi.quality_handoff?.reviews || {})).toHaveLength(3)

      provider.setPullState(2, { headSha: 'head-b-2', checkConclusion: 'failure' })
      provider.setPullState(3, { headSha: 'head-c-2', mergeableState: 'dirty' })
      const failedHeadRequestCount = provider.requests.length
      await triggerProjectEventPolling(hook.id)
      expect(provider.requests.length).toBeGreaterThan(failedHeadRequestCount)

      await expect
        .poll(
          async () => {
            const [failed, conflicted] = await Promise.all([
              readIssue(issueB.id),
              readIssue(issueC.id),
            ])
            return [
              {
                status: failed.status,
                stage: failed.workflow.current_stage_id,
                assignee: failed.assignee_user_id,
                blocked: failed.quality_handoff?.quality_blocked,
                reason: failed.quality_handoff?.reason_code,
              },
              {
                status: conflicted.status,
                stage: conflicted.workflow.current_stage_id,
                assignee: conflicted.assignee_user_id,
                blocked: conflicted.quality_handoff?.quality_blocked,
                reason: conflicted.quality_handoff?.reason_code,
              },
            ]
          },
          {
            message: 'A failed check and a merge conflict should both leave QA for engineering',
            timeout: 30_000,
            intervals: [500],
          }
        )
        .toEqual([
          {
            status: 'in_review',
            stage: 'quality',
            assignee: engineer.id,
            blocked: true,
            reason: 'pr_checks_failed',
          },
          {
            status: 'in_review',
            stage: 'quality',
            assignee: engineer.id,
            blocked: true,
            reason: 'pr_merge_conflict',
          },
        ])

      const eventsPath = `/api/v1/cloud-projects/${fixture.projectId}/incoming-hooks/${hook.id}/events?limit=200`
      await expect
        .poll(
          async () => {
            const events = await webApi<QualityIncomingEvent[]>(page, eventsPath)
            return events.filter(event => event.status !== 'processed')
          },
          {
            message: 'Every collected and replayed provider event should reach a terminal state',
            timeout: 20_000,
          }
        )
        .toEqual([])
      const collectedEvents = await webApi<QualityIncomingEvent[]>(page, eventsPath)
      const eventTypes = collectedEvents.flatMap(event =>
        event.normalizedEvents.map(normalized => normalized.event_type)
      )
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          'change_request.updated',
          'change_request.checks_failed',
          'change_request.merge_conflict',
        ])
      )

      const beforeDuplicate = await Promise.all([
        readStableState(issueA.id, [ADMIN_USER, users.qa, users.product, users.ui]),
        readStableState(issueB.id, [ADMIN_USER, users.qa]),
        readStableState(issueC.id, [ADMIN_USER, users.qa]),
      ])
      expect(beforeDuplicate[0].notifications.slice(1).map(item => item.assignments)).toEqual([
        1, 1, 1,
      ])
      const eventsBeforeDuplicate = await issueEventCount(page, eventsPath)
      const replayRequestCount = provider.requests.length
      await triggerProjectEventPolling(hook.id)
      expect(provider.requests.length).toBeGreaterThan(replayRequestCount)
      expect(
        await Promise.all([
          readStableState(issueA.id, [ADMIN_USER, users.qa, users.product, users.ui]),
          readStableState(issueB.id, [ADMIN_USER, users.qa]),
          readStableState(issueC.id, [ADMIN_USER, users.qa]),
        ])
      ).toEqual(beforeDuplicate)
      expect(await issueEventCount(page, eventsPath)).toBe(eventsBeforeDuplicate)

      provider.setPullState(2, {
        headSha: 'head-b-3',
        checkConclusion: 'success',
        mergeableState: 'clean',
      })
      provider.setPullState(3, {
        headSha: 'head-c-3',
        checkConclusion: 'success',
        mergeableState: 'clean',
      })
      await triggerProjectEventPolling(hook.id)
      await expect
        .poll(
          async () => {
            const [recoveredB, recoveredC] = await Promise.all([
              readIssue(issueB.id),
              readIssue(issueC.id),
            ])
            return [recoveredB, recoveredC].map(issue => ({
              status: issue.status,
              stage: issue.workflow.current_stage_id,
              assignee: issue.assignee_user_id,
              blocked: issue.quality_handoff?.quality_blocked,
              role: issue.quality_handoff?.required_assignee_role,
              accepted: issue.quality_handoff?.acceptance_complete,
            }))
          },
          {
            message: 'A new green head should return both blocked Issues to QA',
            timeout: 30_000,
            intervals: [500],
          }
        )
        .toEqual([
          {
            status: 'in_review',
            stage: 'quality',
            assignee: users.qa.id,
            blocked: false,
            role: 'qa',
            accepted: false,
          },
          {
            status: 'in_review',
            stage: 'quality',
            assignee: users.qa.id,
            blocked: false,
            role: 'qa',
            accepted: false,
          },
        ])

      const afterRecovery = await Promise.all([
        readStableState(issueB.id, [ADMIN_USER, users.qa]),
        readStableState(issueC.id, [ADMIN_USER, users.qa]),
      ])
      expect(afterRecovery.map(item => item.notifications[1].assignments)).toEqual([2, 2])
      const recoveredEventCount = await issueEventCount(page, eventsPath)
      await triggerProjectEventPolling(hook.id)
      expect(
        await Promise.all([
          readStableState(issueB.id, [ADMIN_USER, users.qa]),
          readStableState(issueC.id, [ADMIN_USER, users.qa]),
        ])
      ).toEqual(afterRecovery)
      expect(await issueEventCount(page, eventsPath)).toBe(recoveredEventCount)
      expect(
        provider.requests.filter(item => item.path === '/api/graphql').length
      ).toBeGreaterThanOrEqual(3)
      expect(provider.requests.some(item => item.path.includes('/check-runs'))).toBe(true)
      expect(provider.requests.filter(item => item.status >= 400)).toEqual([])

      const currentA = await readIssue(issueA.id)
      const blockedByUi = await submitQualityReview(request, uiToken, issueA.id, {
        version: currentA.version,
        decision: 'changes_requested',
        idempotency_key: `ui-changes-${suffix}`,
        pr_head_sha: 'head-a-1',
        evidence: ['ui: contrast regression requires an engineering fix'],
      })
      expect(blockedByUi.status, blockedByUi.text).toBe(200)
      expect(blockedByUi.body).toMatchObject({
        assignee_user_id: engineer.id,
        workflow: { current_stage_id: 'quality' },
        quality_handoff: {
          quality_blocked: true,
          reason_code: 'quality_changes_requested',
        },
      })
    } finally {
      if (hook) {
        await deleteQualityIncomingHook(page, fixture.projectId, hook.id).catch(() => undefined)
      }
      if (connectionSeeded) {
        await removeProjectEventConnection(engineer.id, credentialRef).catch(() => undefined)
      }
      await provider.close().catch(() => undefined)
      for (const user of Object.values(users)) {
        await removeQualityProjectMember(page, fixture.projectId, user.id).catch(() => undefined)
        await webApi(page, `/api/admin/users/${user.id}`, { method: 'DELETE' }).catch(
          () => undefined
        )
      }
    }
  })

  test('silently creates and reassigns an Issue, preserving drafts after real backend rejection', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(page, suffix, `Silent save fixture ${suffix}`)
    const recipient = { username: `silent-save-${suffix}`, password: REGULAR_USER.password }
    const account = await webApi<{ id: number }>(page, '/api/admin/users', {
      method: 'POST',
      body: { user_name: recipient.username, password: recipient.password, role: 'user' },
    })
    try {
      const memberId = await addProjectMember(page, recipient.username)
      const setRecipientActive = (is_active: boolean) =>
        webApi(page, `/api/admin/users/${account.id}`, { method: 'PUT', body: { is_active } })
      const owner = await webApi<{ id: number }>(page, '/api/users/me')
      const title = `Silent save ${suffix}`
      const description = 'Preserve this draft across a rejected silent save.'
      const error = page.getByTestId('cloud-todo-save-error')
      await page.goto(fixture.projectPath)
      await page.getByTestId('collaboration-issue-create').click()
      await page.getByTestId('cloud-todo-title').fill(title)
      await page.getByTestId('cloud-todo-detail-description').fill(description)
      await page.getByTestId('cloud-todo-create-assignee').click()
      await page.getByTestId(`cloud-todo-create-assignee-option-user:${memberId}`).click()

      // Deactivation invalidates the selected assignee after the form loaded.
      await setRecipientActive(false)
      const rejectedCreate = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/cloud-projects/${fixture.projectId}/loop-items`)
      )
      await saveSilently(page, 'cloud-todo-create-confirm')
      expect((await rejectedCreate).status()).toBe(422)
      await expect(error).toContainText('Issue recipient must be an active user')
      await expect(page.getByTestId('cloud-todo-title')).toHaveValue(title)
      await expect(page.getByTestId('cloud-todo-detail-description')).toHaveValue(description)
      await expect(page.getByTestId('cloud-todo-create-assignee')).toHaveAttribute(
        'data-value',
        `user:${memberId}`
      )
      const afterFailure = await webApi<{ items: SavedIssue[] }>(
        page,
        `/api/v1/cloud-projects/${fixture.projectId}/loop-items`
      )
      expect(afterFailure.items.some(item => item.title === title)).toBe(false)
      await captureEvidence(page, testInfo, '03-silent-create-rejected-draft-preserved')
      await setRecipientActive(true)
      await saveSilently(page, 'cloud-todo-create-confirm')
      await expect(page).toHaveURL(new RegExp(`${fixture.projectPath}/issues/[^/?]+$`))
      const issueId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
      expect(issueId).not.toBe('')
      const issuePath = `/api/v1/loop-items/${issueId}`
      const created = await webApi<SavedIssue>(page, issuePath)
      expect(created).toMatchObject({
        title,
        description,
        status: 'inbox',
        assignee_user_id: Number(memberId),
      })
      await expect(error).toHaveCount(0)
      await expectNoAssignmentNotification(request, issueId, recipient)
      await captureEvidence(page, testInfo, '04-silent-create-persisted')

      // Change the owner through the UI, then exercise a real reassignment to another person.
      const ownerAssigned = page.waitForResponse(
        response =>
          response.request().method() === 'POST' && response.url().endsWith(`/${issueId}/assign`)
      )
      await selectAssigneeSilently(page, owner.id)
      expect((await ownerAssigned).ok()).toBe(true)
      await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
      expect((await webApi<SavedIssue>(page, issuePath)).assignee_user_id).toBe(owner.id)
      await setRecipientActive(false)
      const rejectedAssignment = page.waitForResponse(
        response =>
          response.request().method() === 'POST' && response.url().endsWith(`/${issueId}/assign`)
      )
      await selectAssigneeSilently(page, memberId)
      expect((await rejectedAssignment).status()).toBe(422)
      await expect(error).toContainText('Issue recipient must be an active user')
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        `user:${memberId}`
      )
      expect(await webApi<SavedIssue>(page, issuePath)).toMatchObject({
        title,
        description,
        status: created.status,
        assignee_user_id: owner.id,
      })
      await setRecipientActive(true)
      await expectNoAssignmentNotification(request, issueId, recipient)
      await captureEvidence(page, testInfo, '05-silent-reassignment-rejected')
      const retryAssigned = page.waitForResponse(
        response =>
          response.request().method() === 'POST' && response.url().endsWith(`/${issueId}/assign`)
      )
      await page.getByTestId('cloud-todo-field-retry').click()
      expect((await retryAssigned).ok()).toBe(true)
      await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
      await page.reload()
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        `user:${memberId}`
      )
      expect(await webApi<SavedIssue>(page, issuePath)).toMatchObject({
        title,
        description,
        status: created.status,
        assignee_user_id: Number(memberId),
      })
      await expect(error).toHaveCount(0)
      await expectNoAssignmentNotification(request, issueId, recipient)
      await captureEvidence(page, testInfo, '06-silent-reassignment-persisted')
    } finally {
      await webApi(page, `/api/admin/users/${account.id}`, { method: 'DELETE' })
    }
  })
})
