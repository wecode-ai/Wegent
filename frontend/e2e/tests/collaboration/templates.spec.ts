// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const { parse: parseYaml } = createRequire(
  resolve(__dirname, '../../../../packages/collaboration/package.json')
)('yaml')
const definitions = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../shared/data/collaboration-templates.json'), 'utf8')
)

test('imports a portable collaboration template, saves privately and explicitly publishes it', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const name = `协作模板-${Date.now()}-${testInfo.workerIndex}`
  const document = structuredClone(definitions[0])
  document.spec.displayName = name
  await page.goto('/resource-library?type=template')
  await expect(page.getByTestId('resource-library-template-marketplace')).toBeVisible()
  await page.getByTestId('template-import-open').click()
  await page.getByTestId('template-import-file').setInputFiles({
    name: 'invalid.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from('kind: Task\nspec: {}'),
  })
  await expect(page.getByTestId('collaboration-template-dialog').getByRole('alert')).toBeVisible()
  await expect(page.getByTestId('template-import-save')).toBeDisabled()
  await page.getByTestId('template-import-file').setInputFiles({
    name: 'workflow.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(JSON.stringify(document)),
  })
  await expect(page.getByTestId('collaboration-template-preview')).toContainText('发布交付')
  await page.screenshot({ path: testInfo.outputPath('01-yaml-preview.png'), fullPage: true })
  await page.getByTestId('template-import-save').click()
  await expect(page.getByTestId('collaboration-template-dialog')).toHaveCount(0)
  await expect(page.getByTestId('collaboration-template-page')).toContainText(name)
  const authToken = (await page.context().cookies()).find(
    cookie => cookie.name === 'auth_token'
  )?.value
  expect(authToken).toBeTruthy()
  const headers = { Authorization: `Bearer ${authToken}` }
  const list = await request.get(`${API_BASE_URL}/api/v1/collaboration-templates`, { headers })
  expect(list.ok()).toBeTruthy()
  const saved = (await list.json()).items.find(
    (item: { displayName: string }) => item.displayName === name
  )
  expect(saved).toBeTruthy()
  const definition = await request.get(
    `${API_BASE_URL}/api/v1/collaboration-templates/${saved.id}`,
    { headers }
  )
  expect(definition.ok()).toBeTruthy()
  const record = await definition.json()
  expect(record.document.kind).toBe('Template')
  expect(record.document.spec.category).toBe('collaboration')
  expect(record.document.spec.resources.collaboration.groups).toEqual(
    document.spec.resources.collaboration.groups
  )
  const discoverBefore = await request.get(
    `${API_BASE_URL}/api/resource-library/listings?resource_type=template&keyword=${encodeURIComponent(name)}`,
    { headers }
  )
  expect(discoverBefore.ok()).toBeTruthy()
  expect(
    (await discoverBefore.json()).items.some((item: { id: number }) => item.id === saved.id)
  ).toBe(false)
  // YAML import and project save use the same private Kind protocol. Publication remains explicit.
  const publish = await request.post(`${API_BASE_URL}/api/resource-library/listings`, {
    headers,
    data: {
      resource_type: 'template',
      source_id: saved.id,
      display_name: name,
      version: document.spec.version,
      status: 'published',
    },
  })
  expect(publish.ok()).toBeTruthy()
  await page.getByTestId('template-tab-discover').click()
  await page.getByTestId('template-search').fill(name)
  await page.getByTestId('template-refresh').click()
  const card = page.getByTestId(`template-card-${record.document.metadata.name}`)
  await expect(card).toContainText(name)
  await page.getByTestId(`template-details-${record.document.metadata.name}`).click()
  await expect(page.getByTestId('template-account-add')).toBeDisabled()
  await page.screenshot({
    path: testInfo.outputPath('02-marketplace-template.png'),
    fullPage: true,
  })
  const username = `template-reader-${Date.now()}-${testInfo.workerIndex}`
  const password = `template-fixture-${Date.now()}`
  const userResponse = await request.post(`${API_BASE_URL}/api/admin/users`, {
    headers,
    data: { user_name: username, password, role: 'user', auth_source: 'password' },
  })
  expect(userResponse.ok()).toBeTruthy()
  const consumer = await userResponse.json()
  const login = await request.post(`${API_BASE_URL}/api/auth/login`, {
    data: { user_name: username, password },
  })
  expect(login.ok()).toBeTruthy()
  const consumerToken = (await login.json()).access_token
  const context = await browser.newContext({
    storageState: buildStorageState(
      new URL(page.url()).origin,
      consumerToken,
      getJwtExpiryMs(consumerToken)
    ),
  })
  try {
    const consumerPage = await context.newPage()
    await consumerPage.goto(new URL('/resource-library?type=template', page.url()).href)
    await consumerPage.getByTestId('template-search').fill(name)
    await consumerPage.getByTestId(`template-details-${saved.id}`).click()
    await expect(consumerPage.getByTestId('template-account-add')).toBeEnabled()
    await consumerPage.screenshot({
      path: testInfo.outputPath('03-install-preview.png'),
      fullPage: true,
    })
    const installation = consumerPage.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/resource-library/listings/${saved.id}/install`
    )
    await consumerPage.getByTestId('template-account-add').click()
    expect((await installation).ok()).toBeTruthy()
    await expect(consumerPage.getByTestId('template-account-add')).toHaveText(/已添加|Added/)
    await expect(consumerPage.getByTestId('template-account-add')).toBeDisabled()
    const installed = await request.get(`${API_BASE_URL}/api/v1/collaboration-templates`, {
      headers: { Authorization: `Bearer ${consumerToken}` },
    })
    expect(installed.ok()).toBeTruthy()
    expect(
      (await installed.json()).items.some((item: { id: number }) => item.id === saved.id)
    ).toBe(true)
    await consumerPage.getByTestId('template-detail-cancel').click()
    await consumerPage.getByTestId('template-tab-available').click()
    await expect(consumerPage.getByTestId(`template-card-${saved.id}`)).toContainText(name)
    await consumerPage.screenshot({
      path: testInfo.outputPath('04-installed-capability.png'),
      fullPage: true,
    })
  } finally {
    await context.close()
    const archived = await request.put(
      `${API_BASE_URL}/api/resource-library/listings/${saved.id}/publication`,
      { headers, data: { status: 'archived' } }
    )
    expect(archived.ok()).toBeTruthy()
    const removed = await request.delete(`${API_BASE_URL}/api/admin/users/${consumer.id}`, {
      headers,
    })
    expect(removed.status()).toBe(204)
  }
})

test('exports configuration from project settings without task content or member identities', async ({
  page,
  request,
}, testInfo) => {
  await page.goto('/collaboration')
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  const authToken = (await page.context().cookies()).find(
    cookie => cookie.name === 'auth_token'
  )?.value
  expect(authToken).toBeTruthy()
  const headers = { Authorization: `Bearer ${authToken}` }
  const me = await request.get(`${API_BASE_URL}/api/users/me`, { headers })
  expect(me.ok()).toBeTruthy()
  const user = await me.json()
  const workspaceResponse = await request.post(`${API_BASE_URL}/api/v1/workspaces`, {
    headers,
    data: { name: `Export workspace ${Date.now()}` },
  })
  expect(workspaceResponse.ok()).toBeTruthy()
  const workspace = await workspaceResponse.json()
  let projectId: string | null = null
  try {
    const projectResponse = await request.post(
      `${API_BASE_URL}/api/v1/workspaces/${workspace.id}/projects`,
      {
        headers,
        data: {
          name: 'Portable workflow',
          projectKey: 'TMPL',
          taskProvider: 'local',
          visibility: 'private',
        },
      }
    )
    expect(projectResponse.ok()).toBeTruthy()
    const project = await projectResponse.json()
    projectId = project.id
    const coordinator = { kind: 'human', id: String(user.id), responsibility: '' }
    const groupResponse = await request.post(
      `${API_BASE_URL}/api/v1/cloud-projects/${project.id}/collaboration-groups`,
      {
        headers,
        data: {
          name: '验收小组',
          description: '验证交付成果',
          instructions: '核对交付清单',
          leader: coordinator,
          members: [coordinator],
          coordination_mode: 'manager',
          stages: [{ id: 'acceptance', name: '交付验收', description: '核对结果', assignee: null }],
          execution_requirements: { required_tags: [] },
        },
      }
    )
    expect(groupResponse.ok(), await groupResponse.text()).toBeTruthy()
    const issueResponse = await request.post(
      `${API_BASE_URL}/api/v1/cloud-projects/${project.id}/loop-items`,
      {
        headers,
        data: { title: 'PRIVATE_TASK_CONTENT_DO_NOT_EXPORT', status: 'pending', priority: 'none' },
      }
    )
    expect(issueResponse.ok()).toBeTruthy()
    await page.goto(
      `/collaboration/workspaces/${workspace.id}/projects/${project.id}?view=manage&section=configuration-sharing`
    )
    await expect(page.getByTestId('project-template-export')).toBeEnabled()
    await page.screenshot({
      path: testInfo.outputPath('05-configuration-export.png'),
      fullPage: true,
    })
    const downloaded = page.waitForEvent('download')
    await page.getByTestId('project-template-export').click()
    const download = await downloaded
    const filename = testInfo.outputPath('exported-workflow.yaml')
    await download.saveAs(filename)
    const contents = readFileSync(filename, 'utf8')
    const portable = parseYaml(contents)
    expect(portable.kind).toBe('Template')
    expect(portable.spec.category).toBe('collaboration')
    expect(portable.spec.resources.collaboration.groups[0].stages[0].name).toBe('交付验收')
    expect(portable.spec.resources.collaboration.groups[0].leaderRole).toBe('role-0')
    expect(contents).not.toContain('PRIVATE_TASK_CONTENT_DO_NOT_EXPORT')
    expect(portable.spec.resources.collaboration.groups[0].roles[0]).not.toHaveProperty('id')
    expect(portable.metadata).toEqual({ name: expect.any(String), namespace: 'default' })
    await page.getByTestId('collaboration-tab-board').click()
    await expect(page.getByTestId('project-template-export')).toHaveCount(0)
    await expect(page.getByTestId('collaboration-board')).toContainText(
      'PRIVATE_TASK_CONTENT_DO_NOT_EXPORT'
    )
  } finally {
    for (const path of [
      ...(projectId ? [`/api/v1/cloud-projects/${projectId}`] : []),
      `/api/v1/workspaces/${workspace.id}`,
    ]) {
      const current = await request.get(`${API_BASE_URL}${path}`, { headers })
      expect(current.ok()).toBeTruthy()
      const resource = await current.json()
      const removed = await request.delete(`${API_BASE_URL}${path}?version=${resource.version}`, {
        headers,
      })
      expect(removed.status()).toBe(204)
    }
  }
})
