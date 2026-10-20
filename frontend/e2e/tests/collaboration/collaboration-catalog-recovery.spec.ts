// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test as base, type Route } from '@playwright/test'
import { selectCollaborationProjectView, webApi } from '../../utils/collaboration-test-support'

interface Resource {
  id: string
  version: number
}

interface ProjectFixture {
  project: Resource
  path: string
}

const test = base.extend<{ projectFixture: ProjectFixture }>({
  projectFixture: async ({ page }, use) => {
    await page.goto('/collaboration')
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
      method: 'POST',
      body: { name: `Catalog recovery ${crypto.randomUUID()}` },
    })
    let project: Resource | undefined
    try {
      project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
        method: 'POST',
        body: {
          name: `Catalog recovery ${crypto.randomUUID()}`,
          workspace_id: workspace.id,
          task_provider: 'local',
          visibility: 'private',
        },
      })
      await use({
        project,
        path: `/collaboration/workspaces/${workspace.id}/projects/${project.id}`,
      })
    } finally {
      for (const resourcePath of [
        ...(project ? [`/api/v1/cloud-projects/${project.id}`] : []),
        `/api/v1/workspaces/${workspace.id}`,
      ]) {
        const current = await webApi<Resource>(page, resourcePath)
        await webApi(page, `${resourcePath}?version=${current.version}`, { method: 'DELETE' })
      }
    }
  },
})

// Cut the response only after the actual Backend has served it. No non-model
// component or response data is replaced by a frontend mock.
async function loseRealResponse(route: Route) {
  const response = await route.fetch()
  expect(response.ok(), 'The real API must succeed before its response is lost').toBe(true)
  await route.abort('failed')
}

test('settings skip the board snapshot, retry the real candidate catalog, and restore the board', async ({
  page,
  projectFixture: { project, path },
}) => {
  const issue = await webApi<Resource>(page, `/api/v1/cloud-projects/${project.id}/loop-items`, {
    method: 'POST',
    body: {
      title: 'Visible after settings',
      status: 'pending',
      priority: 'none',
      tags: ['task-only-tag'],
    },
  })
  const snapshots: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith(`/cloud-projects/${project.id}/board-snapshot`))
      snapshots.push(request.url())
  })
  const resourceUrl = (url: URL) => url.pathname === '/api/v1/resources'
  await page.route(resourceUrl, loseRealResponse)
  try {
    await page.goto(`${path}?view=manage`)
    await expect(page.getByTestId('project-settings-shell')).toBeVisible()
    await page.getByTestId('collaboration-project-settings-agents').click()
    await expect(page.getByTestId('project-agent-add')).toBeEnabled()
    expect(snapshots).toHaveLength(0)
    await page.getByTestId('project-agent-add').click()
    await expect(page.getByTestId('project-agent-candidates-error')).toBeVisible()
    await expect(page.getByTestId('project-agent-candidates-loading')).toHaveCount(0)
    await page.unroute(resourceUrl, loseRealResponse)
    const recovered = page.waitForResponse(
      response => resourceUrl(new URL(response.url())) && response.request().method() === 'GET'
    )
    await page.getByTestId('project-agent-candidates-retry').click()
    expect((await recovered).ok()).toBe(true)
    await expect(page.getByTestId('project-agent-candidates-error')).toHaveCount(0)
    await expect(page.getByTestId('project-agent-candidates-loading')).toHaveCount(0)
    await expect(page.getByTestId('project-agent-wegent-team')).toBeVisible()
    await page.getByTestId('project-agent-dialog-close').click()
    expect(snapshots).toHaveLength(0)
    const boardLoaded = page.waitForResponse(
      response =>
        new URL(response.url()).pathname.endsWith(`/cloud-projects/${project.id}/board-snapshot`) &&
        response.ok()
    )
    await selectCollaborationProjectView(page, 'board')
    await boardLoaded
    await expect(page.getByTestId(`collaboration-issue-${issue.id}`)).toContainText(
      'Visible after settings'
    )
    expect(snapshots.length).toBeGreaterThan(0)
    await selectCollaborationProjectView(page, 'manage')
    await page.getByTestId('collaboration-project-settings-project').click()
    const tagCatalogLoaded = page.waitForResponse(
      response =>
        new URL(response.url()).pathname.endsWith(`/cloud-projects/${project.id}/board-snapshot`) &&
        response.ok()
    )
    await page.getByTestId('cloud-project-manage-tags-toggle').click()
    await tagCatalogLoaded
    await expect(page.getByTestId('cloud-project-tag-task-only-tag')).toBeVisible()
  } finally {
    await page.unroute(resourceUrl, loseRealResponse)
  }
})

test('member transport failure preserves groups, allows persisted edits, and recovers on retry', async ({
  page,
  projectFixture: { project, path },
}) => {
  const groupsPath = `/api/v1/cloud-projects/${project.id}/collaboration-groups`
  const members = await webApi<Array<{ user_id: number; user_name: string }>>(
    page,
    `/api/v1/cloud-projects/${project.id}/members`
  )
  expect(members.length).toBeGreaterThan(0)
  const leader = {
    kind: 'human',
    id: String(members[0].user_id),
    name: members[0].user_name,
    responsibility: '',
  }
  const group = await webApi<Resource>(page, groupsPath, {
    method: 'POST',
    body: { name: 'Group before failure', leader, members: [leader], coordination_mode: 'manager' },
  })
  const memberUrl = (url: URL) => url.pathname === `/api/v1/cloud-projects/${project.id}/members`
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route(memberUrl, loseRealResponse)
  try {
    await page.goto(`${path}?view=manage`)
    await page.getByTestId('collaboration-project-settings-groups').click()
    await expect(page.getByTestId('project-group-members-error')).toBeVisible()
    await expect(page.getByTestId(`collaboration-group-${group.id}`)).toContainText(
      'Group before failure'
    )
    await page.getByTestId(`collaboration-group-manage-${group.id}`).click()
    await page
      .getByTestId('collaboration-group-detail-name')
      .fill('Group saved during member failure')
    const saved = page.waitForResponse(
      response =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname.endsWith(`/collaboration-groups/${group.id}`)
    )
    await page.getByTestId('collaboration-group-detail-save').click()
    expect((await saved).ok()).toBe(true)
    await expect(page.getByTestId('collaboration-group-detail-save')).toBeEnabled()
    await expect
      .poll(async () => {
        const result = await webApi<{ items: Array<Resource & { name: string }> }>(page, groupsPath)
        return result.items.find(item => item.id === group.id)?.name
      })
      .toBe('Group saved during member failure')
    await expect(page.getByTestId('project-group-members-error')).toBeVisible()
    await expect(page.getByText(/操作失败|Operation failed/)).toHaveCount(0)
    await page.unroute(memberUrl, loseRealResponse)
    const recovered = page.waitForResponse(
      response => memberUrl(new URL(response.url())) && response.ok()
    )
    await page.getByTestId('project-group-members-retry').click()
    await recovered
    await expect(page.getByTestId('project-group-members-error')).toHaveCount(0)
    await expect(page.getByTestId('collaboration-group-detail-name')).toHaveValue(
      'Group saved during member failure'
    )
    expect(pageErrors).toEqual([])
  } finally {
    await page.unroute(memberUrl, loseRealResponse)
  }
})
