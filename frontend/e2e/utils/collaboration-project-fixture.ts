// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { REGULAR_USER } from '../config/test-users'
import { createApiClient } from './api-client'
import { webApi } from './collaboration-test-support'

export interface Resource {
  id: string
  version: number
}

interface ScheduledProject {
  path: string
  issueId: string
  title: string
}

export const projectTest = test.extend<{ scheduledProject: ScheduledProject }>({
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

projectTest.setTimeout(120_000)
