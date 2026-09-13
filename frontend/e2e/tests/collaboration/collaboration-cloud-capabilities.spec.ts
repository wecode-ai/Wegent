// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { REGULAR_USER } from '../../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'

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

interface CloudAutomationRun {
  id: string
  automationId: string
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

async function captureEvidence(page: Page, name: string): Promise<void> {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({
    path: path.join(evidenceDir, `${name}.png`),
    fullPage: true,
  })
}

async function webApi<T>(
  page: Page,
  path: string,
  init: { body?: unknown; method?: string } = {}
): Promise<T> {
  return page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
        method: requestInit.method ?? 'GET',
        cache: 'no-store',
        headers:
          requestInit.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`${requestInit.method ?? 'GET'} ${requestPath}: ${response.status} ${text}`)
      }
      return text ? JSON.parse(text) : null
    },
    { requestPath: path, requestInit: init }
  )
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
  await page.getByTestId('collaboration-project-name-input').fill(projectName)
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

  await page.getByTestId('collaboration-project-back').click()
  await expect(page.getByTestId(`collaboration-project-card-${project.id}`)).toContainText(
    project.name
  )
  await page.getByTestId(`collaboration-project-card-${project.id}`).click()
  await expect(page.getByTestId('collaboration-board')).toBeVisible()

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
  await page.getByTestId('cloud-board-group-by').selectOption(groupBy)
  const response = await updateResponse
  expect(response.ok(), `Board grouping update failed: ${await response.text()}`).toBe(true)
  await expect(page.getByTestId('cloud-board-group-by')).toHaveValue(groupBy)
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
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  try {
    await source.dispatchEvent('dragstart', { dataTransfer })
    const dragHint = page.getByTestId(`cloud-todo-column-drag-hint-${columnKey}`)
    await expect
      .poll(async () => {
        await target.dispatchEvent('dragover', { dataTransfer })
        return dragHint.isVisible().catch(() => false)
      })
      .toBe(true)
    await target.dispatchEvent('drop', { dataTransfer })
  } finally {
    await source.dispatchEvent('dragend', { dataTransfer })
    await dataTransfer.dispose()
  }
  const response = await mutationResponse
  expect(response.ok(), `Board mutation failed: ${await response.text()}`).toBe(true)
}

async function openRestrictedProject(
  browser: Browser,
  ownerPage: Page,
  projectId: string,
  view: 'files' | 'automation' | 'manage'
) {
  const body = await webApi<{ access_token: string }>(ownerPage, '/api/auth/login', {
    method: 'POST',
    body: {
      user_name: REGULAR_USER.username,
      password: REGULAR_USER.password,
    },
  })
  const context = await browser.newContext({
    storageState: buildStorageState(
      appBaseUrl,
      body.access_token,
      getJwtExpiryMs(body.access_token)
    ),
  })
  const page = await context.newPage()
  await page.goto(`/collaboration/${encodeURIComponent(projectId)}?view=${view}`)
  return { context, page }
}

test.describe('Collaboration cloud capabilities', () => {
  test('covers project home, UI project and Issue creation, comment, attachment and collaborator', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const suffix = Date.now()
    let projectId = ''
    let workspaceId = ''
    let myWorkRequestCount = 0
    const countMyWorkRequest = (request: { url(): string }) => {
      if (new URL(request.url()).pathname.endsWith('/cloud-work-items/my-work')) {
        myWorkRequestCount += 1
      }
    }
    page.on('request', countMyWorkRequest)

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
      await page.getByTestId(`collaboration-workspace-${workspace.id}`).click()
      await expect(page.getByTestId(`collaboration-project-card-${project.id}`)).toContainText(
        project.name
      )
      await captureEvidence(page, 'web-01-project-home')

      await page.getByTestId(`collaboration-project-card-${project.id}`).click()
      await expect(page.getByTestId('collaboration-board')).toBeVisible()
      await page.goto(`/collaboration/${encodeURIComponent(project.id)}`)
      await expect(page.getByTestId('collaboration-root')).toBeVisible()
      await expect(page.getByTestId(`cloud-sidebar-project-${project.id}`)).toContainText(
        project.name
      )
      await expect(page.getByTestId('cloud-project-header-title')).toContainText(project.name)
      await expect(page.getByTestId('cloud-projects-home-my-work')).toHaveCount(0)

      const sidebarProject = page.getByTestId(`cloud-sidebar-project-${project.id}`)
      await expect(sidebarProject).toContainText(project.name)
      await expect(sidebarProject).toHaveCSS('color', 'rgb(51, 51, 51)')
      await sidebarProject.click()
      await expect(page).toHaveURL(new RegExp(`/collaboration/${project.id}$`))
      const member = await regularUser(page)
      await addProjectMember(page, project.id, member.id, 'Developer')
      await page.reload()
      await expect(sidebarProject).toContainText(project.name)
      await expect(sidebarProject).toHaveCSS('color', 'rgb(51, 51, 51)')

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
        new RegExp(`/collaboration/${encodeURIComponent(project.id)}/issues/[^/?]+$`).test(
          url.pathname
        )
      )
      await page.getByTestId('cloud-todo-create-confirm').click()
      const [createdIssueResponse] = await Promise.all([issueCreateResponse, issueDetailNavigation])
      expect(
        createdIssueResponse.ok(),
        `Issue creation failed: ${await createdIssueResponse.text()}`
      ).toBe(true)
      const createdIssue = (await createdIssueResponse.json()) as CloudIssue
      expect(new URL(page.url()).pathname).toBe(
        `/collaboration/${encodeURIComponent(project.id)}/issues/${encodeURIComponent(
          createdIssue.id
        )}`
      )
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      const issueId = createdIssue.id

      await page.getByTestId('collaboration-issue-comment').fill('Cloud E2E persistent comment')
      await page.getByTestId('collaboration-issue-comment-submit').click()
      await expect(page.getByTestId('collaboration-comments')).toContainText(
        'Cloud E2E persistent comment'
      )

      await page.getByTestId('cloud-todo-attachment-input').setInputFiles({
        name: `issue-${suffix}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('shared issue attachment evidence'),
      })
      await expect(page.getByText(`issue-${suffix}.txt`, { exact: true })).toBeVisible()

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
      await expect(
        page.getByTestId('cloud-todo-collaborators').getByRole('button', {
          name: new RegExp(member.user_name),
        })
      ).toBeVisible()
      expect((await issue(page, issueId)).id).toBe(issueId)
      await captureEvidence(page, 'web-02-issue-detail')
      expect(myWorkRequestCount).toBe(0)
    } finally {
      if (projectId) await archiveProject(page, projectId)
      if (workspaceId) await archiveWorkspace(page, workspaceId)
      page.off('request', countMyWorkRequest)
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

      await page.goto(`/collaboration/${encodeURIComponent(project.id)}`)
      await expect(page.getByTestId(`collaboration-issue-${created.id}`)).toBeVisible()

      await selectGroupBy(page, project.id, 'priority')
      await dragIssueTo(page, created.id, 'priority-high')
      await expect.poll(async () => (await issue(page, created.id)).priority).toBe('high')
      await captureEvidence(page, 'web-03-priority-board')

      await selectGroupBy(page, project.id, 'assignee')
      await dragIssueTo(page, created.id, `assignee-${member.id}`)
      await expect
        .poll(async () => (await issue(page, created.id)).assignee_user_id)
        .toBe(member.id)
      await captureEvidence(page, 'web-04-assignee-board')

      await selectGroupBy(page, project.id, 'tag')
      await dragIssueTo(page, created.id, `tag-tag-${suffix}`)
      await expect.poll(async () => (await issue(page, created.id)).tags).toContain(`tag-${suffix}`)
      await captureEvidence(page, 'web-05-tag-board')

      await selectGroupBy(page, project.id, 'status')
      const reorderResponse = page.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname
        return response.request().method() === 'POST' && pathname.endsWith('/loop-items/reorder')
      })
      await dragIssueTo(page, created.id, 'completed')
      const reordered = await reorderResponse
      expect(reordered.ok(), `Board reorder failed: ${await reordered.text()}`).toBe(true)
      const reorderedItems = (await reordered.json()) as { items: CloudIssue[] }
      expect(reorderedItems.items.find(item => item.id === created.id)?.status).toBe('completed')
      expect((await issue(page, created.id)).status).toBe('completed')
      await page.getByTestId(`collaboration-issue-${created.id}`).scrollIntoViewIfNeeded()
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
      await page.goto(`/collaboration/${encodeURIComponent(project.id)}?view=files`)
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

  test('creates and auto-saves an automation, runs it, and exposes persisted run history', async ({
    page,
  }) => {
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
      await page.goto(`/collaboration/${encodeURIComponent(project.id)}?view=automation`)
      await expect(page.getByTestId('project-automation-view')).toBeVisible()
      await page.getByTestId('automation-create-blank').click()
      await expect(page.getByTestId('automation-rule-editor')).toBeVisible()

      const createResponse = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          response.url().includes(`/api/v1/cloud-projects/${project.id}/automations`)
      )
      await page.getByTestId('automation-trigger-type').selectOption('schedule')
      await page.getByTestId('automation-editor-name').click()
      await page.getByTestId('automation-editor-name-input').fill(`Cloud Automation ${suffix}`)
      await page.getByTestId('automation-editor-name-input').press('Enter')
      expect((await createResponse).ok()).toBe(true)
      await expect(page.getByTestId('automation-editor-global-actions')).toContainText(
        /已保存|Saved/
      )

      const runResponse = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          /\/automations\/[^/]+\/run$/.test(new URL(response.url()).pathname)
      )
      await page.getByTestId('automation-run').click()
      const run = await runResponse
      expect(run.ok(), `Automation run failed: ${await run.text()}`).toBe(true)
      const runBody = (await run.json()) as CloudAutomationRun
      expect(runBody.automationId).toBeTruthy()

      await page.getByTestId('open-current-automation-runs').click()
      await expect(page.getByTestId(`current-run-${runBody.id}`)).toBeVisible()
      await page.reload()
      const persistedRunsResponse = page.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname
        return (
          response.request().method() === 'GET' &&
          pathname.endsWith(`/automations/${encodeURIComponent(runBody.automationId)}/runs`)
        )
      })
      await page.getByTestId('automation-open-runs').click()
      const runsResponse = await persistedRunsResponse
      expect(
        runsResponse.ok(),
        `Loading persisted automation runs failed: ${await runsResponse.text()}`
      ).toBe(true)
      const persistedRuns = (await runsResponse.json()) as CloudAutomationRun[]
      expect(persistedRuns.some(candidate => candidate.id === runBody.id)).toBe(true)
      await expect(page.getByTestId('automation-runs-loading')).toHaveCount(0)
      await expect(page.getByTestId(`automation-run-${runBody.id}`)).toBeVisible()
      await captureEvidence(page, 'web-09-automation-history')
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

      await page.goto(
        `/collaboration/${encodeURIComponent(project.id)}/issues/${encodeURIComponent(created.id)}`
      )
      await expect(page.getByTestId('cloud-todo-workflow-dag')).toBeVisible()
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
      await expect(page.getByTestId('cloud-todo-workflow-dag')).toBeVisible()
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
      await page.goto(`/collaboration/${encodeURIComponent(project.id)}?view=manage`)

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

      await page.getByTestId('collaboration-tab-board').click()
      await expect(page.getByTestId('collaboration-board')).toBeVisible()
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
        const restricted = await openRestrictedProject(browser, page, project.id, view)
        try {
          await expect(restricted.page).toHaveURL(
            new RegExp(`/collaboration/${project.id}(?:\\?view=board)?$`)
          )
          await expect(restricted.page.getByTestId('collaboration-board')).toBeVisible()
          await expect(restricted.page.getByTestId(`collaboration-tab-${view}`)).toHaveCount(0)
          if (view === 'files') {
            await expect(restricted.page.getByTestId('cloud-files-view')).toHaveCount(0)
          } else if (view === 'automation') {
            await expect(restricted.page.getByTestId('project-automation-view')).toHaveCount(0)
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
})
