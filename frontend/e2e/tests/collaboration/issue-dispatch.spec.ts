// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { addProjectMember, createProjectFixture } from '../../utils/issue-dispatch-test-support'

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
    .toBe('create_personal_task')
  return notification!
}

test.describe('Issue Dispatch human assignment', () => {
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
    await page.getByTestId('cloud-todo-save').click()
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${memberId}`
    )
    await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('inbox')

    const notification = await waitForAssignmentNotification(request, fixture.issueId)
    expect(notification.payload).toMatchObject({
      action: 'create_personal_task',
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
})
