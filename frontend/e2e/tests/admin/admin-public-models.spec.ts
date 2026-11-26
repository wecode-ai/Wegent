// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import { ADMIN_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'

const PAGE_SIZE = 50

interface SeededModel {
  id: number
  name: string
  displayName: string
}

test.describe('Admin - Public Model search and pagination', () => {
  let seededModels: SeededModel[] = []

  test.afterEach(async ({ request }) => {
    if (seededModels.length === 0) return
    const models = seededModels
    seededModels = []
    const api = createApiClient(request)
    try {
      await api.login(ADMIN_USER.username, ADMIN_USER.password)
    } catch {
      return
    }
    for (let index = 0; index < models.length; index += 10) {
      await Promise.all(
        models
          .slice(index, index + 10)
          .map(model => api.adminDeletePublicModel(model.id).catch(() => undefined))
      )
    }
  })

  test('searches, paginates, restores state, clears search, and clamps after deleting the last page item', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const unique = `e2e-pm-${randomUUID()}`
    const api = createApiClient(request)
    expect((await api.login(ADMIN_USER.username, ADMIN_USER.password)).status).toBe(200)

    // Seed one full page plus one item so the filtered result has a second page.
    for (let index = 0; index < PAGE_SIZE + 1; index += 1) {
      const suffix = String(index).padStart(3, '0')
      const name = `${unique}-${suffix}`
      const displayName = `E2E Model ${unique} ${suffix}`
      const response = await api.adminCreatePublicModel({
        name,
        json: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name, displayName, namespace: 'default' },
          spec: {
            modelConfig: {
              provider: 'openai',
              modelId: 'gpt-4',
              apiKey: 'test-key',
              baseUrl: 'https://api.openai.com/v1',
            },
          },
        },
      })
      expect([200, 201]).toContain(response.status)
      seededModels.push({
        id: (response.data as { id: number }).id,
        name,
        displayName,
      })
    }

    await page.goto('/admin?tab=public-models')
    const searchInput = page.getByTestId('public-model-search-input')
    await expect(searchInput).toBeVisible()
    const searchUrl = `search=${encodeURIComponent(unique)}`

    await test.step('searches and shows only matching models', async () => {
      const responsePromise = page.waitForResponse(
        response =>
          response.url().includes('/api/admin/public-models?') &&
          response.url().includes(searchUrl) &&
          response.request().method() === 'GET'
      )
      await searchInput.fill(unique)
      expect((await responsePromise).status()).toBe(200)
      await expect(page.getByTestId('public-model-card')).toHaveCount(PAGE_SIZE)
      await expect(page.getByText(seededModels[0].displayName)).toBeVisible()
      await expect(page.getByText(seededModels[PAGE_SIZE].displayName)).toHaveCount(0)
      await expect(page).toHaveURL(new RegExp(searchUrl))
    })

    await test.step('paginates to the second page', async () => {
      const responsePromise = page.waitForResponse(
        response =>
          response.url().includes('/api/admin/public-models?') &&
          response.url().includes(searchUrl) &&
          response.url().includes('page=2') &&
          response.request().method() === 'GET'
      )
      await page.getByTestId('pagination-page-2').click()
      expect((await responsePromise).status()).toBe(200)
      await expect(page.getByTestId('public-model-card')).toHaveCount(1)
      await expect(page.getByText(seededModels[PAGE_SIZE].displayName)).toBeVisible()
      await expect(page).toHaveURL(/page=2/)
    })

    await test.step('restores the search and page after refresh', async () => {
      await page.reload()
      await expect(searchInput).toHaveValue(unique)
      await expect(page.getByTestId('public-model-card')).toHaveCount(1)
      await expect(page.getByText(seededModels[PAGE_SIZE].displayName)).toBeVisible()
      await expect(page).toHaveURL(/page=2/)
    })

    await test.step('clears the search and returns to the first page', async () => {
      const responsePromise = page.waitForResponse(
        response =>
          response.url().includes('/api/admin/public-models?') &&
          !response.url().includes('search=') &&
          response.request().method() === 'GET'
      )
      await page.getByTestId('public-model-search-clear').click()
      expect((await responsePromise).status()).toBe(200)
      await expect(searchInput).toHaveValue('')
      await expect(page).not.toHaveURL(/search=/)
      await expect(page).not.toHaveURL(/page=2/)
      await expect(page.getByTestId('public-model-card').first()).toBeVisible()
    })

    await test.step('deletes the last item on the last page and clamps to page 1', async () => {
      const searchResponse = page.waitForResponse(
        response =>
          response.url().includes('/api/admin/public-models?') &&
          response.url().includes(searchUrl) &&
          response.request().method() === 'GET'
      )
      await searchInput.fill(unique)
      expect((await searchResponse).status()).toBe(200)

      const pageTwoResponse = page.waitForResponse(
        response =>
          response.url().includes('/api/admin/public-models?') &&
          response.url().includes(searchUrl) &&
          response.url().includes('page=2') &&
          response.request().method() === 'GET'
      )
      await page.getByTestId('pagination-page-2').click()
      expect((await pageTwoResponse).status()).toBe(200)

      const lastModel = seededModels[PAGE_SIZE]
      await page.getByTestId(`delete-public-model-${lastModel.id}`).click()
      const deleteResponse = page.waitForResponse(
        response =>
          response.url().endsWith(`/api/admin/public-models/${lastModel.id}`) &&
          response.request().method() === 'DELETE'
      )
      await page.getByTestId('confirm-delete-public-model').click()
      expect((await deleteResponse).status()).toBe(204)

      await expect(page.getByTestId('public-model-card')).toHaveCount(PAGE_SIZE)
      await expect(page.getByText(lastModel.displayName)).toHaveCount(0)
      await expect(page.getByTestId('pagination-page-2')).toHaveCount(0)
      await expect(page).not.toHaveURL(/page=2/)
    })
  })
})
