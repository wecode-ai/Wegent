// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page } from '@playwright/test'

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

async function clickListingAction(page: Page, listingId: number) {
  await page.getByTestId(`resource-listing-card-${listingId}`).hover()
  await page.getByTestId(`install-resource-${listingId}-button`).click()
}

test.describe('Capability Center', () => {
  test('switches between focused discovery and My Capabilities', async ({ page }) => {
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

  test('uses a system agent directly without creating a personal install', async ({ page }) => {
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
    await expect(page.getByTestId('resource-library-source-personal-button')).toBeVisible()
    await expect(page.getByTestId('resource-library-source-group-button')).toBeVisible()
    await expect(page.getByTestId('resource-library-source-installed-button')).toBeVisible()

    await page.getByTestId('resource-library-source-personal-button').click()
    await expect(page).toHaveURL(url => url.searchParams.get('source') === 'personal')
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
      expect((await installResponse).ok()).toBe(true)
      await expect(page).toHaveURL(/\/resource-library/)

      await page.getByTestId('resource-library-team-current-button').click()
      await expect(page).toHaveURL(url => url.searchParams.get('teamAction') === null)
      await expect(page.getByTestId('installed-resources-grid')).toBeVisible()
      await expect(page.getByTestId(`resource-listing-card-${listing!.id}`)).toBeVisible()
    } finally {
      await apiClient.deleteGroup(group.name)
    }
  })
})
