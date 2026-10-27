// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { projectTest, type Resource } from '../../utils/collaboration-project-fixture'
import { webApi } from '../../utils/collaboration-test-support'

projectTest(
  'bulk status changes identify rejected Issues and retain them for retry',
  async ({ page, scheduledProject: { path, issueId } }) => {
    const projectId = path.split('/').at(-1)!
    const agent = await webApi<Resource>(page, `/api/v1/cloud-projects/${projectId}/chat-agents`, {
      method: 'POST',
      body: {
        name: 'Bulk runner validation',
        runtime: 'codex',
        execution_policy: { mode: 'project_pool' },
        model_policy: { mode: 'user_select' },
        workspace_binding: { type: 'standalone' },
      },
    })
    const assigned = await webApi<Resource>(
      page,
      `/api/v1/cloud-projects/${projectId}/loop-items`,
      {
        method: 'POST',
        body: { title: 'Rejected bulk Issue', status: 'completed', assignee_agent_id: agent.id },
      }
    )
    const rejected = await webApi<Resource>(page, `/api/v1/loop-items/${assigned.id}`, {
      method: 'PATCH',
      body: { version: assigned.version, status: 'inbox' },
    })
    await page.goto(`${path}?view=table`)
    await page.getByTestId(`collaboration-issue-table-select-${issueId}`).check()
    await page.getByTestId(`collaboration-issue-table-select-${rejected.id}`).check()
    await page.getByTestId('collaboration-issue-table-batch-status').selectOption('in_progress')
    await page.getByTestId('collaboration-issue-table-batch-apply').click()
    const error = page.getByTestId('collaboration-issue-table-batch-error')
    await expect(error).toContainText('Rejected bulk Issue')
    await expect(error).toContainText(
      /机器人没有符合配置且获项目授权的执行环境|No project-authorized execution environment/
    )
    await expect(page.getByTestId(`collaboration-issue-table-select-${issueId}`)).not.toBeChecked()
    await expect(page.getByTestId(`collaboration-issue-table-select-${rejected.id}`)).toBeChecked()
    const persisted = await webApi<Resource & { status: string }>(
      page,
      `/api/v1/loop-items/${rejected.id}`
    )
    expect({ status: persisted.status, version: persisted.version }).toEqual({
      status: 'inbox',
      version: rejected.version,
    })
    expect((await webApi<{ status: string }>(page, `/api/v1/loop-items/${issueId}`)).status).toBe(
      'in_progress'
    )
    await page.getByTestId('collaboration-issue-table-batch-status').selectOption('pending')
    const rejectedRetry = page.waitForResponse(
      response =>
        response.url().endsWith(`/api/v1/loop-items/${rejected.id}`) &&
        response.request().method() === 'PATCH'
    )
    await page.getByTestId('collaboration-issue-table-batch-apply').click()
    expect((await rejectedRetry).status()).toBe(422)
    await expect(error).toContainText('Rejected bulk Issue')
    await expect(page.getByTestId(`collaboration-issue-table-select-${rejected.id}`)).toBeChecked()
    expect((await webApi<Resource>(page, `/api/v1/loop-items/${rejected.id}`)).version).toBe(
      rejected.version
    )

    await page.getByTestId('collaboration-issue-table-batch-status').selectOption('completed')
    const successfulRetry = page.waitForResponse(
      response =>
        response.url().endsWith(`/api/v1/loop-items/${rejected.id}`) &&
        response.request().method() === 'PATCH'
    )
    await page.getByTestId('collaboration-issue-table-batch-apply').click()
    expect((await successfulRetry).status()).toBe(200)
    await expect(page.getByTestId('collaboration-issue-table-batch')).toHaveCount(0)
    await expect(error).toHaveCount(0)
    expect(
      (await webApi<{ status: string }>(page, `/api/v1/loop-items/${rejected.id}`)).status
    ).toBe('completed')
  }
)

projectTest(
  'renames and deletes a tag together with Issue and saved-view references',
  async ({ page, scheduledProject: { path, issueId } }) => {
    const projectId = path.split('/').at(-1)!
    const issue = await webApi<Resource>(page, `/api/v1/loop-items/${issueId}`)
    await webApi(page, `/api/v1/loop-items/${issueId}`, {
      method: 'PATCH',
      body: { version: issue.version, tags: ['old', 'keep'] },
    })
    const project = await webApi<Resource>(page, `/api/v1/cloud-projects/${projectId}`)
    await webApi(page, `/api/v1/cloud-projects/${projectId}`, {
      method: 'PATCH',
      body: {
        version: project.version,
        tags: ['old', 'keep'],
        board_views: {
          schema_version: 1,
          future: { keepCase: true },
          views: [
            {
              id: 'tag-change',
              name: 'Tag mutation',
              columns: [
                { id: 'inbox', type: 'status', value: 'inbox' },
                { id: 'tag', type: 'tag', value: 'old' },
              ],
              filter: { tags: ['old'] },
              sorts: { tag: ['created-desc'] },
            },
          ],
        },
      },
    })
    await page.goto(`${path}?view=manage&section=project`)
    await page.getByTestId('cloud-project-manage-tags-toggle').click()
    await page.getByTestId('cloud-project-tag-old').hover()
    await page.getByTestId('cloud-project-tag-menu-old').click()
    await page.getByTestId('cloud-project-tag-rename-old').click()
    await page.getByTestId('cloud-project-tag-rename-input-old').fill('renamed')
    await page.getByTestId('cloud-project-tag-rename-input-old').press('Enter')
    await expect(page.getByTestId('cloud-project-tag-renamed')).toBeVisible()
    type SavedProject = Resource & {
      tags: string[]
      board_views: {
        future: { keepCase: boolean }
        views: Array<{
          columns: Array<{ value: string }>
          filter: { tags: string[] }
          sorts: Record<string, string[]>
        }>
      }
    }
    const renamed = await webApi<SavedProject>(page, `/api/v1/cloud-projects/${projectId}`)
    expect(renamed.tags).toEqual(['renamed', 'keep'])
    expect(renamed.board_views.views[0].columns[1].value).toBe('renamed')
    expect(renamed.board_views.views[0].filter.tags).toEqual(['renamed'])
    expect((await webApi<{ tags: string[] }>(page, `/api/v1/loop-items/${issueId}`)).tags).toEqual([
      'renamed',
      'keep',
    ])
    await page.getByTestId('cloud-project-tag-renamed').hover()
    await page.getByTestId('cloud-project-tag-menu-renamed').click()
    page.once('dialog', dialog => dialog.accept())
    await page.getByTestId('cloud-project-tag-delete-renamed').click()
    await expect(page.getByTestId('cloud-project-tag-renamed')).toHaveCount(0)
    const removed = await webApi<SavedProject>(page, `/api/v1/cloud-projects/${projectId}`)
    expect(removed.tags).toEqual(['keep'])
    expect(removed.board_views.future).toEqual({ keepCase: true })
    expect(removed.board_views.views[0].columns).toHaveLength(1)
    expect(removed.board_views.views[0].filter.tags).toEqual([])
    expect(removed.board_views.views[0].sorts).toEqual({})
    expect((await webApi<{ tags: string[] }>(page, `/api/v1/loop-items/${issueId}`)).tags).toEqual([
      'keep',
    ])
    await page.reload()
    await page.getByTestId('cloud-project-manage-tags-toggle').click()
    await expect(page.getByTestId('cloud-project-tag-keep')).toBeVisible()
    await expect(page.getByTestId('cloud-project-tag-renamed')).toHaveCount(0)
  }
)
