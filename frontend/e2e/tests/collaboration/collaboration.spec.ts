// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type TestInfo } from '@playwright/test'

interface VersionedResource {
  version: number
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
  resourcePath: string
): Promise<{ ok: boolean; stage: 'get' | 'delete'; status: number }> {
  return page.evaluate(async path => {
    const resourceResponse = await fetch(path)
    if (!resourceResponse.ok) {
      return { ok: false, status: resourceResponse.status, stage: 'get' as const }
    }
    const resource = (await resourceResponse.json()) as VersionedResource
    const archiveResponse = await fetch(`${path}?version=${resource.version}`, {
      method: 'DELETE',
    })
    return {
      ok: archiveResponse.ok,
      status: archiveResponse.status,
      stage: 'delete' as const,
    }
  }, resourcePath)
}

test.describe('Collaboration module', () => {
  let projectId = ''
  let workspaceId = ''

  test.afterEach(async ({ page }) => {
    if (projectId) {
      const cleanup = await archiveResource(
        page,
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
  }, testInfo) => {
    const suffix = `${Date.now()}`
    const workspaceName = `Workspace E2E ${suffix}`
    const projectName = `Collaboration E2E ${suffix}`
    const issueTitle = `Shared Issue ${suffix}`
    const updatedIssueTitle = `${issueTitle} updated`
    const comment = `Persistent E2E comment ${suffix}`
    const assignmentComment = `Assignment E2E comment ${suffix}`
    const workflowStep = '交互设计'

    await page.goto('/collaboration')
    await expect(page).toHaveURL(/\/collaboration$/)
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    await expect(page.getByTestId('collaboration-nav-all-spaces')).toBeVisible()

    await page.getByTestId('collaboration-nav-resources').click()
    await expect(page).toHaveURL(/\/collaboration\/resources$/)
    await expect(page.getByTestId('collaboration-nav-resources')).toHaveClass(/active/)
    await capture(page, testInfo, '01-resources')

    await page.getByTestId('collaboration-nav-all-spaces').click()
    await expect(page).toHaveURL(/\/collaboration$/)

    await page.getByTestId('collaboration-workspace-create').click()
    await page.getByTestId('collaboration-workspace-name-input').fill(workspaceName)
    await page
      .getByTestId('collaboration-workspace-description-input')
      .fill('Created through the real Collaboration workspace flow.')
    await page.getByTestId('collaboration-workspace-create-confirm').click()

    await expect(page).toHaveURL(/\/collaboration\/workspaces\/[^/?]+$/)
    workspaceId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
    expect(workspaceId).not.toBe('')
    await expect(page.getByTestId('collaboration-workspace-back')).toBeVisible()
    await expect(page.getByText(workspaceName, { exact: true }).first()).toBeVisible()

    await page.getByTestId('collaboration-workspace-back').click()
    await expect(page).toHaveURL(/\/collaboration$/)
    await expect(page.getByTestId(`collaboration-workspace-${workspaceId}`)).toContainText(
      workspaceName
    )
    await page.getByTestId(`collaboration-workspace-${workspaceId}`).click()
    await expect(page).toHaveURL(
      new RegExp(`/collaboration/workspaces/${escaped(encodeURIComponent(workspaceId))}$`)
    )

    await page.getByTestId('collaboration-workspace-project-create').click()
    await page.getByTestId('collaboration-project-name-input').fill(projectName)
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
    await expect(page.getByTestId('collaboration-board')).toBeVisible()

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
    const issueId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
    expect(issueId).not.toBe('')

    await page.getByTestId('cloud-todo-detail-title').fill(updatedIssueTitle)
    await page.getByTestId('cloud-todo-detail-status').selectOption('pending')
    await page.getByTestId('cloud-todo-save').click()
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)

    await page.getByTestId('collaboration-issue-comment').fill(comment)
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText(comment)

    const assignmentTarget = page.getByTestId('collaboration-assignment-target')
    const assignedMemberName = await assignmentTarget
      .locator('optgroup')
      .first()
      .locator('option')
      .first()
      .textContent()
    expect(assignedMemberName?.trim()).not.toBe('')
    await assignmentTarget.selectOption({ index: 1 })
    await page.getByTestId('collaboration-assignment-workflow-step').fill(workflowStep)
    await page.getByTestId('collaboration-issue-comment').fill(assignmentComment)
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText(assignmentComment)
    await expect(page.getByTestId('collaboration-comments')).toContainText(workflowStep)
    await expect(page.getByTestId('collaboration-comments')).toContainText(
      assignedMemberName?.trim() ?? ''
    )
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
    await expect(tableRow).toContainText('pending')
    await expect(tableRow).toContainText(assignedMemberName?.trim() ?? '')

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
    await expect(page.getByTestId('collaboration-comments')).toContainText(workflowStep)
    await capture(page, testInfo, '03-persisted-issue')
  })
})
