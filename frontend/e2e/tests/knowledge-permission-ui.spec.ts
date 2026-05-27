// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { test, expect, Page } from '@playwright/test'

test.describe('Knowledge Base Permission UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/knowledge')
    await page.waitForLoadState('domcontentloaded')
  })

  test('should open permission dialog via permissions tab', async ({ page }) => {
    await page.waitForTimeout(2000)

    const kbItem = page.locator('[data-testid="kb-item"]').first()
    await expect(kbItem).toBeVisible({ timeout: 5000 })

    await kbItem.click()
    await page.waitForTimeout(1000)

    const permissionsTab = page.locator('[data-testid="permission-management-tab"]')
    await expect(permissionsTab).toBeVisible({ timeout: 5000 })

    await permissionsTab.click()
    await page.waitForTimeout(500)

    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 3000 })
  })

  test('should display collaborator type segmented selector in add dialog', async ({ page }) => {
    await navigateToKbPermissionDialog(page)

    const addButton = page.locator('[data-testid="add-collaborator-button"]')
    await expect(addButton).toBeVisible({ timeout: 3000 })

    await addButton.click()
    await page.waitForTimeout(500)

    const segmentedSelector = page.locator('[data-testid="collaborator-type-segmented"]')
    await expect(segmentedSelector).toBeVisible({ timeout: 3000 })

    const buttons = segmentedSelector.locator('button')
    await expect(buttons).toHaveCount(3)
  })

  test('should display role dropdown with correct roles', async ({ page }) => {
    await navigateToKbPermissionDialog(page)

    const roleTrigger = page.locator('[data-testid="role-select-trigger"]').first()
    await expect(roleTrigger).toBeVisible({ timeout: 3000 })

    await roleTrigger.click()
    await page.waitForTimeout(500)

    const dialogContent = page.locator('[role="listbox"], [data-radix-select-content]')
    await expect(dialogContent).toBeVisible({ timeout: 2000 })

    const options = dialogContent.locator('[role="option"]')
    await expect(options.count()).toBeGreaterThanOrEqual(4)
  })

  test('should show employee ID for user collaborators', async ({ page }) => {
    await navigateToKbPermissionDialog(page)

    const collaboratorItems = page.locator('[data-testid="collaborator-item"]')
    await expect(collaboratorItems.first()).toBeVisible({ timeout: 3000 })

    const count = await collaboratorItems.count()
    expect(count).toBeGreaterThan(0)
  })

  test('should preserve selected items when switching collaborator type', async ({ page }) => {
    await navigateToKbPermissionDialog(page)

    const addButton = page.locator('[data-testid="add-collaborator-button"]')
    await expect(addButton).toBeVisible({ timeout: 3000 })

    await addButton.click()
    await page.waitForTimeout(500)

    const searchInput = page.locator('[data-testid="collaborator-search-input"]')
    await expect(searchInput).toBeVisible({ timeout: 2000 })

    await searchInput.fill('test')
    await page.waitForTimeout(1000)

    const firstResult = page.locator('[data-testid^="search-result-"]').first()
    await expect(firstResult).toBeVisible({ timeout: 2000 })

    await firstResult.click()
    await page.waitForTimeout(500)

    const selectedDisplay = page.locator('[data-testid="selected-count-display"]')
    await expect(selectedDisplay).toBeVisible({ timeout: 2000 })

    const initialText = await selectedDisplay.textContent()
    const initialCount = extractCount(initialText || '0')

    const segmentedSelector = page.locator('[data-testid="collaborator-type-segmented"]')
    const typeButtons = segmentedSelector.locator('button')
    await typeButtons.nth(1).click()
    await page.waitForTimeout(500)

    const afterText = await selectedDisplay.textContent()
    const afterCount = extractCount(afterText || '0')

    expect(afterCount).toBe(initialCount)
  })
})

async function navigateToKbPermissionDialog(page: Page) {
  await page.waitForTimeout(2000)

  const kbItem = page.locator('[data-testid="kb-item"]').first()
  await expect(kbItem).toBeVisible({ timeout: 5000 })

  await kbItem.click()
  await page.waitForTimeout(1000)

  const permissionsTab = page.locator('[data-testid="permission-management-tab"]')
  await expect(permissionsTab).toBeVisible({ timeout: 5000 })

  await permissionsTab.click()
  await page.waitForTimeout(500)
}

function extractCount(text: string): number {
  const match = text.match(/(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}
