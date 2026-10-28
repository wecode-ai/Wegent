// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { webApi } from '../../utils/collaboration-test-support'
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

interface SavedIssue {
  id: string
  title: string
  description: string
  status: string
  assignee_user_id: number | null
}

async function saveSilently(page: Page, testId: string): Promise<void> {
  await page.getByTestId(`${testId}-options`).click()
  const action = page.getByTestId(`${testId}-without-notification`)
  await expect(action).toHaveText(/^(仅保存不通知|Save without notifying)$/)
  await action.click()
}

async function expectNoAssignmentNotification(
  request: APIRequestContext,
  issueId: string
): Promise<void> {
  const login = await createApiClient(request).login(REGULAR_USER.username, REGULAR_USER.password)
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
  test('assigns the Issue to a project member without auto-completing it', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(page, suffix, `Human dispatch ${suffix}`)
    const memberId = await addProjectMember(page, REGULAR_USER.username)
    const attachmentsUrl = `**/api/v1/loop-items/${fixture.issueId}/attachments`
    let releaseAttachments!: () => void
    let observeAttachments!: () => void
    const attachmentsGate = new Promise<void>(resolve => {
      releaseAttachments = resolve
    })
    const attachmentsStarted = new Promise<void>(resolve => {
      observeAttachments = resolve
    })
    // Delay, but do not mock, the real request so editing precedes detail hydration.
    await page.route(attachmentsUrl, async route => {
      observeAttachments()
      await attachmentsGate
      await route.continue()
    })
    try {
      await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
      await attachmentsStarted
      await captureEvidence(page, testInfo, '01-issue-before-dispatch')

      await page.getByTestId('cloud-todo-detail-assignee').click()
      await page.getByTestId(`cloud-todo-detail-assignee-option-user:${memberId}`).click()
      await expect(page.getByTestId('wework-assignment-notify-confirm')).toHaveCount(0)
      await expect(page.getByTestId('cloud-todo-save')).toHaveText(/^(保存并通知|Save and notify)$/)
      const assignmentSaved = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/${fixture.issueId}/assign`)
      )
      await page.getByTestId('cloud-todo-save').click()
      const assignment = await assignmentSaved
      expect(assignment.status()).toBe(200)
      expect((await assignment.json()).assignee_user_id).toBe(Number(memberId))
      const attachmentsLoaded = page.waitForResponse(response =>
        response.url().endsWith(`/loop-items/${fixture.issueId}/attachments`)
      )
      releaseAttachments()
      expect((await attachmentsLoaded).status()).toBe(200)
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
    } finally {
      releaseAttachments()
      await page.unroute(attachmentsUrl)
    }
  })

  test('silently creates and reassigns an Issue, preserving drafts after real backend rejection', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(page, suffix, `Silent save fixture ${suffix}`)
    const memberId = await addProjectMember(page, REGULAR_USER.username)
    const memberPath = `/api/v1/cloud-projects/${fixture.projectId}/members/${memberId}`
    const setRole = (role: 'Developer' | 'Viewer') =>
      webApi(page, memberPath, { method: 'PATCH', body: { role } })
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

    // A real membership change invalidates the selected assignee after the form loaded.
    await setRole('Viewer')
    const rejectedCreate = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/cloud-projects/${fixture.projectId}/loop-items`)
    )
    await saveSilently(page, 'cloud-todo-create-confirm')
    expect((await rejectedCreate).status()).toBe(422)
    await expect(error).toContainText('Assignee is not a member')
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
    await setRole('Developer')
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
    await expectNoAssignmentNotification(request, issueId)
    await captureEvidence(page, testInfo, '04-silent-create-persisted')

    // Change the owner through the UI, then exercise a real reassignment to another person.
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId(`cloud-todo-detail-assignee-option-user:${owner.id}`).click()
    await saveSilently(page, 'cloud-todo-save')
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
    expect((await webApi<SavedIssue>(page, issuePath)).assignee_user_id).toBe(owner.id)
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId(`cloud-todo-detail-assignee-option-user:${memberId}`).click()
    await setRole('Viewer')
    const rejectedAssignment = page.waitForResponse(
      response =>
        response.request().method() === 'POST' && response.url().endsWith(`/${issueId}/assign`)
    )
    await saveSilently(page, 'cloud-todo-save')
    expect((await rejectedAssignment).status()).toBe(422)
    await expect(error).toContainText('Assignee is not a member')
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
    await expectNoAssignmentNotification(request, issueId)
    await captureEvidence(page, testInfo, '05-silent-reassignment-rejected')
    await setRole('Developer')
    await saveSilently(page, 'cloud-todo-save')
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
    await expectNoAssignmentNotification(request, issueId)
    await captureEvidence(page, testInfo, '06-silent-reassignment-persisted')
  })
})
