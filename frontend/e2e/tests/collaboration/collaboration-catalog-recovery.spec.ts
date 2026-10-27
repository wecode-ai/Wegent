// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test as base, type Route } from '@playwright/test'
import { selectCollaborationProjectView, webApi } from '../../utils/collaboration-test-support'
import { PROVIDER_NATIVE_MOCK_URL } from '../../utils/provider-native-test-support'

interface Resource {
  id: string
  version: number
}

interface ProjectFixture {
  project: Resource
  path: string
  workspaceId: string
}

interface CandidateFixture {
  id: number
  name: string
  botId: number
}

const test = base.extend<{
  projectFixture: ProjectFixture
  candidateFixture: CandidateFixture
  secondProjectFixture: ProjectFixture
  secondCandidateFixture: CandidateFixture
}>({
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
        workspaceId: workspace.id,
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
  secondProjectFixture: async ({ page, projectFixture }, use) => {
    const project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
      method: 'POST',
      body: {
        name: `Catalog scope B ${crypto.randomUUID()}`,
        workspace_id: projectFixture.workspaceId,
        task_provider: 'local',
        visibility: 'private',
      },
    })
    try {
      await use({
        project,
        workspaceId: projectFixture.workspaceId,
        path: `/collaboration/workspaces/${projectFixture.workspaceId}/projects/${project.id}`,
      })
    } finally {
      const path = `/api/v1/cloud-projects/${project.id}`
      const current = await webApi<Resource>(page, path)
      await webApi(page, `${path}?version=${current.version}`, { method: 'DELETE' })
    }
  },
  secondCandidateFixture: async ({ page, candidateFixture: first }, use) => {
    const team = await webApi<Omit<CandidateFixture, 'botId'>>(page, '/api/teams', {
      method: 'POST',
      body: {
        name: `${first.name}-b`,
        bots: [{ bot_id: first.botId, bot_prompt: '', role: 'worker' }],
        bind_mode: ['chat'],
        namespace: 'default',
        is_active: true,
      },
    })
    try {
      await use({ ...team, botId: first.botId })
    } finally {
      await webApi(
        page,
        `/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`,
        { method: 'DELETE' }
      )
    }
  },
  candidateFixture: async ({ page, projectFixture }, use) => {
    const name = `e2e-catalog-${projectFixture.project.id}-${crypto.randomUUID()}`
    const modelName = `${name}-model`
    const cleanupPaths: string[] = []
    try {
      await webApi(page, '/api/v1/namespaces/default/models', {
        method: 'POST',
        body: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name: modelName, namespace: 'default' },
          spec: {
            modelConfig: {
              env: {
                model: 'openai',
                model_id: 'catalog-recovery',
                api_key: 'e2e-catalog-key',
                base_url: `${PROVIDER_NATIVE_MOCK_URL}/v1`,
              },
            },
          },
        },
      })
      cleanupPaths.unshift(`/api/v1/namespaces/default/models/${modelName}`)
      const bot = await webApi<{ id: number }>(page, '/api/bots', {
        method: 'POST',
        body: {
          name: `${name}-bot`,
          shell_name: 'Chat',
          agent_config: { bind_model: modelName, bind_model_type: 'user' },
          system_prompt: 'Catalog recovery test assistant.',
          namespace: 'default',
          is_active: true,
        },
      })
      cleanupPaths.unshift(`/api/bots/${bot.id}`)
      const team = await webApi<Omit<CandidateFixture, 'botId'>>(page, '/api/teams', {
        method: 'POST',
        body: {
          name,
          bots: [{ bot_id: bot.id, bot_prompt: '', role: 'worker' }],
          bind_mode: ['chat'],
          namespace: 'default',
          is_active: true,
        },
      })
      cleanupPaths.unshift(
        `/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`
      )
      await use({ ...team, botId: bot.id })
    } finally {
      for (const path of cleanupPaths) {
        await webApi(page, path, { method: 'DELETE' })
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

test('late initial snapshot cannot undo an Issue assignment and refreshed board', async ({
  page,
  projectFixture: { project, path },
}) => {
  const issuePath = `/api/v1/cloud-projects/${project.id}/loop-items`
  const issue = await webApi<Resource>(page, issuePath, {
    method: 'POST',
    body: { title: 'Assignment wins over late home preload', status: 'inbox', priority: 'none' },
  })
  const members = await webApi<Array<{ user_id: number }>>(
    page,
    `/api/v1/cloud-projects/${project.id}/members`
  )
  expect(members.length).toBeGreaterThan(0)
  const assignee = members[0].user_id
  await webApi(page, `/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: { version: issue.version, assignee_user_id: null },
  })
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let fetched = false
  let delivered = false
  const snapshotUrl = (url: URL) =>
    url.pathname === `/api/v1/cloud-projects/${project.id}/board-snapshot`
  const holdFirstSnapshot = async (route: Route) => {
    if (fetched) return route.continue()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    fetched = true
    await held
    await route.fulfill({ response })
    delivered = true
  }
  await page.route(snapshotUrl, holdFirstSnapshot)
  try {
    await page.goto(path)
    await expect.poll(() => fetched).toBe(true)
    // Settings needs project metadata, not the blocked initial board snapshot.
    // Keep the same controller/document while opening the real Issue editor.
    const origin = await page.evaluate(() => performance.timeOrigin)
    await page.evaluate(
      path => window.history.pushState(null, '', path),
      `${path}/issues/${issue.id}?view=manage`
    )
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId(`cloud-todo-detail-assignee-option-user:${assignee}`).click()
    await page.getByTestId('cloud-todo-save').click()
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${assignee}`
    )
    const current = await webApi<Resource & { assignee_user_id: number }>(
      page,
      `/api/v1/loop-items/${issue.id}`
    )
    expect(current.assignee_user_id).toBe(assignee)
    const finished = page.waitForEvent('requestfinished', request =>
      snapshotUrl(new URL(request.url()))
    )
    release()
    await finished
    await expect.poll(() => delivered).toBe(true)
    await page.evaluate(
      () =>
        new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin)
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${assignee}`
    )
    await page.evaluate(path => window.history.pushState(null, '', `${path}?view=board`), path)
    await expect(page.getByTestId(`cloud-todo-card-assignee-${issue.id}`)).not.toHaveText('')
    await page.getByTestId(`collaboration-issue-${issue.id}`).click()
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${assignee}`
    )
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
})

test('settings skip the board snapshot, retry the real candidate catalog, and restore the board', async ({
  page,
  projectFixture: { project, path },
  candidateFixture: candidate,
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
    const catalogResponse = await recovered
    expect(catalogResponse.ok()).toBe(true)
    expect(new URL(catalogResponse.url()).searchParams.get('include_readiness')).toBe('false')
    expect((await catalogResponse.json()).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          team_id: candidate.id,
          name: candidate.name,
          status: 'unchecked',
        }),
      ])
    )
    await expect(page.getByTestId('project-agent-candidates-error')).toHaveCount(0)
    await expect(page.getByTestId('project-agent-candidates-loading')).toHaveCount(0)
    await expect(page.getByTestId(`project-agent-option-${candidate.id}`)).toBeEnabled()
    await expect(page.getByTestId('project-agent-wegent-team')).toContainText(candidate.name)
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

for (const outcome of ['success', 'failure'] as const) {
  test(`cached SPA project switch keeps B groups and mutation scope after B ${outcome} and late A success`, async ({
    page,
    projectFixture: a,
    secondProjectFixture: b,
    candidateFixture: candidate,
    secondCandidateFixture: secondCandidate,
  }) => {
    expect(candidate.id).not.toBe(secondCandidate.id)
    const groupPath = (id: string) => `/api/v1/cloud-projects/${id}/collaboration-groups`
    const agentPath = (id: string) => `/api/v1/cloud-projects/${id}/chat-agents`
    for (const team of [candidate, secondCandidate]) {
      await webApi(page, `/api/v1/workspaces/${a.workspaceId}/agents`, {
        method: 'POST',
        body: { team_id: team.id },
      })
    }
    const createdGroups: Record<string, Resource> = {}
    // Group rosters use Team identity, not the project chat-agent binding id.
    const rosterAgentIds = {
      [a.project.id]: String(candidate.id),
      [b.project.id]: String(secondCandidate.id),
    }
    for (const fixture of [a, b]) {
      const members = await webApi<Array<{ user_id: number; user_name: string }>>(
        page,
        `/api/v1/cloud-projects/${fixture.project.id}/members`
      )
      const leader = {
        kind: 'human',
        id: String(members[0].user_id),
        name: members[0].user_name,
        responsibility: '',
      }
      createdGroups[fixture.project.id] = await webApi<Resource>(
        page,
        groupPath(fixture.project.id),
        {
          method: 'POST',
          body: {
            name: `Group ${fixture === a ? 'A' : 'B'}`,
            leader,
            members: [leader],
            coordination_mode: 'manager',
          },
        }
      )
      await webApi<Resource>(page, agentPath(fixture.project.id), {
        method: 'POST',
        body: {
          runtime: 'wegent',
          wegent_team_id: fixture === a ? candidate.id : secondCandidate.id,
          name: `Agent ${fixture === a ? 'A' : 'B'}`,
        },
      })
    }
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let aFetched = false
    let aReleased = false
    const holdA = async (route: Route) => {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      aFetched = true
      await held
      await route.fulfill({ response })
      aReleased = true
    }
    const aUrl = (url: URL) => url.pathname === groupPath(a.project.id)
    const bUrl = (url: URL) => url.pathname === groupPath(b.project.id)
    const mutations: string[] = []
    page.on('request', request => {
      if (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname.includes('/collaboration-groups/')
      )
        mutations.push(new URL(request.url()).pathname)
    })
    // Warm B in the real project controller, not just the workspace sidebar.
    // Next's production History API navigation retains this document and groups section.
    await page.goto(`/collaboration/workspaces/${a.workspaceId}/projects`)
    await expect(page.getByTestId(`collaboration-workspace-project-${b.project.id}`)).toBeVisible()
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.evaluate(
      path => window.history.pushState(null, '', `${path}?view=manage&section=groups`),
      b.path
    )
    await expect(
      page.getByTestId(`collaboration-group-${createdGroups[b.project.id].id}`)
    ).toContainText('Group B')
    const bMetadataReads: string[] = []
    page.on('request', request => {
      if (
        new URL(request.url()).pathname === `/api/v1/cloud-projects/${b.project.id}` &&
        request.method() === 'GET'
      )
        bMetadataReads.push(request.url())
    })
    await page.route(aUrl, holdA)
    if (outcome === 'failure') await page.route(bUrl, loseRealResponse)
    try {
      await page.evaluate(
        path => window.history.pushState(null, '', `${path}?view=manage&section=groups`),
        a.path
      )
      await expect
        .poll(() => aFetched, {
          timeout: 10_000,
          message: 'A groups must reach the real API before switching',
        })
        .toBe(true)
      await expect(page.getByTestId('collaboration-project-settings-groups')).toHaveAttribute(
        'aria-current',
        'page'
      )
      const settingsPanel = await page.getByTestId('project-settings-shell-content').elementHandle()
      expect(settingsPanel).not.toBeNull()
      const bLoaded =
        outcome === 'success'
          ? page.waitForResponse(response => bUrl(new URL(response.url())) && response.ok())
          : null
      await page.evaluate(
        path => window.history.pushState(null, '', `${path}?view=manage&section=groups`),
        b.path
      )
      if (outcome === 'success') await bLoaded
      else {
        // The lost response generates a failed request rather than a browser response.
        await expect(page.getByTestId('project-groups-load-error')).toBeVisible()
      }
      if (outcome === 'success')
        await expect(
          page.getByTestId(`collaboration-group-${createdGroups[b.project.id].id}`)
        ).toContainText('Group B')
      await expect(page.getByTestId('collaboration-project-settings-groups')).toHaveAttribute(
        'aria-current',
        'page'
      )
      const aFinished = page.waitForEvent('requestfinished', request =>
        aUrl(new URL(request.url()))
      )
      release()
      await expect
        .poll(() => aReleased, {
          timeout: 10_000,
          message: 'The held A response must be delivered',
        })
        .toBe(true)
      await aFinished
      // Drain the delivered response through React before asserting it cannot win.
      await page.evaluate(
        () =>
          new Promise<void>(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
      expect(bMetadataReads).toEqual([])
      expect(await settingsPanel!.evaluate(panel => panel.isConnected)).toBe(true)
      await expect(
        page.getByTestId(`collaboration-group-${createdGroups[a.project.id].id}`)
      ).toHaveCount(0)
      if (outcome === 'failure') {
        await expect(page.getByTestId('project-groups-load-error')).toBeVisible()
        await page.unroute(bUrl, loseRealResponse)
        await page.getByTestId('collaboration-project-settings-agents').click()
        await page.getByTestId('collaboration-project-settings-groups').click()
      }
      const bGroup = createdGroups[b.project.id]
      await expect(page.getByTestId(`collaboration-group-${bGroup.id}`)).toContainText('Group B')
      await page.getByTestId(`collaboration-group-manage-${bGroup.id}`).click()
      await page.getByTestId('collaboration-group-create-add-members').click()
      await expect(
        page.getByTestId(`collaboration-group-create-member-agent-${rosterAgentIds[b.project.id]}`)
      ).toContainText('Agent B')
      await expect(
        page.getByTestId(`collaboration-group-create-member-agent-${rosterAgentIds[a.project.id]}`)
      ).toHaveCount(0)
      await page
        .getByTestId(`collaboration-group-create-member-agent-${rosterAgentIds[b.project.id]}`)
        .click()
      await page.keyboard.press('Escape')
      await page.getByTestId('collaboration-group-detail-name').fill('B scoped save')
      const saved = page.waitForResponse(
        response =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === `${groupPath(b.project.id)}/${bGroup.id}`
      )
      await page.getByTestId('collaboration-group-detail-save').click()
      expect((await saved).ok()).toBe(true)
      await expect(page.getByTestId('collaboration-group-detail-save')).toBeEnabled()
      expect(mutations).toEqual([`${groupPath(b.project.id)}/${bGroup.id}`])
      const result = await webApi<{ items: Array<Resource & { name: string }> }>(
        page,
        groupPath(b.project.id)
      )
      expect(result.items.find(item => item.id === bGroup.id)?.name).toBe('B scoped save')
    } finally {
      release()
      await page.unroute(aUrl, holdA)
      await page.unroute(bUrl, loseRealResponse)
    }
  })
}
