// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../../fixtures/executor-test'
import { REGULAR_USER } from '../../config/test-users'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const definitions = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../shared/data/collaboration-templates.json'), 'utf8')
)

for (const destination of ['existing', 'new'] as const) {
  test(`uses a marketplace template in a ${destination} project and persists its configuration`, async ({
    page,
    request,
  }, testInfo) => {
    const suffix = `${Date.now()}-${testInfo.workerIndex}`
    const name = `Template destination ${suffix}`
    const document = structuredClone(definitions[0])
    const configuration = document.spec.resources.collaboration
    const group = configuration.groups[0]
    await page.goto('/resource-library?type=template')
    const token = (await page.context().cookies()).find(
      cookie => cookie.name === 'auth_token'
    )?.value
    expect(token).toBeTruthy()
    const headers = { Authorization: `Bearer ${token}` }
    const me = await request.get(API_BASE_URL + '/api/users/me', { headers })
    expect(me.ok()).toBeTruthy()
    const owner = await me.json()
    const users = await request.get(
      API_BASE_URL +
        '/api/users/search?q=' +
        encodeURIComponent(REGULAR_USER.username) +
        '&limit=20',
      { headers }
    )
    expect(users.ok()).toBeTruthy()
    const executor = (await users.json()).users.find(
      (user: { user_name: string }) => user.user_name === REGULAR_USER.username
    )
    expect(executor).toBeDefined()
    const workspaceResponse = await request.post(`${API_BASE_URL}/api/v1/workspaces`, {
      headers,
      data: { name: `Template space ${suffix}` },
    })
    expect(workspaceResponse.ok()).toBeTruthy()
    const workspace = await workspaceResponse.json()
    let projectId: string | null = null
    try {
      const membership = await request.post(
        API_BASE_URL + '/api/v1/workspaces/' + workspace.id + '/members',
        {
          headers,
          data: { user_id: executor.id, role: 'Developer' },
        }
      )
      expect(membership.ok()).toBeTruthy()
      const bindMembers = async () => {
        await page.getByTestId('template-customize-' + group.key).click()
        for (const role of group.roles) {
          await page
            .getByTestId('template-role-' + group.key + '-' + role.key)
            .selectOption('human:' + (role.key === group.leaderRole ? owner.id : executor.id))
        }
      }
      if (destination === 'existing') {
        const response = await request.post(
          `${API_BASE_URL}/api/v1/workspaces/${workspace.id}/projects`,
          {
            headers,
            data: { name, projectKey: 'USE', taskProvider: 'local', visibility: 'private' },
          }
        )
        expect(response.ok()).toBeTruthy()
        projectId = (await response.json()).id
      }
      await page.getByTestId('template-details-product-lifecycle').click()
      await page.getByTestId('template-use').click()
      if (destination === 'existing') {
        await page.getByTestId(`template-project-${projectId}`).click()
        await bindMembers()
        await page.getByTestId('template-bindings-apply').click()
      } else {
        await page.getByTestId('template-create-project').click()
        const picker = page.getByTestId(`collaboration-project-workspace-${workspace.id}`)
        const nameInput = page.getByTestId('collaboration-project-name-input')
        await expect(picker.or(nameInput)).toBeVisible()
        if (await picker.isVisible()) await picker.click()
        await expect(nameInput).toHaveValue(configuration.project.name)
        await nameInput.fill(name)
        await bindMembers()
        const created = page.waitForResponse(
          response =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `/api/v1/workspaces/${workspace.id}/projects`
        )
        await page.getByTestId('collaboration-project-create-confirm').click()
        const response = await created
        expect(response.ok()).toBeTruthy()
        projectId = (await response.json()).id
      }
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
      await page.reload()
      await expect(page.getByTestId('collaboration-board')).toBeVisible()
      const groups = await request.get(
        `${API_BASE_URL}/api/v1/cloud-projects/${projectId}/collaboration-groups`,
        { headers }
      )
      expect(groups.ok()).toBeTruthy()
      const payload = await groups.json()
      const applied = payload.items.find((item: { name: string }) => item.name === group.name)
      expect(applied).toBeDefined()
      expect(applied.stages.map((stage: { name: string }) => stage.name)).toEqual(
        group.stages.map((stage: { name: string }) => stage.name)
      )
      expect(applied.leader).toEqual(
        expect.objectContaining({ kind: 'human', id: String(owner.id) })
      )
      expect(
        applied.stages.every(
          (stage: { assignee: { kind: string; id: string } }) =>
            stage.assignee.kind === 'human' && stage.assignee.id === String(executor.id)
        )
      ).toBe(true)
      const rules = await request.get(
        `${API_BASE_URL}/api/v1/cloud-projects/${projectId}/automations`,
        { headers }
      )
      expect(rules.ok()).toBeTruthy()
      expect(
        (await rules.json()).some(
          (rule: { targetId: string; eventType: string }) =>
            rule.targetId === applied.id && rule.eventType === 'task.created'
        )
      ).toBe(true)
      const saved = await request.get(`${API_BASE_URL}/api/v1/cloud-projects/${projectId}`, {
        headers,
      })
      expect(saved.ok()).toBeTruthy()
      const project = await saved.json()
      expect(project.tags).toEqual(expect.arrayContaining(configuration.project.board.tags))
      expect(
        project.board_views.views.some(
          (view: { name: string }) => view.name === configuration.project.board.name
        )
      ).toBe(true)
    } finally {
      for (const path of [
        ...(projectId ? [`/api/v1/cloud-projects/${projectId}`] : []),
        `/api/v1/workspaces/${workspace.id}`,
      ]) {
        const response = await request.get(`${API_BASE_URL}${path}`, { headers })
        expect(response.ok()).toBeTruthy()
        const resource = await response.json()
        const removed = await request.delete(`${API_BASE_URL}${path}?version=${resource.version}`, {
          headers,
        })
        expect(removed.status()).toBe(204)
      }
    }
  })
}

test('keeps the built-in template form open without creating a project when the default executor is missing', async ({
  page,
  request,
}) => {
  await page.goto('/resource-library?type=template')
  const token = (await page.context().cookies()).find(cookie => cookie.name === 'auth_token')?.value
  expect(token).toBeTruthy()
  const headers = { Authorization: `Bearer ${token}` }
  const devices = await request.get(`${API_BASE_URL}/api/devices`, { headers })
  expect(devices.ok()).toBeTruthy()
  expect((await devices.json()).items).toHaveLength(0)
  const response = await request.post(`${API_BASE_URL}/api/v1/workspaces`, {
    headers,
    data: { name: `Template readiness ${crypto.randomUUID()}` },
  })
  expect(response.ok()).toBeTruthy()
  const workspace = await response.json()
  try {
    await page.getByTestId('template-details-product-lifecycle').click()
    await page.getByTestId('template-use').click()
    await page.getByTestId('template-create-project').click()
    const picker = page.getByTestId(`collaboration-project-workspace-${workspace.id}`)
    const name = page.getByTestId('collaboration-project-name-input')
    await expect(picker.or(name)).toBeVisible()
    if (await picker.isVisible()) await picker.click()
    await page.getByTestId('collaboration-project-create-confirm').click()
    await expect(
      page.getByTestId('collaboration-project-create-dialog').getByRole('alert')
    ).toContainText(/执行设备暂不可用|execution device is unavailable/)
    await expect(name).toHaveValue(definitions[0].spec.resources.collaboration.project.name)
    const projects = await request.get(
      `${API_BASE_URL}/api/v1/workspaces/${workspace.id}/projects`,
      { headers }
    )
    expect(projects.ok()).toBeTruthy()
    expect((await projects.json()).items).toHaveLength(0)
  } finally {
    const current = await request.get(`${API_BASE_URL}/api/v1/workspaces/${workspace.id}`, {
      headers,
    })
    expect(current.ok()).toBeTruthy()
    const removed = await request.delete(
      `${API_BASE_URL}/api/v1/workspaces/${workspace.id}?version=${(await current.json()).version}`,
      { headers }
    )
    expect(removed.status()).toBe(204)
  }
})
