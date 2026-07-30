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
    allow_personal_install: boolean
    allow_group_install: boolean
  }>
}

async function clickListingAction(page: Page, listingId: number) {
  await page.getByTestId(`resource-listing-card-${listingId}`).hover()
  await page.getByTestId(`install-resource-${listingId}-button`).click()
}

test.describe('Capability Center', () => {
  test('shows marketplace views and system capabilities from the real backend', async ({
    page,
  }) => {
    await page.goto('/resource-library?tab=discover&type=agent')

    await expect(page.getByTestId('resource-library-discover-tab')).toBeVisible()
    await expect(page.getByTestId('resource-library-mine-tab')).toBeVisible()
    await expect(page.getByTestId('resource-library-team-tab')).toBeVisible()
    await expect(page.getByTestId('resource-library-system-tab')).toHaveCount(0)
    await expect(page.getByTestId('resource-library-published-tab')).toBeVisible()
    await expect(page.getByTestId('discover-resources')).toBeVisible()
    await expect(page.locator('[data-testid^="resource-listing-card-"]').first()).toBeVisible()

    await page.getByTestId('resource-library-mine-tab').click()
    await expect(page.getByTestId('my-resources')).toBeVisible()

    await page.getByTestId('resource-library-team-tab').click()
    await expect(
      page.getByTestId('team-capabilities').or(page.getByTestId('team-capabilities-empty'))
    ).toBeVisible()

    await page.getByTestId('resource-library-published-tab').click()
    await expect(
      page.getByTestId('published-resources').or(page.getByTestId('published-resources-empty'))
    ).toBeVisible()
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
    await expect(page).toHaveURL(`/chat?teamId=${listing!.id}`)
    expect(installRequested).toBe(false)
  })

  test('my capabilities shows one resource manager at a time', async ({ page }) => {
    await page.goto('/resource-library?tab=mine&type=agent')

    await expect(page.getByTestId('resource-type-agent-filter')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.getByTestId('resource-type-all-filter')).toHaveCount(0)
    await expect(page.getByTestId('team-list-items')).toBeVisible()
    await expect(page.getByTestId('managed-resource-type-tabs')).toHaveCount(0)
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
      await page.goto('/resource-library?tab=team&type=skill')
      await page.getByTestId('resource-library-team-filter').click()
      await page.getByTestId(`resource-library-team-${group.name}`).click()
      await page.keyboard.press('Escape')
      const listingsResponse = page.waitForResponse(
        response =>
          response.url().includes('/api/resource-library/listings') &&
          response.request().method() === 'GET'
      )
      await page.getByTestId('team-capability-add-button').click()
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

      await page.getByTestId('team-capability-current-button').click()
      await expect(page.getByTestId('group-installed-skills')).toBeVisible()
    } finally {
      await apiClient.deleteGroup(group.name)
    }
  })
})
