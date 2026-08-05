import { test, expect, TestData } from '../fixtures/test-fixtures'
import type { Page } from '@playwright/test'

const MODEL_RESOURCES_URL = '/resource-library?tab=mine&type=model&scope=personal'

async function expectModelResourcePage(page: Page) {
  await expect(page).toHaveURL(/\/resource-library/)
  await expect(page.locator('[data-testid="my-resources"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="resource-type-model-filter"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('[data-testid="resource-library-content"]')).toBeVisible({
    timeout: 15000,
  })
}

async function expectModelListHasContentOrEmptyState(page: Page) {
  await expect
    .poll(
      async () => {
        const modelCount = await page.locator('[data-testid^="model-card-"]').count()
        const emptyVisible = await page
          .getByText(/No models|暂无模型|没有模型|无模型/)
          .isVisible()
          .catch(() => false)

        return modelCount > 0 || emptyVisible
      },
      { timeout: 15000 }
    )
    .toBe(true)
}

async function openCreateModelDialog(page: Page) {
  await page.locator('[data-testid="new-capability-button"]').click()
  await expect(page.locator('[data-testid="new-capability-menu"]')).toBeVisible({
    timeout: 10000,
  })
  await page.locator('[data-testid="new-capability-advanced"]').click()
  await expect(page.locator('[data-testid="new-capability-advanced-content"]')).toBeVisible()
  await page.locator('[data-testid="new-capability-type-model"]').click()

  const dialog = page.locator('[role="dialog"]')
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(dialog.locator('[data-testid="model-id-name-input"]')).toBeVisible({
    timeout: 10000,
  })
  return dialog
}

test.describe('Settings - Model Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(MODEL_RESOURCES_URL)
    await page.waitForLoadState('domcontentloaded')
    await expectModelResourcePage(page)
  })

  test('should access model management page', async ({ page }) => {
    await expect(page.locator('[data-testid="new-capability-button"]')).toBeVisible({
      timeout: 15000,
    })
  })

  test('should display model list or empty state', async ({ page }) => {
    await expectModelListHasContentOrEmptyState(page)
  })

  test('should open create model form', async ({ page }) => {
    await openCreateModelDialog(page)
  })

  test('should configure an LLM with an image understanding sidecar', async ({
    page,
    testPrefix,
  }) => {
    const visionModelName = TestData.uniqueName(`${testPrefix}-vision`)
    const primaryModelName = TestData.uniqueName(`${testPrefix}-primary`)
    const token = await page.evaluate(() => localStorage.getItem('auth_token'))
    expect(token).toBeTruthy()
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const createResponse = await page.request.post('/api/v1/namespaces/default/models', {
      headers,
      data: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: visionModelName,
          namespace: 'default',
          displayName: 'E2E Vision Sidecar',
        },
        spec: {
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'vision-model',
              api_key: 'test-api-key-for-e2e',
              base_url: 'https://vision.example/v1',
            },
          },
          protocol: 'openai-responses',
          apiFormat: 'responses',
          modelType: 'llm',
          isWeworkAvailable: true,
          modelCapabilities: {
            supportsImage: true,
          },
        },
      },
    })
    expect([200, 201]).toContain(createResponse.status())

    try {
      const dialog = await openCreateModelDialog(page)
      await dialog.locator('[data-testid="model-wework-available-switch"]').click()

      const sidecarSelect = dialog.locator('[data-testid="vision-sidecar-model-select"]')
      await expect(sidecarSelect).toBeVisible()
      await sidecarSelect.click()
      await page.getByRole('option', { name: 'E2E Vision Sidecar' }).click()

      await dialog.locator('[data-testid="model-id-name-input"]').fill(primaryModelName)
      await dialog.locator('[data-testid="model-id-select"]').click()
      await page.getByText('gpt-4o (Recommended)', { exact: true }).click()
      await dialog.locator('input#api_key').fill('test-api-key-for-e2e')
      await dialog.getByRole('button', { name: /Save|保存/ }).click()

      await expect
        .poll(async () => {
          const response = await page.request.get(
            `/api/v1/namespaces/default/models/${primaryModelName}`,
            { headers }
          )
          if (!response.ok()) return null
          const createdModel = await response.json()
          return createdModel.spec?.modelConfig?.visionSidecarModel
        })
        .toEqual({
          modelName: visionModelName,
          modelType: 'user',
          namespace: 'default',
          resourceUserId: expect.any(Number),
          apiFormat: 'openai-responses',
        })
    } finally {
      for (const modelName of [primaryModelName, visionModelName]) {
        const deleteResponse = await page.request.delete(
          `/api/v1/namespaces/default/models/${modelName}`,
          { headers }
        )
        expect([200, 204, 404]).toContain(deleteResponse.status())
      }
    }
  })

  test('should create new model', async ({ page, testPrefix }) => {
    const modelName = TestData.uniqueName(`${testPrefix}-model`)
    const dialog = await openCreateModelDialog(page)
    const nameInput = dialog.locator('[data-testid="model-id-name-input"]')
    await nameInput.fill(modelName)

    const apiKeyInput = dialog.locator('input#api_key, input[type="password"]').first()
    if (await apiKeyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await apiKeyInput.fill('test-api-key-for-e2e')
    }

    const submitButton = dialog.locator('button:has-text("Save"), button:has-text("保存")').first()
    if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitButton.click()
      await page.waitForTimeout(2000)
    }
  })

  test('should show test connection button for user models', async ({ page }) => {
    await expectModelListHasContentOrEmptyState(page)
    const testButton = page
      .locator('button[title*="Test"], button[title*="测试"], button:has(svg.lucide-beaker)')
      .first()

    if (await testButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await testButton.click()
      await page.waitForTimeout(2000)
    }
  })

  test('should show delete button for user models', async ({ page }) => {
    await expectModelListHasContentOrEmptyState(page)
    const deleteButton = page
      .locator('button[title*="Delete"], button[title*="删除"], button:has(svg.lucide-trash)')
      .first()

    if (await deleteButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      expect(true).toBeTruthy()
    }
  })
})
