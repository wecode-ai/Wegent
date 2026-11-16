import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/test-fixtures'

const SETTINGS_INTEGRATIONS_PATH = '/settings?tab=integrations'
const INTEGRATIONS_READY_TIMEOUT = 30000

async function openIntegrationsPage(page: Page) {
  await page.goto(SETTINGS_INTEGRATIONS_PATH)
  await page.waitForLoadState('domcontentloaded')
  await expect(page).toHaveURL(/\/settings/)
  await expect(page.getByTestId('settings-integrations-page')).toBeVisible({
    timeout: INTEGRATIONS_READY_TIMEOUT,
  })
  await expect(page.getByTestId('git-tokens-section')).toBeVisible()
  await expect(page.getByTestId('add-git-token-button')).toBeVisible({
    timeout: INTEGRATIONS_READY_TIMEOUT,
  })
}

test.describe('Settings - Git Integration', () => {
  test.beforeEach(async ({ page }) => {
    await openIntegrationsPage(page)
  })

  test('should open add token dialog', async ({ page }) => {
    const addTokenButton = page.getByTestId('add-git-token-button')

    await expect(addTokenButton).toBeVisible({ timeout: INTEGRATIONS_READY_TIMEOUT })

    await addTokenButton.click()

    await expect(page.getByTestId('git-token-dialog-content')).toBeVisible({
      timeout: INTEGRATIONS_READY_TIMEOUT,
    })
    await expect(page.getByRole('heading', { name: /Add Git Token|新增 Git 令牌/ })).toBeVisible()
  })
})
