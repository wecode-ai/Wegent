// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const definitions = JSON.parse(
  readFileSync(
    new URL('../../../../shared/data/collaboration-templates.json', import.meta.url),
    'utf8'
  )
)

test('imports a portable collaboration template, saves privately and explicitly publishes it', async ({
  page,
  request,
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
})
