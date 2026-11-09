// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { ADMIN_USER } from '../config/test-users'
import { DataBuilders } from '../fixtures/data-builders'
import { createApiClient } from '../utils/api-client'

interface CapabilityListingResponse {
  items: Array<{
    id: number
    resource_type: 'agent' | 'skill'
    publisher_user_id: number
    bind_modes: string[]
    allow_personal_install: boolean
    allow_group_install: boolean
  }>
}

interface MarketplaceTagsResponse {
  items: Array<{
    id: string
    enabled: boolean
  }>
}

interface McpProvidersResponse {
  providers: Array<{ key: string }>
}

interface McpServerListResponse {
  success: boolean
  message: string
  servers: Array<{
    id: string
    name: string
    description?: string
    provider: string
    tags?: string[] | null
    is_active: boolean
  }>
}

interface AdminMarketplaceResourceResponse {
  total: number
  items: Array<{
    id: number
    name: string
    is_system: boolean
  }>
}

async function ensureRecommendedSystemAgent(request: APIRequestContext) {
  const apiClient = createApiClient(request)
  expect((await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)).status).toBe(200)
  const pageSize = 200
  let page = 1
  let agent: AdminMarketplaceResourceResponse['items'][number] | undefined
  let total = 0
  do {
    const response = await apiClient.get<AdminMarketplaceResourceResponse>(
      `/api/admin/marketplace-resources?resource_type=agent&page=${page}&limit=${pageSize}`
    )
    expect(response.status).toBe(200)
    total = response.data?.total ?? 0
    agent = response.data?.items.find(item => item.is_system && item.name === 'wegent-chat')
    page += 1
  } while (!agent && (page - 1) * pageSize < total)
  expect(agent, 'The Wegent Chat system agent must exist').toBeTruthy()
  expect(
    (
      await apiClient.put(`/api/admin/marketplace-resources/${agent!.id}`, {
        recommendation_score: 80,
      })
    ).status
  ).toBe(200)
}

async function clickListingAction(page: Page, listingId: number) {
  await page.getByTestId(`resource-listing-card-${listingId}`).hover()
  await page.getByTestId(`install-resource-${listingId}-button`).click()
}

/** Verifies the real catalog response and its included and excluded cards. */
async function expectMcpKeywordResults(
  page: Page,
  keyword: string,
  includedId: string,
  excludedId: string,
  action: () => Promise<unknown>
) {
  const serversPromise = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      /\/api\/mcp-providers\/e2e_catalog\/servers$/.test(new URL(response.url()).pathname)
  )
  await action()
  const response = await serversPromise
  expect(response.ok()).toBe(true)
  const serverList = (await response.json()) as McpServerListResponse
  expect(serverList.success, serverList.message).toBe(true)
  expect(serverList.servers.some(server => server.id === includedId)).toBe(true)
  expect(serverList.servers.some(server => server.id === excludedId)).toBe(true)
  await expect(page.getByTestId(`mcp-marketplace-card-${includedId}`)).toBeVisible()
  await expect(page.getByTestId(`mcp-marketplace-card-${excludedId}`)).toHaveCount(0)
  await expect(page.getByTestId('mcp-marketplace-search-input')).toHaveValue(keyword)
}

/** Verifies the real listings response and its included and excluded skill cards. */
async function expectSkillKeywordResults(
  page: Page,
  keyword: string,
  includedId: number,
  excludedId: number,
  action: () => Promise<unknown>
) {
  const resultsPromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return (
      url.pathname.endsWith('/api/resource-library/listings') &&
      url.searchParams.get('resource_type') === 'skill' &&
      url.searchParams.get('keyword') === keyword &&
      !url.searchParams.has('featured_only') &&
      response.request().method() === 'GET'
    )
  })
  await action()
  const response = await resultsPromise
  expect(response.ok()).toBe(true)
  const results = (await response.json()) as CapabilityListingResponse
  expect(results.items.some(item => item.id === includedId)).toBe(true)
  expect(results.items.some(item => item.id === excludedId)).toBe(false)
  await expect(page.getByTestId(`resource-listing-card-${includedId}`)).toBeVisible()
  await expect(page.getByTestId(`resource-listing-card-${excludedId}`)).toHaveCount(0)
  await expect(page.getByTestId('resource-library-header-search-input')).toHaveValue(keyword)
  await expect(page).toHaveURL(
    url => url.searchParams.get('keyword') === keyword && !url.searchParams.has('marketplace')
  )
}

test.describe('Capability Center', () => {
  test('switches between focused discovery and My Capabilities', async ({ page, request }) => {
    await ensureRecommendedSystemAgent(request)
    await page.goto('/resource-library?type=agent')

    await expect(page.getByTestId('resource-library-view-toggle')).toBeVisible()
    await expect(page.getByTestId('resource-type-agent-filter')).toBeVisible()
    await expect(page.getByTestId('resource-type-skill-filter')).toBeVisible()
    await expect(page.getByTestId('resource-type-model-filter')).toHaveCount(0)
    await expect(page.getByTestId('resource-library-source-select')).toHaveCount(0)
    await expect(page.getByTestId('discover-resources')).toBeVisible()
    await expect(page.locator('[data-testid^="resource-listing-card-"]').first()).toBeVisible()

    await page.getByTestId('resource-library-view-toggle').click()
    await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'mine')
    await expect(page.getByTestId('my-resources')).toBeVisible()
    await expect(page.getByTestId('resource-library-source-segments')).toBeVisible()

    await page.getByTestId('resource-library-view-toggle').click()
    await expect(page).toHaveURL(url => url.searchParams.get('tab') === null)
    await expect(page.getByTestId('discover-resources')).toBeVisible()
  })

  test('new capability opens the selected existing creator directly', async ({ page }) => {
    await page.goto('/resource-library')
    await page.getByTestId('new-capability-button').click()

    await expect(page.getByTestId('new-capability-menu')).toBeVisible()
    await page.getByTestId('new-capability-type-agent').click()
    await expect(page.getByTestId('team-edit-dialog')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByTestId('new-capability-button').click()
    await page.getByTestId('new-capability-type-skill').click()
    await expect(page.getByTestId('skill-upload-dialog')).toBeVisible()
  })

  test('opens the MCP marketplace pre-filtered from a deep link', async ({ page }) => {
    await expectMcpKeywordResults(
      page,
      '商品数据对比',
      '@e2e/product-comparison',
      '@e2e/document-search',
      () => page.goto(`/resource-library?type=mcp&keyword=${encodeURIComponent('商品数据对比')}`)
    )

    await expect(page.getByTestId('resource-type-mcp-filter')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.getByTestId('mcp-marketplace')).toBeVisible()

    await expectMcpKeywordResults(
      page,
      '商品数据对比',
      '@e2e/product-comparison',
      '@e2e/document-search',
      () => page.reload()
    )
    await expect(page).toHaveURL(
      url =>
        url.searchParams.get('type') === 'mcp' && url.searchParams.get('keyword') === '商品数据对比'
    )
  })

  test('clears an unknown marketplace deep link and resumes keyword search', async ({ page }) => {
    await page.goto('/resource-library?type=skill&marketplace=missing-provider&keyword=文档')

    await expect(page).toHaveURL(url => url.searchParams.get('marketplace') === null)
    await expect(page.getByTestId('resource-library-header-search-input')).toHaveValue('文档')
    await expect(page.getByTestId('marketplace-toolbar')).toBeVisible()
    await expect(page.getByTestId('skill-marketplace-search')).toHaveCount(0)
  })

  test('searches real skills after unknown-market cleanup and restores results on reload', async ({
    page,
    request,
  }) => {
    const apiClient = createApiClient(request)
    expect((await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)).status).toBe(200)
    const response = await apiClient.get<AdminMarketplaceResourceResponse>(
      '/api/admin/marketplace-resources?resource_type=skill&page=1&limit=200'
    )
    expect(response.status).toBe(200)
    const promptSkill = response.data?.items.find(
      item => item.is_system && item.name === 'conversation_to_prompt'
    )
    const sandboxSkill = response.data?.items.find(
      item => item.is_system && item.name === 'sandbox'
    )
    expect(promptSkill, 'The conversation_to_prompt system skill must exist').toBeTruthy()
    expect(sandboxSkill, 'The sandbox system skill must exist').toBeTruthy()
    const query = new URLSearchParams({
      type: 'skill',
      marketplace: 'missing-provider',
      keyword: promptSkill!.name,
    })

    await expectSkillKeywordResults(
      page,
      promptSkill!.name,
      promptSkill!.id,
      sandboxSkill!.id,
      () => page.goto(`/resource-library?${query}`)
    )
    await expectSkillKeywordResults(
      page,
      promptSkill!.name,
      promptSkill!.id,
      sandboxSkill!.id,
      () => page.reload()
    )

    await page.getByTestId('resource-library-header-search-input').fill(sandboxSkill!.name)
    await expectSkillKeywordResults(
      page,
      sandboxSkill!.name,
      sandboxSkill!.id,
      promptSkill!.id,
      () => page.getByTestId('resource-library-header-search-input').press('Enter')
    )
    await expectSkillKeywordResults(
      page,
      sandboxSkill!.name,
      sandboxSkill!.id,
      promptSkill!.id,
      () => page.reload()
    )
  })

  test('clears the MCP URL keyword when switching real registered providers', async ({ page }) => {
    const providersPromise = page.waitForResponse(
      response =>
        new URL(response.url()).pathname.endsWith('/api/mcp-providers') &&
        response.request().method() === 'GET'
    )
    await page.goto('/resource-library?type=mcp&keyword=商品数据对比')
    const response = await providersPromise
    expect(response.ok()).toBe(true)
    const { providers } = (await response.json()) as McpProvidersResponse
    expect(
      providers.length,
      'At least two built-in MCP providers must be registered'
    ).toBeGreaterThan(1)
    await expect(page.getByTestId('mcp-marketplace-search-input')).toHaveValue('商品数据对比')
    await page.getByTestId(`mcp-marketplace-provider-${providers[1].key}`).click()

    await expect(page.getByTestId(`mcp-marketplace-provider-${providers[1].key}`)).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(page.getByTestId('mcp-marketplace-search-input')).toHaveValue('')
    await expect(page).toHaveURL(
      url => url.searchParams.get('type') === 'mcp' && !url.searchParams.has('keyword')
    )
    await page.reload()
    await expect(page.getByTestId('mcp-marketplace-search-input')).toHaveValue('')
  })

  test('filters discovery by a configured marketplace tag and restores it from the URL', async ({
    page,
  }) => {
    const tagsResponsePromise = page.waitForResponse(
      response =>
        response.url().endsWith('/api/resource-library/tags') &&
        response.request().method() === 'GET'
    )
    await page.goto('/resource-library?type=skill')
    const tags = (await (await tagsResponsePromise).json()) as MarketplaceTagsResponse
    const tag = tags.items.find(item => item.enabled)
    expect(tag, 'At least one enabled marketplace tag must exist').toBeTruthy()

    const filteredListingsPromise = page.waitForResponse(response => {
      const url = new URL(response.url())
      return (
        url.pathname.endsWith('/api/resource-library/listings') &&
        url.searchParams.get('resource_type') === 'skill' &&
        url.searchParams.get('tags') === tag!.id &&
        response.request().method() === 'GET'
      )
    })
    await page.getByTestId(`marketplace-tag-filter-${tag!.id}`).click()

    expect((await filteredListingsPromise).ok()).toBe(true)
    await expect(page).toHaveURL(url => url.searchParams.get('tag') === tag!.id)
    await expect(page.getByTestId(`marketplace-tag-filter-${tag!.id}`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await page.reload()
    await expect(page.getByTestId(`marketplace-tag-filter-${tag!.id}`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  test('uses a system agent directly without creating a personal install', async ({
    page,
    request,
  }) => {
    await ensureRecommendedSystemAgent(request)
    const listingsResponse = page.waitForResponse(
      response =>
        response.url().includes('/api/resource-library/listings') &&
        response.request().method() === 'GET'
    )
    await page.goto('/resource-library?tab=discover&type=agent')
    const listings = (await (await listingsResponse).json()) as CapabilityListingResponse
    const listing = listings.items.find(
      item =>
        item.resource_type === 'agent' &&
        item.publisher_user_id === 0 &&
        item.allow_personal_install
    )
    expect(listing, 'A directly usable system agent must exist').toBeTruthy()

    let installRequested = false
    page.on('request', request => {
      if (
        request.url().endsWith(`/api/resource-library/listings/${listing!.id}/install`) &&
        request.method() === 'POST'
      ) {
        installRequested = true
      }
    })
    await clickListingAction(page, listing!.id)
    if (listing!.bind_modes.includes('code')) {
      await expect(page).toHaveURL(`/chat?agent=code&teamId=${listing!.id}`)
    } else {
      await expect(page).toHaveURL(`/chat?teamId=${listing!.id}`)
    }
    expect(installRequested).toBe(false)
  })

  test('My Capabilities exposes five resource types and contextual sources', async ({ page }) => {
    await page.goto('/resource-library?tab=mine&type=agent')

    const managedTypes = ['agent', 'skill', 'model', 'shell', 'retriever']
    for (const resourceType of managedTypes) {
      await expect(page.getByTestId(`resource-type-${resourceType}-filter`)).toBeVisible()
    }

    await expect(page.getByTestId('resource-type-connector-filter')).toHaveCount(0)
    await expect(page.getByTestId('resource-type-all-filter')).toHaveCount(0)
    await expect(page.getByTestId('my-resources')).toBeVisible()
    await expect(page.getByTestId('managed-resource-type-tabs')).toHaveCount(0)

    await expect(page.getByTestId('resource-library-source-all-button')).toBeVisible()
    await expect(page.getByTestId('resource-library-source-mine-button')).toBeVisible()
    await expect(page.getByTestId('resource-library-source-group-button')).toBeVisible()
    await expect(page.getByTestId('resource-library-source-installed-button')).toBeVisible()

    await page.getByTestId('resource-library-source-mine-button').click()
    await expect(page).toHaveURL(url => url.searchParams.get('source') === 'mine')
    await expect(page.getByTestId('my-resources')).toBeVisible()

    for (const resourceType of ['model', 'shell', 'retriever']) {
      await page.getByTestId(`resource-type-${resourceType}-filter`).click()
      await expect(page).toHaveURL(url => url.searchParams.get('type') === resourceType)
      await expect(page.getByTestId(`resource-type-${resourceType}-filter`)).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    }

    await expect(page.getByTestId('resource-library-source-installed-button')).toHaveCount(0)
  })

  test('add installs a skill into the selected group without opening chat', async ({
    page,
    request,
  }) => {
    const apiClient = createApiClient(request)
    const loginResponse = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    expect(loginResponse.status).toBe(200)
    const group = DataBuilders.group()
    expect((await apiClient.createGroup(group)).status).toBe(201)

    try {
      await page.goto('/resource-library?tab=mine&type=skill')
      await page.getByTestId('resource-library-source-group-button').click()
      await expect(page).toHaveURL(url => url.searchParams.get('source') === 'group')

      await page.getByTestId('resource-library-team-select').click()
      await page.getByTestId(`resource-library-team-${group.name}-option`).click()
      await expect(page).toHaveURL(url => url.searchParams.get('group') === group.name)

      const listingsResponse = page.waitForResponse(response => {
        const url = new URL(response.url())
        return (
          url.pathname.endsWith('/api/resource-library/listings') &&
          url.searchParams.get('resource_type') === 'skill' &&
          url.searchParams.get('target_namespace') === group.name &&
          response.request().method() === 'GET'
        )
      })
      await page.getByTestId('resource-library-team-add-button').click()
      await expect(page).toHaveURL(url => url.searchParams.get('teamAction') === 'add')
      await expect(page.getByTestId('discover-resources')).toBeVisible()
      const listings = (await (await listingsResponse).json()) as CapabilityListingResponse
      const listing = listings.items.find(
        item => item.resource_type === 'skill' && item.allow_group_install
      )
      expect(listing, 'A group-installable system skill must exist').toBeTruthy()

      const installResponse = page.waitForResponse(
        response =>
          response.url().endsWith(`/api/resource-library/listings/${listing!.id}/install`) &&
          response.request().method() === 'POST'
      )
      await clickListingAction(page, listing!.id)
      const installed = await installResponse
      expect(installed.ok()).toBe(true)
      const installation = await installed.json()
      expect(installation.installed_reference.skill_id).toBeGreaterThan(0)
      await expect(page).toHaveURL(/\/resource-library/)

      await page.getByTestId('resource-library-team-current-button').click()
      await expect(page).toHaveURL(url => url.searchParams.get('teamAction') === null)
      await expect(page.getByTestId('team-skill-resources')).toBeVisible()
      await expect(
        page.getByTestId(`skill-library-item-${installation.installed_reference.skill_id}`)
      ).toBeVisible()
    } finally {
      await apiClient.deleteGroup(group.name)
    }
  })
})
