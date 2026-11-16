// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test'
import { REGULAR_USER } from '../config/test-users'
import { createApiClient } from './api-client'
import { buildStorageState, getJwtExpiryMs } from './auth-state'
import { webApi } from './collaboration-test-support'

export interface Resource {
  id: string
  version: number
}

export interface Project extends Resource {
  board_config: { group_by: string }
}

export interface Issue extends Resource {
  assignee_user_id: number | null
  priority: string
  sort_order: number
  status: string
  tags: string[]
}

export function projectPath(workspaceId: string, projectId: string): string {
  return `/collaboration/workspaces/${workspaceId}/projects/${projectId}`
}

export function projectApi(projectId: string): string {
  return `/api/v1/cloud-projects/${projectId}`
}

export async function createIssue(
  page: Page,
  projectId: string,
  title: string,
  overrides: Record<string, unknown> = {}
): Promise<Issue> {
  return webApi(page, `${projectApi(projectId)}/loop-items`, {
    method: 'POST',
    body: { title, status: 'pending', priority: 'none', tags: [], ...overrides },
  })
}

export async function archive(page: Page, path: string): Promise<void> {
  const current = await webApi<Resource>(page, path)
  await webApi(page, `${path}?version=${current.version}`, { method: 'DELETE' })
}

interface BoardFixture {
  page: Page
  context: BrowserContext
  path: string
  separatePath: string
  project: Project
  all: Issue[]
  mineAlpha: Issue
  mineBeta: Issue
  other: Issue
  unassigned: Issue
  owner: { id: number }
  member: { id: number }
  suffix: string
}

export const boardTest = test.extend<{
  boardRole: 'Developer' | 'Viewer'
  board: BoardFixture
}>({
  boardRole: ['Developer', { option: true }],
  board: async ({ page: ownerPage, browser, request, boardRole: role }, use) => {
    await ownerPage.goto('/collaboration')
    await expect(ownerPage.getByTestId('collaboration-platform-root')).toBeVisible()
    const suffix = crypto.randomUUID()
    const workspace = await webApi<Resource>(ownerPage, '/api/v1/workspaces', {
      method: 'POST',
      body: { name: `Personal board ${role} ${suffix}` },
    })
    const projects: Project[] = []
    const login = await createApiClient(request).login(
      REGULAR_USER.username,
      REGULAR_USER.password,
      1
    )
    expect(login.status).toBe(200)
    const token = login.data?.access_token
    if (!token) throw new Error('Regular user login did not return an access token')
    const context = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
      storageState: buildStorageState(
        process.env.E2E_BASE_URL || 'http://localhost:3000',
        token,
        getJwtExpiryMs(token)
      ),
    })
    const updates: string[] = []
    const recordUpdate = (request: Request) => {
      if (
        request.method() === 'PATCH' &&
        projects.some(project => new URL(request.url()).pathname === projectApi(project.id))
      ) {
        updates.push(request.url())
      }
    }
    context.on('request', recordUpdate)

    try {
      const users = await webApi<{ users: Array<{ id: number; user_name: string }> }>(
        ownerPage,
        `/api/users/search?q=${encodeURIComponent(REGULAR_USER.username)}&limit=20`
      )
      const member = users.users.find(user => user.user_name === REGULAR_USER.username)
      expect(member, 'Global setup must provision the regular user').toBeDefined()
      const owner = await webApi<{ id: number }>(ownerPage, '/api/users/me')
      expect(member!.id).not.toBe(owner.id)
      for (const name of ['Primary', 'Separate']) {
        const created = await webApi<Project>(ownerPage, '/api/v1/cloud-projects', {
          method: 'POST',
          body: {
            workspace_id: workspace.id,
            name: `${name} ${suffix}`,
            task_provider: 'local',
            visibility: 'private',
          },
        })
        projects.push(created)
        await webApi(ownerPage, `${projectApi(created.id)}/members`, {
          method: 'POST',
          body: { user_id: member!.id, role: 'Developer' },
        })
      }
      const [project, separate] = projects
      const mineAlpha = await createIssue(ownerPage, project.id, `Mine alpha ${suffix}`, {
        assignee_user_id: member!.id,
        tags: ['alpha', 'keep'],
      })
      const mineBeta = await createIssue(ownerPage, project.id, `Mine beta ${suffix}`, {
        assignee_user_id: member!.id,
      })
      const other = await createIssue(ownerPage, project.id, `Other alpha ${suffix}`, {
        assignee_user_id: owner.id,
        tags: ['beta'],
      })
      const unassigned = await createIssue(ownerPage, project.id, `Unassigned alpha ${suffix}`)
      const cleared = await webApi<Issue>(ownerPage, `/api/v1/loop-items/${unassigned.id}`, {
        method: 'PATCH',
        body: { version: unassigned.version, assignee_user_id: null },
      })
      expect(cleared.assignee_user_id).toBeNull()
      await createIssue(ownerPage, separate.id, `Separate project Issue ${suffix}`)
      if (role === 'Viewer') {
        // Viewers cannot receive new assignments; retain real assignments after a role change.
        for (const project of projects) {
          await webApi(ownerPage, `${projectApi(project.id)}/members/${member!.id}`, {
            method: 'PATCH',
            body: { role: 'Viewer' },
          })
        }
        expect(
          (await webApi<Issue>(ownerPage, `/api/v1/loop-items/${mineAlpha.id}`)).assignee_user_id
        ).toBe(member!.id)
      }
      const snapshots = await Promise.all(
        projects.map(project => webApi<Project>(ownerPage, projectApi(project.id)))
      )
      const all = [mineAlpha, mineBeta, other, unassigned]
      const page = await context.newPage()
      const path = projectPath(workspace.id, project.id)
      const separatePath = projectPath(workspace.id, separate.id)
      await page.goto(path)
      const signedIn = await webApi<{ id: number; role: string }>(page, '/api/users/me')
      expect(signedIn.id).toBe(member!.id)
      expect(signedIn.role, 'Permission coverage must use an ordinary global user').toBe('user')
      expect(
        await webApi<Array<{ user_id: number; role: string }>>(
          ownerPage,
          `${projectApi(project.id)}/members`
        )
      ).toContainEqual(expect.objectContaining({ user_id: member!.id, role }))
      await use({
        page,
        context,
        path,
        separatePath,
        project,
        all,
        mineAlpha,
        mineBeta,
        other,
        unassigned,
        owner,
        member: member!,
        suffix,
      })
      for (const before of snapshots) {
        const after = await webApi<Project>(ownerPage, projectApi(before.id))
        expect(after.board_config).toEqual(before.board_config)
        expect(after.version).toBe(before.version)
      }
      expect(updates, 'Personal view changes must never PATCH a shared project').toEqual([])
    } finally {
      await context.close()
      for (const project of [...projects].reverse())
        await archive(ownerPage, projectApi(project.id))
      await archive(ownerPage, `/api/v1/workspaces/${workspace.id}`)
    }
  },
})
