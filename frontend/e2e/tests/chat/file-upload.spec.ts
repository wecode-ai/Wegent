import { test, expect } from '@playwright/test'
import * as path from 'path'

test.describe('File Upload and Attachments', () => {
  test.beforeEach(async ({ page }) => {
    // Page is already authenticated via global setup storageState
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Close any onboarding/driver overlay
    const skipButton = page.locator('button:has-text("Skip"), button:has-text("跳过")').first()
    if (await skipButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipButton.click()
      await page.waitForTimeout(500)
    }
  })

  test('should have file upload button in chat input', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]')

    // File input should exist for chat functionality
    const count = await fileInput.count()
    expect(count).toBeGreaterThan(0)
  })

  test('should accept file selection', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()

    // File input must be available for this test
    const isVisible = await fileInput.isVisible({ timeout: 5000 })
    expect(isVisible).toBe(true)

    const testFilePath = path.join(__dirname, '../fixtures/test-file.txt')

    // Should be able to set input files without error
    await expect(fileInput.setInputFiles(testFilePath)).resolves.not.toThrow()
  })

  test('should display attachment preview after upload', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()

    // File input must be available for this test
    const isVisible = await fileInput.isVisible({ timeout: 5000 })
    expect(isVisible).toBe(true)

    const testFilePath = path.join(__dirname, '../fixtures/test-file.txt')

    await fileInput.setInputFiles(testFilePath)
    await page.waitForTimeout(2000)

    // Check for attachment preview - should be visible after file selection
    const attachmentPreview = page.locator(
      '[data-testid="attachment"], .attachment, [class*="attachment"], [class*="file"]'
    )
    const hasPreview = await attachmentPreview.isVisible({ timeout: 5000 })
    expect(hasPreview).toBe(true)
  })

  test('should have remove button for uploaded files', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()

    // File input must be available for this test
    const isVisible = await fileInput.isVisible({ timeout: 5000 })
    expect(isVisible).toBe(true)

    const testFilePath = path.join(__dirname, '../fixtures/test-file.txt')

    await fileInput.setInputFiles(testFilePath)
    await page.waitForTimeout(2000)

    // Check for remove button - should be present for uploaded files
    const removeButton = page.locator(
      'button[title*="Remove"], button[title*="Delete"], button:has-text("×"), button[aria-label*="remove"]'
    )
    const hasRemoveButton = await removeButton.isVisible({ timeout: 5000 })
    expect(hasRemoveButton).toBe(true)
  })

  test('should support multiple file types', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()

    // File input must be available for this test
    const isVisible = await fileInput.isVisible({ timeout: 5000 })
    expect(isVisible).toBe(true)

    // Check accept attribute - should allow various file types
    const acceptAttr = await fileInput.getAttribute('accept')

    // accept attribute should be set and be a string with file type specifications
    expect(typeof acceptAttr).toBe('string')
    expect(acceptAttr?.length).toBeGreaterThan(0)
  })
})
