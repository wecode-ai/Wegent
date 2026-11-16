import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { Page, Response } from '@playwright/test'

import { ADMIN_USER } from '../../config/test-users'
import { DataBuilders } from '../../fixtures/data-builders'
import { expect, test } from '../../fixtures/test-fixtures'
import { ShellsPage } from '../../pages/settings/shells.page'
import { createApiClient } from '../../utils/api-client'

type Shell = {
  name: string
  namespace: string
  displayName: string
  isReference: boolean
  listingId: number | null
}

type Publication = { id: number; target_groups: string[] }

const LIST_PATH = '/api/shells/unified'
const PUBLICATION_PATH = '/api/resource-library/listings'
const EDIT_LABEL = /^(Edit Shell|编辑 Shell)$/

function isShellList(response: Response, group: string): boolean {
  const url = new URL(response.url())
  return (
    response.request().method() === 'GET' &&
    url.pathname === LIST_PATH &&
    url.searchParams.get('scope') === 'group' &&
    url.searchParams.get('group_name') === group
  )
}

async function readShell(response: Response, name: string, namespace: string): Promise<Shell> {
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: Shell[] }
  const shells = body.data.filter(shell => shell.name === name)
  expect(shells).toHaveLength(1)
  expect(shells[0].namespace).toBe(namespace)
  return shells[0]
}

async function openGroup(page: Page, group: string): Promise<Response> {
  const listed = page.waitForResponse(response => isShellList(response, group))
  await page.goto(`/resource-library?tab=mine&type=shell&source=group&group=${group}`)
  await new ShellsPage(page).waitForShellResourcePage()
  return listed
}

async function openEditor(page: Page, name: string): Promise<void> {
  const publication = page.waitForResponse(response => {
    const url = new URL(response.url())
    return (
      url.pathname === '/api/resource-library/publications/source' &&
      url.searchParams.get('source_name') === name
    )
  })
  await page
    .getByTestId(`shell-card-group-${name}`)
    .getByRole('button', { name: EDIT_LABEL })
    .click()
  expect((await publication).status()).toBe(200)
  await expect(
    page.getByRole('dialog').getByRole('button', { name: /^(Save|保存)$/ })
  ).toBeEnabled()
}

async function saveEditor(page: Page, name: string, namespace: string): Promise<Publication> {
  const updated = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/shells/${name}`
  )
  const published = page.waitForResponse(response => {
    if (
      response.request().method() !== 'POST' ||
      new URL(response.url()).pathname !== PUBLICATION_PATH
    ) {
      return false
    }
    const body = response.request().postDataJSON()
    return body.source_name === name && body.source_namespace === namespace
  })
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Save|保存)$/ })
    .click()
  const updateResponse = await updated
  expect(updateResponse.status()).toBe(200)
  const response = await published
  expect(response.status(), await response.text()).toBe(200)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  return (await response.json()) as Publication
}

test('group shell remains editable after sharing to itself and another group', async ({
  page,
  request,
  testPrefix,
}) => {
  // This settings spec joins the existing Chromium CI project and uses its real
  // hybrid gateway/MySQL services. No image validation or model execution is needed.
  const api = createApiClient(request)
  expect((await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
  // The referenced group sorts before the source to exercise list deduplication.
  const sourceGroup = `z-${testPrefix}-source`
  const targetGroup = `a-${testPrefix}-target`
  const name = `${testPrefix}-shell`
  const personalName = `${testPrefix}-personal`
  const groups: string[] = []
  const sources: Array<{ name: string; namespace: string }> = []
  const publicationRequest = (sourceName: string, namespace: string, targetGroups: string[]) => ({
    resource_type: 'shell',
    source_name: sourceName,
    source_namespace: namespace,
    display_name: sourceName,
    status: 'archived',
    target_groups: targetGroups,
    allow_personal_install: false,
    allow_group_install: true,
  })

  try {
    for (const group of [sourceGroup, targetGroup]) {
      const created = await api.createGroup(
        DataBuilders.group({ name: group, visibility: 'private' })
      )
      expect(created.status, JSON.stringify(created.data)).toBe(201)
      groups.push(group)
    }
    for (const source of [
      { name, namespace: sourceGroup },
      { name: personalName, namespace: 'default' },
    ]) {
      const query = source.namespace === 'default' ? '' : `?group_name=${source.namespace}`
      const created = await api.post(`/api/shells${query}`, {
        name: source.name,
        displayName: source.name,
        baseShellRef: 'ClaudeCode',
        baseImage: 'python:3.11',
      })
      expect(created.status, JSON.stringify(created.data)).toBe(201)
      sources.push(source)
    }
    const personalPublication = await api.post<Publication>(
      PUBLICATION_PATH,
      publicationRequest(personalName, 'default', [targetGroup])
    )
    expect(personalPublication.status, JSON.stringify(personalPublication.data)).toBe(200)

    const rustLogRoot = resolve(__dirname, '../../../../logs/backend/rust')
    const apiLogPath = resolve(rustLogRoot, 'api.log')
    const fallbackLogPath = resolve(rustLogRoot, 'fallback.log')
    const apiLogStart = (await readFile(apiLogPath, 'utf8')).length
    const fallbackLogStart = (await readFile(fallbackLogPath, 'utf8')).length

    const original = await readShell(await openGroup(page, sourceGroup), name, sourceGroup)
    expect(original).toMatchObject({ isReference: false, listingId: null })
    await openEditor(page, name)
    await page.getByTestId('capability-scope-team').click()
    await page.getByTestId(`capability-scope-group-${sourceGroup}`).check()
    await page.getByTestId(`capability-scope-group-${targetGroup}`).check()
    const firstPublication = await saveEditor(page, name, sourceGroup)
    expect([...firstPublication.target_groups].sort()).toEqual([sourceGroup, targetGroup].sort())

    // A full navigation reads persisted state rather than retaining the mutation response.
    const shared = await readShell(await openGroup(page, sourceGroup), name, sourceGroup)
    expect(shared).toMatchObject({ isReference: false, listingId: null })
    const sourceCard = page.getByTestId(`shell-card-group-${name}`)
    await expect(sourceCard.getByRole('button', { name: EDIT_LABEL })).toBeVisible()
    await expect(sourceCard.getByTestId(`unbind-shell-${name}-button`)).toHaveCount(0)

    // Aggregating every group must retain the original identity even when a
    // reference was encountered first; personal resources participate in all scope.
    for (const scope of ['group', 'all']) {
      const listed = await api.get<{ data: Shell[] }>(`${LIST_PATH}?scope=${scope}`)
      expect(listed.status, JSON.stringify(listed.data)).toBe(200)
      const matches = listed.data!.data.filter(shell => shell.name === name)
      expect(matches).toHaveLength(1)
      expect(matches[0]).toMatchObject({
        namespace: sourceGroup,
        isReference: false,
        listingId: null,
      })
    }

    // Repeating the same effective scope preserves one editable source and one reference.
    await openEditor(page, name)
    expect((await saveEditor(page, name, sourceGroup)).id).toBe(firstPublication.id)
    expect(await readShell(await openGroup(page, sourceGroup), name, sourceGroup)).toMatchObject({
      isReference: false,
      listingId: null,
    })
    await expect(page.getByTestId(`shell-card-group-${name}`)).toHaveCount(1)

    const targetResponse = await openGroup(page, targetGroup)
    expect(await readShell(targetResponse, name, targetGroup)).toMatchObject({
      isReference: true,
      listingId: firstPublication.id,
    })
    const targetCard = page.getByTestId(`shell-card-group-${name}`)
    await expect(targetCard.getByTestId(`unbind-shell-${name}-button`)).toBeVisible()
    await expect(targetCard.getByRole('button', { name: EDIT_LABEL })).toHaveCount(0)
    const personalCard = page.getByTestId(`shell-card-group-${personalName}`)
    await expect(personalCard.getByTestId(`unbind-shell-${personalName}-button`)).toBeVisible()
    await expect(personalCard.getByRole('button', { name: EDIT_LABEL })).toHaveCount(0)
    expect(await readShell(targetResponse, personalName, targetGroup)).toMatchObject({
      isReference: true,
      listingId: personalPublication.data!.id,
    })

    // An actual source definition change must reach the referenced group's rendered card.
    await openGroup(page, sourceGroup)
    await openEditor(page, name)
    const updatedDisplayName = `${name} updated`
    await page.getByRole('dialog').locator('#displayName').fill(updatedDisplayName)
    expect((await saveEditor(page, name, sourceGroup)).id).toBe(firstPublication.id)
    expect(await readShell(await openGroup(page, targetGroup), name, targetGroup)).toMatchObject({
      displayName: updatedDisplayName,
      isReference: true,
      listingId: firstPublication.id,
    })

    await expect(page.getByTestId(`shell-card-group-${name}`)).toContainText(updatedDisplayName)
    await expect(
      page.getByTestId(`shell-card-group-${name}`).getByRole('button', { name: EDIT_LABEL })
    ).toHaveCount(0)

    // Runtime access logs prove this browser flow executed the native Rust list handler.
    // The hybrid gateway writes only Python-forwarded requests to fallback.log.
    const sourceListTarget = `${LIST_PATH}?${new URLSearchParams({
      scope: 'group',
      group_name: sourceGroup,
    })}`
    await expect
      .poll(async () => (await readFile(apiLogPath, 'utf8')).slice(apiLogStart))
      .toContain(`GET ${sourceListTarget} 200`)
    expect((await readFile(fallbackLogPath, 'utf8')).slice(fallbackLogStart)).not.toContain(
      sourceListTarget
    )
  } finally {
    // Clear sharing first, then delete each uniquely named source before deleting groups.
    for (const source of sources.reverse()) {
      const unpublished = await api.post(
        PUBLICATION_PATH,
        publicationRequest(source.name, source.namespace, [])
      )
      expect.soft(unpublished.status, JSON.stringify(unpublished.data)).toBe(200)
      const deleted = await api.delete(`/api/shells/${source.name}`)
      expect.soft(deleted.status, JSON.stringify(deleted.data)).toBe(200)
    }
    for (const group of groups.reverse()) {
      const deleted = await api.deleteGroup(group)
      expect.soft(deleted.status, JSON.stringify(deleted.data)).toBe(204)
    }
  }
})
