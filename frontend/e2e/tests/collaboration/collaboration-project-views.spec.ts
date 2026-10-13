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
        await page.keyboard.press('Escape')
      } finally {
        await page.mouse.up()
      }
      await expect(page.getByTestId('project-board-drag-overlay')).toHaveCount(0)

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
