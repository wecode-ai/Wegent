// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { writeSharedComposer } from '../../utils/collaboration-test-support'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'

interface VersionedResource {
  version: number
}

interface WorkspaceMemberList {
  items: Array<{ user_id: number; user_name: string }>
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
  })
}

async function archiveResource(
  page: Page,
  request: APIRequestContext,
  resourcePath: string
): Promise<{ ok: boolean; stage: 'get' | 'delete'; status: number }> {
  const authToken = (await page.context().cookies()).find(
    cookie => cookie.name === 'auth_token'
  )?.value
  if (!authToken) {
    throw new Error('Authenticated browser context is missing auth_token')
  }
  const headers = { Authorization: `Bearer ${authToken}` }
  const resourceResponse = await request.get(`${API_BASE_URL}${resourcePath}`, { headers })
  if (!resourceResponse.ok()) {
    return { ok: false, status: resourceResponse.status(), stage: 'get' }
  }
  const resource = (await resourceResponse.json()) as VersionedResource
  const archiveResponse = await request.delete(
    `${API_BASE_URL}${resourcePath}?version=${resource.version}`,
    { headers }
  )
  return {
    ok: archiveResponse.ok(),
    status: archiveResponse.status(),
    stage: 'delete',
  }
}

test.describe('Collaboration module', () => {
  let projectId = ''
  let workspaceId = ''

  test.afterEach(async ({ page, request }) => {
    if (projectId) {
      const cleanup = await archiveResource(
        page,
        request,
        `/api/v1/cloud-projects/${encodeURIComponent(projectId)}`
      )
      expect(cleanup, `Failed to archive E2E project during ${cleanup.stage}`).toEqual({
        ok: true,
        status: 204,
        stage: 'delete',
      })
      projectId = ''
    }

    if (workspaceId) {
      const cleanup = await archiveResource(
        page,
        request,
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
      )
      expect(cleanup, `Failed to archive E2E workspace during ${cleanup.stage}`).toEqual({
        ok: true,
        status: 204,
        stage: 'delete',
      })
      workspaceId = ''
    }
  })

  test('persists the Workspace → Project → Issue collaboration flow', async ({
    page,
    request,
  }, testInfo) => {
    const suffix = `${Date.now()}`
    const workspaceName = `Workspace E2E ${suffix}`
    const projectName = `Collaboration E2E ${suffix}`
    const issueTitle = `Shared Issue ${suffix}`
    const updatedIssueTitle = `${issueTitle} updated`
    const comment = `Persistent E2E comment ${suffix}`
    const assignmentComment = `Assignment E2E comment ${suffix}`

    await page.goto('/collaboration')
    await expect(page).toHaveURL(/\/collaboration$/)
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    await expect(page.getByTestId('collaboration-workspaces-section-toggle')).toBeVisible()
    await expect(page.getByTestId('collaboration-workspace-sidebar-create')).toBeVisible()

    await page.getByTestId('collaboration-workspace-create').click()
    await page.getByTestId('collaboration-workspace-name-input').fill(workspaceName)
    await page
      .getByTestId('collaboration-workspace-description-input')
      .fill('Created through the real Collaboration workspace flow.')
    await page.getByTestId('collaboration-workspace-create-confirm').click()

    await expect(page).toHaveURL(/\/collaboration\/workspaces\/[^/?]+$/)
    workspaceId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
    expect(workspaceId).not.toBe('')
    await expect(page.getByTestId('collaboration-workspace-nav-projects')).toContainText(
      workspaceName
    )
    await expect(page.getByTestId(`collaboration-workspace-tree-${workspaceId}`)).toBeVisible()

    await page
      .getByTestId(`collaboration-workspace-tree-${workspaceId}`)
      .locator('.collaboration-workspace-row')
      .hover()
    await page.getByTestId('collaboration-workspace-actions').click()
    await page.getByTestId('collaboration-workspace-nav-settings').click()
    await expect(page).toHaveURL(
      new RegExp(`/collaboration/workspaces/${escaped(encodeURIComponent(workspaceId))}/settings$`)
    )
    await expect(page.getByTestId('workspace-settings-shell')).toBeVisible()
    await expect(page.getByTestId('collaboration-workspace-settings-save')).toBeVisible()
    await page.getByTestId('collaboration-workspace-nav-participants').click()
    await page.getByTestId('collaboration-workspace-participants-tab-members').click()
    await expect(page).toHaveURL(
      new RegExp(
        `/collaboration/workspaces/${escaped(encodeURIComponent(workspaceId))}/participants$`
      )
    )
    await capture(page, testInfo, '01-workspace-resources')

    await page.getByTestId('collaboration-workspace-nav-projects').click()
    await expect(page).toHaveURL(
      new RegExp(`/collaboration/workspaces/${escaped(encodeURIComponent(workspaceId))}$`)
    )

    await page.getByTestId('collaboration-workspace-project-create').click()
    await page.getByTestId('collaboration-workspace-project-create-blank').click()
    await page.getByTestId('collaboration-project-name-input').fill(projectName)
    await page.getByTestId('collaboration-project-create-advanced').click()
    await page
      .getByTestId('collaboration-project-description-input')
      .fill('Web and Wework share this collaboration core.')
    await page.getByTestId('collaboration-project-create-confirm').click()

    await expect(page).toHaveURL(
      new RegExp(
        `/collaboration/workspaces/${escaped(encodeURIComponent(workspaceId))}/projects/[^/?]+$`
      )
    )
    projectId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
    expect(projectId).not.toBe('')
    await expect(page.getByTestId('collaboration-empty-project')).toBeVisible()

    await page.getByTestId('collaboration-issue-create').click()
    await page.getByTestId('cloud-todo-title').fill(issueTitle)
    await page
      .getByTestId('cloud-todo-detail-description')
      .fill('Initial collaboration description.')
    await page.getByTestId('cloud-todo-create-confirm').click()

    await expect(page).toHaveURL(
      new RegExp(
        `/collaboration/workspaces/${escaped(
          encodeURIComponent(workspaceId)
        )}/projects/${escaped(encodeURIComponent(projectId))}/issues/[^/?]+$`
      )
    )
    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    await expect(page.getByTestId('issue-conversation-drawers')).toHaveAttribute(
      'data-has-conversation',
      'false'
    )
    await expect(page.locator('.issue-drawer-detail')).toHaveCSS('border-right-width', '1px')
    await expect(page.getByTestId('cloud-todo-detail-scroll')).toHaveCSS('scrollbar-width', 'none')
    await expect(page.getByTestId('collaboration-issue-comment-form')).toHaveClass(
      'task-detail-new-comment'
    )
    const issueId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
    expect(issueId).not.toBe('')

    await page.getByTestId('cloud-todo-edit-content').click()
    await page.getByTestId('cloud-todo-detail-title').fill(updatedIssueTitle)
    await page.getByTestId('cloud-todo-detail-status').selectOption('pending')
    await page.getByTestId('cloud-todo-save').click()
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)

    await writeSharedComposer(page.getByTestId('collaboration-issue-comment'), comment)
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText(comment)
    await expect(page.getByTestId('collaboration-current-assignment')).toHaveCount(0)
    const commentCard = page.locator('.task-detail-comment-card').filter({ hasText: comment })
    await expect(commentCard).toHaveCSS('border-top-width', '1px')
    await expect(commentCard.locator('.task-detail-comment-inline-composer')).toBeVisible()
    const reply = `Thread reply ${Date.now()}`
    await writeSharedComposer(
      commentCard.locator('[data-testid^="collaboration-chat-reply-input-"]'),
      reply
    )
    await commentCard.locator('.task-detail-comment-send').click()
    await expect(commentCard.locator('.task-detail-comment-replies')).toContainText(reply)

    const authToken = (await page.context().cookies()).find(
      cookie => cookie.name === 'auth_token'
    )?.value
    expect(authToken).toBeTruthy()
    const memberResponse = await request.get(
      `${API_BASE_URL}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    )
    expect(memberResponse.ok()).toBe(true)
    const memberList = (await memberResponse.json()) as WorkspaceMemberList
    const assignedMember = memberList.items[0]
    const assignedMemberName = assignedMember?.user_name
    if (!assignedMember || !assignedMemberName) throw new Error('Workspace owner member is missing')
    await writeSharedComposer(page.getByTestId('collaboration-issue-comment'), '@')
    await page.getByTestId(`collaboration-issue-mention-member-${assignedMember.user_id}`).click()
    const assignmentComposer = page.getByTestId('collaboration-issue-comment')
    await expect(
      assignmentComposer.locator('[data-composer-reference-kind="member"]')
    ).toHaveAttribute('data-composer-skill-label', assignedMemberName)
    await expect(assignmentComposer).toBeFocused()
    await assignmentComposer.pressSequentially(assignmentComment)
    await expect(assignmentComposer).toContainText(assignmentComment)
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText(assignmentComment)
    await expect(page.getByTestId('collaboration-comments')).toContainText(assignedMemberName)
    await capture(page, testInfo, '02-issue-activity')

    await page.getByTestId('cloud-todo-detail-close').click()
    const projectPath = `/collaboration/workspaces/${encodeURIComponent(
      workspaceId
    )}/projects/${encodeURIComponent(projectId)}`
    await expect(page).toHaveURL(new RegExp(`${escaped(projectPath)}$`))

    await page.getByTestId('collaboration-tab-table').click()
    await expect(page).toHaveURL(new RegExp(`${escaped(projectPath)}\\?view=table$`))
    const tableRow = page.getByTestId(`collaboration-issue-table-row-${issueId}`)
    await expect(tableRow).toContainText(updatedIssueTitle)
    await expect(tableRow).toContainText(/待处理|To do/)
    await expect(tableRow).toContainText(assignedMemberName)

    await page.reload()
    await expect(page).toHaveURL(new RegExp(`${escaped(projectPath)}\\?view=table$`))
    await expect(page.getByTestId(`collaboration-issue-table-row-${issueId}`)).toContainText(
      updatedIssueTitle
    )

    await page.getByTestId('collaboration-tab-board').click()
    await expect(page).toHaveURL(new RegExp(`${escaped(projectPath)}$`))
    await expect(page.getByTestId('cloud-todo-column-pending')).toContainText(updatedIssueTitle)

    await page.reload()
    await expect(page.getByTestId('cloud-todo-column-pending')).toContainText(updatedIssueTitle)
    await page.getByTestId(`collaboration-issue-${issueId}`).getByRole('button').first().click()
    await expect(page.getByTestId('collaboration-comments')).toContainText(comment)
    await expect(page.getByTestId('collaboration-comments')).toContainText(assignmentComment)
    await expect(page.getByTestId('collaboration-comments')).toContainText(reply)
    await capture(page, testInfo, '03-persisted-issue')
  })
})
