// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { webApi } from '../../utils/collaboration-test-support'

interface Resource {
  id: string
  version: number
}

interface ScheduledProject {
  path: string
  issueId: string
  title: string
}

const projectTest = test.extend<{ scheduledProject: ScheduledProject }>({
  scheduledProject: async ({ page, request }, use) => {
    await page.goto('/collaboration')
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    const suffix = crypto.randomUUID()
    const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
      method: 'POST',
      body: { name: `Project views ${suffix}` },
    })
    let project: Resource | undefined
    try {
      project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
        method: 'POST',
        body: {
          workspace_id: workspace.id,
          name: `Schedule ${suffix}`,
          task_provider: 'local',
          visibility: 'private',
        },
      })
      const users = await webApi<{ users: Array<{ id: number; user_name: string }> }>(
        page,
        `/api/users/search?q=${encodeURIComponent(REGULAR_USER.username)}&limit=20`
      )
      const member = users.users.find(user => user.user_name === REGULAR_USER.username)
      expect(member, 'Global setup must provision the regular E2E user').toBeDefined()
      await webApi(page, `/api/v1/cloud-projects/${project.id}/members`, {
        method: 'POST',
        body: { user_id: member!.id, role: 'Developer' },
      })
      const memberApi = createApiClient(request)
      const login = await memberApi.login(REGULAR_USER.username, REGULAR_USER.password, 1)
      expect(login.status).toBe(200)
      const today = new Date()
      today.setHours(12, 0, 0, 0)
      const title = `Scheduled Issue ${suffix}`
      const created = await memberApi.post<Resource>(
        `/api/v1/cloud-projects/${project.id}/loop-items`,
        {
          title,
          description: 'Created by another member to verify an unread board card.',
          status: 'pending',
          priority: 'none',
          tags: [],
          start_at: today.toISOString(),
          due_at: today.toISOString(),
        }
      )
      expect(created.status).toBe(201)
      expect(created.data?.id).toBeTruthy()
      await use({
        path: `/collaboration/workspaces/${workspace.id}/projects/${project.id}`,
        issueId: created.data!.id,
        title,
      })
    } finally {
      if (project) {
        const current = await webApi<Resource>(page, `/api/v1/cloud-projects/${project.id}`)
        await webApi(page, `/api/v1/cloud-projects/${project.id}?version=${current.version}`, {
          method: 'DELETE',
        })
      }
      const current = await webApi<Resource>(page, `/api/v1/workspaces/${workspace.id}`)
      await webApi(page, `/api/v1/workspaces/${workspace.id}?version=${current.version}`, {
        method: 'DELETE',
      })
    }
  },
})

projectTest(
  'sorts lanes independently with compound rules and restores choices after reload',
  async ({ page, scheduledProject: { path, issueId } }) => {
    const projectId = path.split('/').at(-1)!
    const createIssue = (priority: 'high' | 'urgent', status = 'pending') =>
      webApi<Resource>(page, `/api/v1/cloud-projects/${projectId}/loop-items`, {
        method: 'POST',
        body: { title: `Sort ${priority}`, status, priority },
      })
    const high = await createIssue('high')
    const urgent = await createIssue('urgent')
    const completedHigh = await createIssue('high', 'completed')
    const completedUrgent = await createIssue('urgent', 'completed')
    await webApi(page, `/api/v1/cloud-projects/${projectId}/loop-items/reorder`, {
      method: 'POST',
      body: { parent_id: null, status: 'pending', item_ids: [issueId, high.id, urgent.id] },
    })

    await page.goto(path)
    const sort = page.getByTestId('cloud-board-sort-by-pending')
    const completedSort = page.getByTestId('cloud-board-sort-by-completed')
    const assertOrder = async (lane: string, ids: string[]) => {
      const cards = page
        .getByTestId(`cloud-todo-column-${lane}`)
        .locator('article[data-testid^="collaboration-issue-"]')
      await expect(cards).toHaveCount(ids.length)
      for (const [index, id] of ids.entries()) {
        await expect(cards.nth(index)).toHaveAttribute('data-testid', `collaboration-issue-${id}`)
      }
    }

    await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc')
    await assertOrder('pending', [urgent.id, high.id, issueId])
    await assertOrder('completed', [completedUrgent.id, completedHigh.id])
    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-manual').click()
    await sort.click()
    await completedSort.click()
    await page.getByTestId('cloud-board-sort-by-completed-rule-0-mode').click()
    await page.getByTestId('cloud-board-sort-by-completed-rule-0-mode-created-asc').click()
    await completedSort.click()
    await assertOrder('pending', [issueId, high.id, urgent.id])
    await assertOrder('completed', [completedHigh.id, completedUrgent.id])
    await page.reload()
    await expect(sort).toHaveAttribute('data-sort-rules', 'manual')
    await expect(completedSort).toHaveAttribute('data-sort-rules', 'created-asc')
    await assertOrder('pending', [issueId, high.id, urgent.id])
    await assertOrder('completed', [completedHigh.id, completedUrgent.id])
    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-add').click()
    await page.getByTestId('cloud-board-sort-by-pending-add').click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-mode').click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-mode-created-asc').click()
    await sort.click()
    await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc,created-asc')
    await assertOrder('pending', [urgent.id, high.id, issueId])
    await page.reload()
    await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc,created-asc')
    await assertOrder('pending', [urgent.id, high.id, issueId])
    await expect(completedSort).toHaveAttribute('data-sort-rules', 'created-asc')
  }
)

for (const view of ['calendar', 'gantt'] as const) {
  projectTest(
    `preserves ${view} through navigation, reload and Issue detail`,
    async ({ page, scheduledProject: { path, issueId, title } }) => {
      await page.goto(path)
      const card = page.getByTestId(`collaboration-issue-${issueId}`)
      await expect(card).toContainText(title)
      const snapshot = await webApi<{ items: Array<{ id: string; is_unread: boolean }> }>(
        page,
        `/api/v1/cloud-projects/${path.split('/').at(-1)}/board-snapshot`
      )
      expect(snapshot.items.find(item => item.id === issueId)?.is_unread).toBe(true)
      await expect(page.getByTestId(`cloud-todo-card-unread-${issueId}`)).toHaveCount(0)
      await expect(card).not.toHaveClass(/bg-focus\/10/)

      const handle = page.getByTestId(`cloud-todo-card-${issueId}`)
      await handle.scrollIntoViewIfNeeded()
      const box = await handle.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + 20, box!.y + 20)
      await page.mouse.down()
      try {
        await page.mouse.move(box!.x + 30, box!.y + 20)
        await expect(page.getByTestId('project-board-drag-overlay')).toBeVisible()
        await expect(page.getByTestId(`cloud-todo-card-unread-${issueId}`)).toHaveCount(0)
        // Release outside the original card so cancelling cannot produce a card click.
        await page.mouse.move(box!.x + 30, box!.y - 10)
        await page.keyboard.press('Escape')
      } finally {
        await page.mouse.up()
      }
      await expect(page.getByTestId('project-board-drag-overlay')).toHaveCount(0)
      await expect(page.getByTestId('collaboration-issue-detail')).toHaveCount(0)
      await expect(page).toHaveURL(path)

      await page.getByTestId(`collaboration-${view}-tab`).click()
      await expect(page).toHaveURL(`${path}?view=${view}`)
      await expect(page.getByTestId(`collaboration-${view}`)).toBeVisible()
      await page.reload()
      await expect(page).toHaveURL(`${path}?view=${view}`)
      await expect(page.getByTestId(`collaboration-${view}`)).toBeVisible()

      await page.getByTestId(`collaboration-${view}-issue-${issueId}`).first().click()
      await expect(page).toHaveURL(`${path}/issues/${issueId}?view=${view}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.reload()
      await expect(page).toHaveURL(`${path}/issues/${issueId}?view=${view}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.getByTestId('cloud-todo-detail-close').click()
      await expect(page).toHaveURL(`${path}?view=${view}`)
      await expect(page.getByTestId(`collaboration-${view}`)).toBeVisible()
    }
  )
}

test('removes My Work and Run Center from navigation and their former URLs', async ({ page }) => {
  await page.goto('/collaboration')
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  await expect(page.getByTestId('collaboration-nav-inbox')).toBeVisible()
  await expect(page.getByTestId('collaboration-nav-my-work')).toHaveCount(0)
  await expect(page.getByTestId('collaboration-nav-runs')).toHaveCount(0)
  for (const removed of ['my-work', 'runs']) {
    await page.goto(`/collaboration/${removed}`)
    await expect(page).toHaveURL(/\/collaboration$/)
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  }
})
