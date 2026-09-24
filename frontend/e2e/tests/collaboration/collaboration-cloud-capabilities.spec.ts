// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { webApi, writeSharedComposer } from '../../utils/collaboration-test-support'
import { REGULAR_USER } from '../../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { createApiClient } from '../../utils/api-client'

const appBaseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000'
const evidenceDir = process.env.COLLABORATION_EVIDENCE_DIR

interface CloudProject {
  id: string
  name: string
  project_key: string
  tags?: string[]
  board_config?: {
    statuses: Array<{ id: string; name: string }>
  }
  version: number
}

interface CloudWorkspace {
  id: string
  name: string
  version: number
}

interface CloudIssue {
  id: string
  assignee_user_id: number | null
  assignee_group_id?: string | null
  assignee_group_name?: string | null
  priority: string
  status: string
  tags: string[]
  version: number
  workflow?: {
    nodes: Array<{
      id: string
      status: string
    }>
  }
}

interface CloudCollaborationGroup {
  id: string
  workspace_id: string
  owner_type: 'workspace' | 'project'
  owner_id: string
  name: string
  leader: { kind: 'human' | 'agent'; id: string }
  members: Array<{ kind: 'human' | 'agent'; id: string }>
}

interface CloudFile {
  id: number
  kind: 'file' | 'folder'
  path: string
  version: number
}

interface SearchUser {
  id: number
  user_name: string
}

function collaborationProjectPath(
  workspaceId: string,
  projectId: string,
  options: { issueId?: string; view?: string } = {}
): string {
  const base = `/collaboration/workspaces/${encodeURIComponent(
    workspaceId
  )}/projects/${encodeURIComponent(projectId)}`
  const path = options.issueId ? `${base}/issues/${encodeURIComponent(options.issueId)}` : base
  return options.view && options.view !== 'board'
    ? `${path}?view=${encodeURIComponent(options.view)}`
    : path
}

async function captureEvidence(page: Page, name: string): Promise<void> {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({
    path: path.join(evidenceDir, `${name}.png`),
    fullPage: true,
  })
}

async function createWorkspaceByApi(page: Page, name: string): Promise<CloudWorkspace> {
  return webApi(page, '/api/v1/workspaces', {
    method: 'POST',
    body: {
      name,
      description: 'Collaboration cloud capability E2E workspace',
    },
  })
}

async function createProjectByApi(
  page: Page,
  workspaceId: string,
  name: string
): Promise<CloudProject> {
  return webApi(page, '/api/v1/cloud-projects', {
    method: 'POST',
    body: {
      workspace_id: workspaceId,
      name,
      description: 'Collaboration cloud capability E2E project',
      task_provider: 'local',
      visibility: 'private',
    },
  })
}

async function createProjectByUi(
  page: Page,
  workspaceName: string,
  projectName: string
): Promise<{ project: CloudProject; workspace: CloudWorkspace }> {
  await page.goto('/collaboration')
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  await page.getByTestId('collaboration-workspace-create').click()
  await page.getByTestId('collaboration-workspace-name-input').fill(workspaceName)
  await page
    .getByTestId('collaboration-workspace-description-input')
    .fill('Created through the shared Collaboration UI.')
  await page.getByTestId('collaboration-workspace-create-confirm').click()
  await expect(page).toHaveURL(/\/collaboration\/workspaces\/[^/?]+$/)
  const workspaceId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
  const workspace = await webApi<CloudWorkspace>(
    page,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
  )

  await page.getByTestId('collaboration-workspace-project-create').click()
  await page.getByTestId('collaboration-workspace-project-create-blank').click()
  await page.getByTestId('collaboration-project-name-input').fill(projectName)
  await page.getByTestId('collaboration-project-create-advanced').click()
  await page
    .getByTestId('collaboration-project-description-input')
    .fill('Created through the shared Collaboration UI.')
  await page.getByTestId('collaboration-project-create-confirm').click()
  await expect(page).toHaveURL(
    new RegExp(`/collaboration/workspaces/${encodeURIComponent(workspaceId)}/projects/[^/?]+$`)
  )
  const projectId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
  const project = await webApi<CloudProject>(
    page,
    `/api/v1/cloud-projects/${encodeURIComponent(projectId)}`
  )

  await page.getByTestId('collaboration-workspace-nav-projects').click()
  await expect(page.getByTestId(`collaboration-workspace-project-${project.id}`)).toContainText(
    project.name
  )
  await page.getByTestId(`collaboration-workspace-project-${project.id}`).click()
  await expect(page.getByTestId('collaboration-empty-project')).toBeVisible()

  return { project, workspace }
}

async function createIssueByApi(
  page: Page,
  projectId: string,
  title: string,
  overrides: Record<string, unknown> = {}
): Promise<CloudIssue> {
  return webApi(page, `/api/v1/cloud-projects/${encodeURIComponent(projectId)}/loop-items`, {
    method: 'POST',
    body: {
      title,
      description: 'Created for Collaboration capability E2E.',
      status: 'pending',
      priority: 'none',
      tags: [],
      ...overrides,
    },
  })
}

async function uploadIssueAttachment(
  page: Page,
  issueId: string,
  name: string,
  content: string
): Promise<{ id: string }> {
  return page.evaluate(
    async ({ attachmentContent, attachmentName, targetIssueId }) => {
      const form = new FormData()
      form.set(
        'file',
        new File([attachmentContent], attachmentName, { type: 'text/plain' }),
        attachmentName
      )
      const response = await fetch(
        `/api/v1/loop-items/${encodeURIComponent(targetIssueId)}/attachments`,
        {
          method: 'POST',
          body: form,
        }
      )
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`POST issue attachment: ${response.status} ${text}`)
      }
      return JSON.parse(text) as { id: string }
    },
    { attachmentContent: content, attachmentName: name, targetIssueId: issueId }
  )
}

async function archiveProject(page: Page, projectId: string): Promise<void> {
  const project = await webApi<CloudProject>(
    page,
    `/api/v1/cloud-projects/${encodeURIComponent(projectId)}`
  )
  await webApi(
    page,
    `/api/v1/cloud-projects/${encodeURIComponent(projectId)}?version=${project.version}`,
    { method: 'DELETE' }
  )
}

async function archiveWorkspace(page: Page, workspaceId: string): Promise<void> {
  const workspace = await webApi<CloudWorkspace>(
    page,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
  )
  await webApi(
    page,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}?version=${workspace.version}`,
    { method: 'DELETE' }
  )
}

async function regularUser(page: Page): Promise<SearchUser> {
  const response = await webApi<{ users: SearchUser[] }>(
    page,
    `/api/users/search?q=${encodeURIComponent(REGULAR_USER.username)}&limit=20`
  )
  const user = response.users.find(candidate => candidate.user_name === REGULAR_USER.username)
  expect(user, `Global E2E setup must provision ${REGULAR_USER.username}`).toBeDefined()
  return user!
}

async function addProjectMember(
  page: Page,
  projectId: string,
  userId: number,
  role: 'Developer' | 'Reporter' | 'RestrictedAnalyst'
): Promise<void> {
  await webApi(page, `/api/v1/cloud-projects/${encodeURIComponent(projectId)}/members`, {
    method: 'POST',
    body: { user_id: userId, role },
  })
}

async function issue(page: Page, issueId: string): Promise<CloudIssue> {
  return webApi(
    page,
    `/api/v1/loop-items/${encodeURIComponent(issueId)}?e2e_cache_key=${encodeURIComponent(
      crypto.randomUUID()
    )}`
  )
}

async function webApiStatus(page: Page, path: string): Promise<number> {
  return page.evaluate(async requestPath => {
    const response = await fetch(requestPath, { cache: 'no-store' })
    return response.status
  }, path)
}

async function selectGroupBy(
  page: Page,
  projectId: string,
  groupBy: 'status' | 'priority' | 'assignee' | 'tag'
): Promise<void> {
  const updateResponse = page.waitForResponse(
    response =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname.endsWith(`/cloud-projects/${projectId}`)
  )
  await page.getByTestId('cloud-board-group-by').click()
  await page.getByTestId(`cloud-board-group-option-${groupBy}`).click()
  const response = await updateResponse
  expect(response.ok(), `Board grouping update failed: ${await response.text()}`).toBe(true)
  await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute('data-value', groupBy)
}

async function dragIssueTo(page: Page, issueId: string, columnKey: string): Promise<void> {
  const source = page.getByTestId(`collaboration-issue-${issueId}`)
  const target = page.getByTestId(`cloud-todo-column-dropzone-${columnKey}`)
  await expect(source).toBeVisible()
  await expect(target).toBeAttached()

  const mutationResponse = page.waitForResponse(response => {
    const pathname = new URL(response.url()).pathname
    return (
      ['PATCH', 'POST'].includes(response.request().method()) &&
      (pathname.includes(`/loop-items/${encodeURIComponent(issueId)}`) ||
        pathname.endsWith('/loop-items/reorder'))
    )
  })
  const handle = page.getByTestId(`cloud-todo-card-${issueId}`)
  await handle.scrollIntoViewIfNeeded()
  const sourceBox = await handle.boundingBox()
  expect(sourceBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + 20, sourceBox!.y + 20)
  await page.mouse.down()
  try {
    await page.mouse.move(sourceBox!.x + 30, sourceBox!.y + 20)
    await expect(page.getByTestId('project-board-drag-overlay')).toBeVisible()
    await target.scrollIntoViewIfNeeded()
    const targetBox = await target.boundingBox()
    expect(targetBox).not.toBeNull()
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + 10, { steps: 10 })
    await expect(page.getByTestId(`cloud-todo-column-drag-hint-${columnKey}`)).toBeVisible()
  } finally {
    await page.mouse.up()
  }
  const response = await mutationResponse
  expect(response.ok(), `Board mutation failed: ${await response.text()}`).toBe(true)
}

async function openRegularUserProject(
  browser: Browser,
  ownerPage: Page,
  workspaceId: string,
  projectId: string,
  view?: 'files' | 'automation' | 'manage'
) {
  const login = await createApiClient(ownerPage.request).login(
    REGULAR_USER.username,
    REGULAR_USER.password,
    1
  )
  expect(login.status).toBe(200)
  const token = login.data?.access_token
  if (!token) throw new Error('Restricted user login did not return an access token')
  const context = await browser.newContext({
    storageState: buildStorageState(appBaseUrl, token, getJwtExpiryMs(token)),
  })
  const page = await context.newPage()
  await page.goto(collaborationProjectPath(workspaceId, projectId, view ? { view } : {}))
  return { context, page }
}

test.describe('Collaboration cloud capabilities', () => {
  test('aligns Web resource navigation and collaboration-group assignment with cloud collaboration', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    const workspaceGroupName = `Workspace group ${suffix}`
    const projectName = `Group project ${suffix}`
    const issueTitle = `Group issue ${suffix}`
    let projectId = ''
    let workspaceId = ''

    try {
      await page.goto('/collaboration')
      await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()

      for (const resource of ['agents', 'teams', 'devices'] as const) {
        await expect(page.getByTestId(`collaboration-nav-${resource}`)).toBeVisible()
        await page.getByTestId(`collaboration-nav-${resource}`).click()
        await expect(page).toHaveURL(`/collaboration/${resource}`)
        await expect(page.getByTestId(`collaboration-${resource}-page`)).toBeVisible()
      }

      const workspace = await createWorkspaceByApi(page, `Group Workspace ${suffix}`)
      workspaceId = workspace.id
      await page.goto(`/collaboration/workspaces/${encodeURIComponent(workspace.id)}/participants`)
      await expect(
        page.getByTestId('collaboration-workspace-participants-tab-agents')
      ).toBeVisible()
      await page.getByTestId('collaboration-workspace-participants-tab-groups').click()
      await page.getByTestId('collaboration-group-open-create').click()
      await page.getByTestId('collaboration-group-name').fill(workspaceGroupName)
      await page
        .getByTestId('collaboration-group-description')
        .fill('Workspace collaboration group created through the Web UI.')
      await expect(page.getByTestId('collaboration-group-create')).toBeEnabled()
      const createWorkspaceGroupResponse = page.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname
        return (
          response.request().method() === 'POST' &&
          pathname.endsWith(`/workspaces/${encodeURIComponent(workspace.id)}/collaboration-groups`)
        )
      })
      await page.getByTestId('collaboration-group-create').click()
      const workspaceGroupResponse = await createWorkspaceGroupResponse
      expect(
        workspaceGroupResponse.ok(),
        `Workspace group creation failed: ${await workspaceGroupResponse.text()}`
      ).toBe(true)
      const workspaceGroup = (await workspaceGroupResponse.json()) as CloudCollaborationGroup
      expect(workspaceGroup).toMatchObject({
        workspace_id: workspace.id,
        owner_type: 'workspace',
        owner_id: workspace.id,
        name: workspaceGroupName,
      })
      expect(workspaceGroup.members).toContainEqual(workspaceGroup.leader)

      await page.getByTestId('collaboration-workspace-nav-projects').click()
      await page.getByTestId('collaboration-workspace-project-create').click()
      await page.getByTestId('collaboration-workspace-project-create-blank').click()
      await page.getByTestId('collaboration-project-name-input').fill(projectName)
      await page.getByTestId('collaboration-project-create-add-collaborator').click()
      await page
        .getByTestId('collaboration-project-create-collaborator-menu')
        .getByRole('button', { name: new RegExp(workspaceGroupName) })
        .click()
      const createProjectResponse = page.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname
        return (
          response.request().method() === 'POST' &&
          pathname.endsWith(`/workspaces/${encodeURIComponent(workspace.id)}/projects`)
        )
      })
      await page.getByTestId('collaboration-project-create-confirm').click()
      const projectResponse = await createProjectResponse
      expect(projectResponse.ok(), `Project creation failed: ${await projectResponse.text()}`).toBe(
        true
      )
      const project = (await projectResponse.json()) as CloudProject
      projectId = project.id
      await expect(page).toHaveURL(collaborationProjectPath(workspace.id, project.id))

      let projectGroups: CloudCollaborationGroup[] = []
      await expect
        .poll(async () => {
          projectGroups = (
            await webApi<{ items: CloudCollaborationGroup[] }>(
              page,
              `/api/v1/cloud-projects/${encodeURIComponent(project.id)}/collaboration-groups`
            )
          ).items
          return projectGroups.filter(group => group.owner_type === 'project').length
        })
        .toBe(1)
      const projectGroup = projectGroups.find(group => group.owner_type === 'project')!
      expect(projectGroup).toMatchObject({
        workspace_id: workspace.id,
        owner_type: 'project',
        owner_id: project.id,
      })
      expect(projectGroup.members).toContainEqual(projectGroup.leader)

      await page.getByTestId('collaboration-issue-create').click()
      await page.getByTestId('cloud-todo-title').fill(issueTitle)
      await page.getByTestId('cloud-todo-create-assignee').click()
      await page.getByTestId(`cloud-todo-create-assignee-option-group:${projectGroup.id}`).click()
      await expect(page.getByTestId('cloud-todo-create-assignee')).toHaveAttribute(
        'data-value',
        `group:${projectGroup.id}`
      )
      await page.getByTestId('cloud-todo-create-confirm').click()
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      const issueId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
      await expect
        .poll(async () => {
          const created = await issue(page, issueId)
          return {
            groupId: created.assignee_group_id,
            groupName: created.assignee_group_name,
          }
        })
        .toEqual({
          groupId: projectGroup.id,
          groupName: projectGroup.name,
        })
      await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        `group:${projectGroup.id}`
      )
      await captureEvidence(page, 'web-00-cloud-collaboration-group')
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })

  test('covers project home, UI project and Issue creation, comment, attachment and collaborator', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    let projectId = ''
    let workspaceId = ''
    try {
      await page.goto('/collaboration')
      await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
      await expect(page.getByTestId('collaboration-workspace-create')).toBeVisible()
      const created = await createProjectByUi(
        page,
        `Cloud Workspace ${suffix}`,
        `Cloud Core ${suffix}`
      )
      const { project, workspace } = created
      projectId = project.id
      workspaceId = workspace.id

      await page.goto('/collaboration')
      await expect(page.getByTestId(`collaboration-workspace-${workspace.id}`)).toContainText(
        workspace.name
      )
      const workspaceToggle = page.getByTestId(`collaboration-workspace-toggle-${workspace.id}`)
      if ((await workspaceToggle.getAttribute('aria-expanded')) !== 'true') {
        await workspaceToggle.click()
      }
      const projectNavigation = page.getByTestId(`collaboration-workspace-project-${project.id}`)
      await expect(projectNavigation).toContainText(project.name)
      await captureEvidence(page, 'web-01-project-home')

      await projectNavigation.click()
      await expect(page.getByTestId('collaboration-empty-project')).toBeVisible()
      await page.goto(collaborationProjectPath(workspace.id, project.id))
      await expect(page.getByTestId('collaboration-root')).toBeVisible()
      await expect(page.getByTestId(`collaboration-workspace-project-${project.id}`)).toContainText(
        project.name
      )
      await expect(page.getByTestId(`collaboration-workspace-project-${project.id}`)).toHaveClass(
        /active/
      )
      await page.getByTestId(`collaboration-workspace-project-${project.id}`).click()
      await expect(page).toHaveURL(
        new RegExp(
          `${collaborationProjectPath(workspace.id, project.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
        )
      )
      const member = await regularUser(page)
      await addProjectMember(page, project.id, member.id, 'Developer')
      await page.reload()
      await expect(page.getByTestId(`collaboration-workspace-project-${project.id}`)).toContainText(
        project.name
      )

      await page.getByTestId('collaboration-issue-create').click()
      await page.getByTestId('cloud-todo-title').fill(`Cloud Issue ${suffix}`)
      await page
        .getByTestId('cloud-todo-detail-description')
        .fill('Created and edited through the shared Issue editor.')
      const issueCreateResponse = page.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname
        return (
          response.request().method() === 'POST' &&
          pathname.endsWith(`/cloud-projects/${project.id}/loop-items`)
        )
      })
      const issueDetailNavigation = page.waitForURL(url =>
        new RegExp(
          `${collaborationProjectPath(workspace.id, project.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/[^/?]+$`
        ).test(url.pathname)
      )
      await page.getByTestId('cloud-todo-create-confirm').click()
      const [createdIssueResponse] = await Promise.all([issueCreateResponse, issueDetailNavigation])
      expect(
        createdIssueResponse.ok(),
        `Issue creation failed: ${await createdIssueResponse.text()}`
      ).toBe(true)
      const createdIssue = (await createdIssueResponse.json()) as CloudIssue
      expect(new URL(page.url()).pathname).toBe(
        collaborationProjectPath(workspace.id, project.id, {
          issueId: createdIssue.id,
        })
      )
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      const issueId = createdIssue.id

      await writeSharedComposer(
        page.getByTestId('collaboration-issue-comment'),
        'Cloud E2E persistent comment'
      )
      await page.getByTestId('collaboration-issue-comment-submit').click()
      await expect(page.getByTestId('collaboration-comments')).toContainText(
        'Cloud E2E persistent comment'
      )

      await page.getByTestId('cloud-todo-edit-content').click()
      await page.getByTestId('cloud-todo-attachment-input').setInputFiles({
        name: `issue-${suffix}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('shared issue attachment evidence'),
      })
      await expect(page.getByText(`issue-${suffix}.txt`, { exact: true })).toBeVisible()

      await page.getByTestId('cloud-todo-more-properties').click()
      await expect(page.getByTestId('cloud-todo-add-collaborator')).toBeVisible()
      await page.getByTestId('cloud-todo-add-collaborator').click()
      await page.getByTestId('cloud-todo-collaborator-select').selectOption(String(member.id))
      await page.getByTestId('cloud-todo-confirm-collaborator').click()
      await expect(
        page.getByTestId('cloud-todo-collaborators').getByRole('button', {
          name: new RegExp(member.user_name),
        })
      ).toBeVisible()

      await page.reload()
      await expect(page.getByTestId('collaboration-comments')).toContainText(
        'Cloud E2E persistent comment'
      )
      await expect(page.getByText(`issue-${suffix}.txt`, { exact: true })).toBeVisible()
      await page.getByTestId('cloud-todo-more-properties').click()
      await expect(
        page.getByTestId('cloud-todo-collaborators').getByRole('button', {
          name: new RegExp(member.user_name),
        })
      ).toBeVisible()
      expect((await issue(page, issueId)).id).toBe(issueId)
      await captureEvidence(page, 'web-02-issue-detail')
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })

  test('moves fields through all four shared board groupings and persists each mutation', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    let projectId = ''
    let workspaceId = ''

    try {
      await page.goto('/collaboration')
      const workspace = await createWorkspaceByApi(page, `Board Groups Workspace ${suffix}`)
      workspaceId = workspace.id
      const project = await createProjectByApi(page, workspace.id, `Board Groups ${suffix}`)
      projectId = project.id
      const member = await regularUser(page)
      await addProjectMember(page, project.id, member.id, 'Developer')
      const currentProject = await webApi<CloudProject>(
        page,
        `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`
      )
      await webApi(page, `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: { version: currentProject.version, tags: [`tag-${suffix}`] },
      })
      const created = await createIssueByApi(page, project.id, `Grouped Issue ${suffix}`)

      await page.goto(collaborationProjectPath(workspace.id, project.id))
      await expect(page.getByTestId(`collaboration-issue-${created.id}`)).toBeVisible()

      await selectGroupBy(page, project.id, 'priority')
      await dragIssueTo(page, created.id, 'priority-high')
      await expect.poll(async () => (await issue(page, created.id)).priority).toBe('high')
      await captureEvidence(page, 'web-03-priority-board')

      await selectGroupBy(page, project.id, 'tag')
      await dragIssueTo(page, created.id, `tag-tag-${suffix}`)
      await expect.poll(async () => (await issue(page, created.id)).tags).toContain(`tag-${suffix}`)
      await captureEvidence(page, 'web-04-tag-board')

      await selectGroupBy(page, project.id, 'assignee')
      await dragIssueTo(page, created.id, `assignee-${member.id}`)
      await expect
        .poll(async () => (await issue(page, created.id)).assignee_user_id)
        .toBe(member.id)
      await captureEvidence(page, 'web-05-assignee-board')

      // A directly assigned human Issue advances through work review, so exercise
      // board status drag with an Issue that has only the implicit creator default.
      const statusIssue = await createIssueByApi(page, project.id, `Board status Issue ${suffix}`)
      await page.reload()
      await selectGroupBy(page, project.id, 'status')
      const reorderResponse = page.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname
        return response.request().method() === 'POST' && pathname.endsWith('/loop-items/reorder')
      })
      await dragIssueTo(page, statusIssue.id, 'completed')
      const reordered = await reorderResponse
      expect(reordered.ok(), `Board reorder failed: ${await reordered.text()}`).toBe(true)
      const reorderedItems = (await reordered.json()) as { items: CloudIssue[] }
      expect(reorderedItems.items.find(item => item.id === statusIssue.id)?.status).toBe(
        'completed'
      )
      expect((await issue(page, statusIssue.id)).status).toBe('completed')
      await page.getByTestId(`collaboration-issue-${statusIssue.id}`).scrollIntoViewIfNeeded()
      await captureEvidence(page, 'web-06-status-board')
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })

  test('creates a folder, uploads, previews, moves and deletes a shared cloud file', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    const folderName = `folder-${suffix}`
    const fileName = `cloud-file-${suffix}.txt`
    const taskAttachmentName = `task-attachment-${suffix}.txt`
    let projectId = ''
    let workspaceId = ''

    try {
      await page.goto('/collaboration')
      const workspace = await createWorkspaceByApi(page, `Files Workspace ${suffix}`)
      workspaceId = workspace.id
      const project = await createProjectByApi(page, workspace.id, `Files ${suffix}`)
      projectId = project.id
      const attachmentIssue = await createIssueByApi(page, project.id, `Attachment Issue ${suffix}`)
      const taskAttachment = await uploadIssueAttachment(
        page,
        attachmentIssue.id,
        taskAttachmentName,
        'cloud task attachment evidence'
      )
      await page.goto(collaborationProjectPath(workspace.id, project.id))
      await page.getByTestId('collaboration-tab-files').click()
      await expect(page.getByTestId('cloud-files-view')).toBeVisible()
      await expect(page.getByTestId(`task-attachment-${taskAttachment.id}`)).toContainText(
        taskAttachmentName
      )
      await page.getByTestId(`task-attachment-${taskAttachment.id}`).scrollIntoViewIfNeeded()
      await captureEvidence(page, 'web-07-task-attachments')

      await page.getByTestId('cloud-folder-add').click()
      await page.getByTestId('cloud-folder-name').fill(folderName)
      await page.getByTestId('cloud-folder-create-confirm').click()
      await page.locator('input[type="file"]').setInputFiles({
        name: fileName,
        mimeType: 'text/plain',
        buffer: Buffer.from('cloud file preview evidence'),
      })

      let files: CloudFile[] = []
      await expect
        .poll(async () => {
          files = (
            await webApi<{ items: CloudFile[] }>(
              page,
              `/api/v1/cloud-projects/${encodeURIComponent(project.id)}/files`
            )
          ).items
          return files.map(file => file.path)
        })
        .toEqual(expect.arrayContaining([folderName, fileName]))
      const uploaded = files.find(file => file.path === fileName)!

      await page.getByRole('button', { name: /共享文件|Shared files/, exact: true }).click()
      await page.getByTestId(`cloud-file-preview-${uploaded.id}`).click()
      await expect(page.getByTestId('cloud-file-preview-sidebar')).toBeVisible()
      await expect(page.getByTestId('cloud-file-preview-title')).toHaveText(fileName)
      await page.getByTestId('cloud-file-preview-close').click()

      await page.getByTestId(`cloud-file-rename-${uploaded.id}`).click()
      await page.getByTestId(`cloud-file-path-${uploaded.id}`).fill(`${folderName}/${fileName}`)
      await page.getByTestId(`cloud-file-path-${uploaded.id}`).press('Enter')
      await expect
        .poll(async () => {
          const response = await webApi<{ items: CloudFile[] }>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}/files`
          )
          return response.items.find(file => file.id === uploaded.id)?.path
        })
        .toBe(`${folderName}/${fileName}`)
      await captureEvidence(page, 'web-08-shared-files')

      await page.getByRole('button', { name: folderName, exact: true }).click()
      await expect(page.getByTestId(`cloud-file-preview-${uploaded.id}`)).toBeVisible()
      page.once('dialog', dialog => dialog.accept())
      await page.getByTestId(`cloud-file-delete-${uploaded.id}`).click()
      await expect
        .poll(async () => {
          const response = await webApi<{ items: CloudFile[] }>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}/files`
          )
          return response.items.some(file => file.id === uploaded.id)
        })
        .toBe(false)

      await page
        .getByTestId('cloud-file-breadcrumbs')
        .getByRole('button', { name: /共享文件|Shared files/, exact: true })
        .click()
      const folder = files.find(file => file.path === folderName)!
      page.once('dialog', dialog => dialog.accept())
      await page.getByTestId(`cloud-file-delete-${folder.id}`).click()
      await expect(page.getByRole('button', { name: folderName, exact: true })).toHaveCount(0)
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })

  test('creates and persists an Issue-created automatic processing rule', async ({ page }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    let projectId = ''
    let workspaceId = ''

    try {
      await page.goto('/collaboration')
      const workspace = await createWorkspaceByApi(page, `Automation Workspace ${suffix}`)
      workspaceId = workspace.id
      const project = await createProjectByApi(page, workspace.id, `Automation ${suffix}`)
      projectId = project.id
      await page.goto(collaborationProjectPath(workspace.id, project.id, { view: 'manage' }))
      await page.getByTestId('collaboration-project-settings-automatic-processing').click()
      await expect(
        page.getByTestId('collaboration-project-automatic-processing-page')
      ).toBeVisible()
      await page.getByTestId('automatic-processing-create').click()
      await expect(page.getByTestId('automatic-processing-form')).toBeVisible()
      await expect(page.getByTestId('automatic-processing-trigger-created')).toBeChecked()
      await expect(page.getByTestId('automatic-processing-target-kind-human')).toHaveAttribute(
        'aria-pressed',
        'true'
      )

      const createResponse = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          response.url().includes(`/api/v1/cloud-projects/${project.id}/automations`)
      )
      await page.getByTestId('automatic-processing-save').click()
      const response = await createResponse
      expect(response.ok(), `Automatic processing creation failed: ${await response.text()}`).toBe(
        true
      )
      const createdRule = (await response.json()) as { id: string }
      expect(createdRule.id).toBeTruthy()
      await expect(page.getByTestId(`automatic-processing-rule-${createdRule.id}`)).toContainText(
        /Issue 创建后|Issue created/
      )
      await expect
        .poll(async () => {
          const rules = await webApi<
            Array<{
              id: string
              eventType?: string
              targetKind?: string
              enabled: boolean
            }>
          >(page, `/api/v1/cloud-projects/${encodeURIComponent(project.id)}/automations`)
          const rule = rules.find(candidate => candidate.id === createdRule.id)
          return {
            enabled: rule?.enabled,
            eventType: rule?.eventType,
            targetKind: rule?.targetKind,
          }
        })
        .toEqual({
          enabled: true,
          eventType: 'task.created',
          targetKind: 'human',
        })

      await page.reload()
      await page.getByTestId('collaboration-project-settings-automatic-processing').click()
      await expect(
        page.getByTestId('collaboration-project-automatic-processing-page')
      ).toBeVisible()
      await expect(page.getByTestId(`automatic-processing-rule-${createdRule.id}`)).toBeVisible()
      await captureEvidence(page, 'web-09-automatic-processing-rule')
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })

  test('renders and advances a shared cloud workflow from the Web Issue detail', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    const stageId = `review-${suffix}`
    let projectId = ''
    let workspaceId = ''

    try {
      await page.goto('/collaboration')
      const workspace = await createWorkspaceByApi(page, `Workflow Workspace ${suffix}`)
      workspaceId = workspace.id
      const project = await createProjectByApi(page, workspace.id, `Workflow ${suffix}`)
      projectId = project.id
      const created = await createIssueByApi(page, project.id, `Workflow Issue ${suffix}`, {
        workflow: {
          version: 1,
          definition_version: 1,
          stage_mode: 'dag',
          advancement_policy: 'manual',
          coordinator_prompt: '',
          nodes: [
            {
              id: stageId,
              name: 'Web 人工验收',
              prompt: '通过 Web 共享详情页完成人工验收。',
              execution_mode: 'human',
              depends_on: [],
              dependency_context: {},
              required: true,
              required_deliverables: [],
              workspace_policy: 'none',
              automation_rule_id: null,
              execution_config: null,
              execution_config_override: false,
              status: 'awaiting_approval',
              task_ids: [],
            },
          ],
        },
      })

      await page.goto(collaborationProjectPath(workspace.id, project.id, { issueId: created.id }))
      await page.getByTestId('cloud-todo-toggle-tasks').click()
      await expect(page.getByTestId('cloud-todo-workflow-stages')).toBeVisible()
      await page.getByTestId(`cloud-todo-workflow-node-${stageId}`).click()
      await expect(page.getByTestId(`cloud-todo-approve-workflow-node-${stageId}`)).toBeVisible()
      await captureEvidence(page, 'web-11-workflow-awaiting-approval')

      const decisionResponse = page.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname
        return (
          response.request().method() === 'POST' &&
          pathname.endsWith(
            `/loop-items/${encodeURIComponent(created.id)}/workflow-nodes/${encodeURIComponent(
              stageId
            )}/decision`
          )
        )
      })
      await page.getByTestId(`cloud-todo-approve-workflow-node-${stageId}`).click()
      const response = await decisionResponse
      expect(response.ok(), `Workflow approval failed: ${await response.text()}`).toBe(true)
      await expect
        .poll(async () => {
          const updated = await issue(page, created.id)
          return updated.workflow?.nodes.find(node => node.id === stageId)?.status
        })
        .toBe('completed')

      await page.reload()
      await page.getByTestId('cloud-todo-toggle-tasks').click()
      await expect(page.getByTestId('cloud-todo-workflow-stages')).toBeVisible()
      await page.getByTestId(`cloud-todo-workflow-node-${stageId}`).click()
      await expect(page.getByTestId(`cloud-todo-approve-workflow-node-${stageId}`)).toHaveCount(0)
      await expect(page.getByTestId(`cloud-todo-workflow-node-${stageId}`)).toContainText(
        /已完成|Completed/
      )
      await captureEvidence(page, 'web-12-workflow-completed')
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })

  test('manages members, visibility, tags, statuses and card fields, then blocks RestrictedAnalyst direct views', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    const tagName = `managed-${suffix}`
    let projectId = ''
    let workspaceId = ''

    try {
      await page.goto('/collaboration')
      const workspace = await createWorkspaceByApi(page, `Manage Workspace ${suffix}`)
      workspaceId = workspace.id
      const project = await createProjectByApi(page, workspace.id, `Manage ${suffix}`)
      projectId = project.id
      const member = await regularUser(page)
      await page.goto(collaborationProjectPath(workspace.id, project.id, { view: 'manage' }))

      await page.getByTestId('collaboration-project-settings-participants').click()
      await page.getByTestId('collaboration-participants-tab-members').click()
      await page.getByTestId('cloud-project-members-toggle').click()
      await page.getByTestId('cloud-member-search').fill(REGULAR_USER.username)
      await page.getByTestId('cloud-member-role').selectOption('Reporter')
      await page.getByTestId(`cloud-member-result-${member.id}`).click()
      await expect(page.getByTestId(`cloud-project-member-${member.id}`)).toBeVisible()
      await expect
        .poll(async () => {
          const response = await webApi<Array<{ user_id: number; role: string }>>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}/members`
          )
          return response.find(candidate => candidate.user_id === member.id)?.role
        })
        .toBe('Reporter')

      await page.getByTestId('collaboration-project-settings-project').click()
      await page.getByTestId('cloud-project-manage-visibility-public').click()
      await expect
        .poll(async () => {
          const updated = await webApi<CloudProject & { visibility: string }>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`
          )
          return updated.visibility
        })
        .toBe('public')

      await page.getByRole('button', { name: /新建标签|New tag/ }).click()
      await page.getByTestId('cloud-project-tag-create-input').fill(tagName)
      await page.getByTestId('cloud-project-tag-create-confirm').click()
      await expect(page.getByTestId(`cloud-project-tag-${tagName}`)).toBeVisible()
      await expect
        .poll(async () => {
          const updated = await webApi<CloudProject>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`
          )
          return updated.tags
        })
        .toContain(tagName)

      const statusCountBefore =
        (
          await webApi<CloudProject>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`
          )
        ).board_config?.statuses.length ?? 0
      await page.getByTestId('collaboration-tab-board').click()
      await page.getByTestId('collaboration-board-settings').click()
      await expect(page.getByTestId('project-board-settings-dialog')).toBeVisible()
      await page.getByTestId('cloud-board-status-add').click()
      await expect(page.locator('[data-testid^="cloud-board-status-status-"]')).toHaveCount(1)
      await expect
        .poll(async () => {
          const updated = await webApi<CloudProject>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`
          )
          return updated.board_config?.statuses.length
        })
        .toBe(statusCountBefore + 1)
      await page.getByTestId('cloud-board-display-menu').click()
      const priorityDisplay = page.getByTestId('cloud-board-display-priority')
      const previousPriorityDisplay = await priorityDisplay.getAttribute('aria-checked')
      await priorityDisplay.click()
      await page.getByTestId('cloud-board-display-menu').click()
      await expect
        .poll(async () => {
          const updated = await webApi<CloudProject & { card_display: { show_priority: boolean } }>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`
          )
          return String(updated.card_display.show_priority)
        })
        .not.toBe(previousPriorityDisplay)
      await captureEvidence(page, 'web-10-project-manage')

      await page.getByTestId('project-board-settings-close').click()
      await expect(page.getByTestId('project-board-settings-dialog')).toBeHidden()
      await expect(page).toHaveURL(
        new RegExp(
          `${collaborationProjectPath(workspace.id, project.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
        )
      )
      await expect(page.getByTestId('collaboration-empty-project')).toBeVisible()
      await captureEvidence(page, 'web-13-board-return')

      await webApi(
        page,
        `/api/v1/cloud-projects/${encodeURIComponent(project.id)}/members/${member.id}`,
        {
          method: 'PATCH',
          body: { role: 'RestrictedAnalyst' },
        }
      )

      for (const view of ['files', 'automation', 'manage'] as const) {
        const restricted = await openRegularUserProject(
          browser,
          page,
          workspace.id,
          project.id,
          view
        )
        try {
          await expect(restricted.page).toHaveURL(
            new RegExp(
              `${collaborationProjectPath(workspace.id, project.id).replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
              )}(?:\\?view=board)?$`
            )
          )
          await expect(restricted.page.getByTestId('collaboration-board')).toBeVisible()
          await expect(restricted.page.getByTestId(`collaboration-tab-${view}`)).toHaveCount(0)
          if (view === 'files') {
            await expect(restricted.page.getByTestId('cloud-files-view')).toHaveCount(0)
          } else if (view === 'automation') {
            await expect(restricted.page.getByTestId('project-automation-policy')).toHaveCount(0)
          } else {
            await expect(restricted.page.getByText(/管理项目|Manage project/)).toHaveCount(0)
          }
        } finally {
          await restricted.context.close()
        }
      }
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })

  test('shows related tasks only while keeping the project available to every signed-in user', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    let projectId = ''
    let workspaceId = ''

    try {
      await page.goto('/collaboration')
      const workspace = await createWorkspaceByApi(page, `Related Tasks Workspace ${suffix}`)
      workspaceId = workspace.id
      const project = await createProjectByApi(page, workspace.id, `Related Tasks ${suffix}`)
      projectId = project.id
      const ownerIssue = await createIssueByApi(page, project.id, `Owner only ${suffix}`)

      await page.goto(collaborationProjectPath(workspace.id, project.id, { view: 'manage' }))
      await page.getByTestId('collaboration-project-settings-project').click()
      await page.getByTestId('cloud-project-manage-visibility-public-restricted').click()
      await expect
        .poll(async () => {
          const updated = await webApi<CloudProject & { visibility: string }>(
            page,
            `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`
          )
          return updated.visibility
        })
        .toBe('public_restricted')

      const regular = await openRegularUserProject(browser, page, workspace.id, project.id)
      try {
        const discovered = await webApi<{ items: Array<{ id: string }> }>(
          regular.page,
          '/api/v1/cloud-projects'
        )
        expect(discovered.items.some(candidate => candidate.id === project.id)).toBe(true)

        await expect(regular.page.getByTestId('collaboration-board')).toBeVisible()
        await expect(regular.page.getByTestId(`collaboration-issue-${ownerIssue.id}`)).toHaveCount(
          0
        )
        expect(
          await webApiStatus(
            regular.page,
            `/api/v1/loop-items/${encodeURIComponent(ownerIssue.id)}`
          )
        ).toBe(404)

        const regularIssue = await createIssueByApi(
          regular.page,
          project.id,
          `Regular user issue ${suffix}`
        )
        await regular.page.reload()
        await expect(
          regular.page.getByTestId(`collaboration-issue-${regularIssue.id}`)
        ).toBeVisible()
        await expect(regular.page.getByTestId(`collaboration-issue-${ownerIssue.id}`)).toHaveCount(
          0
        )

        await page.goto(collaborationProjectPath(workspace.id, project.id))
        await expect(page.getByTestId(`collaboration-issue-${ownerIssue.id}`)).toBeVisible()
        await expect(page.getByTestId(`collaboration-issue-${regularIssue.id}`)).toBeVisible()
      } finally {
        await regular.context.close()
      }
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
    }
  })
})
