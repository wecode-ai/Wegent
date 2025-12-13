import { test, expect } from '@playwright/test'
import { createVisualRegression, ViewportConfigs } from '../../utils/visual-regression'
import { LoginPage } from '../../pages/auth/login.page'
import { ADMIN_USER } from '../../config/test-users'

/**
 * Visual regression tests
 * These tests capture and compare screenshots to detect UI changes
 *
 * Note: Run with --update-snapshots flag to update baseline screenshots
 */
test.describe('Visual Regression - Login Page', () => {
  test('login page should match baseline @visual', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    // Wait for any animations to complete
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('login-page.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    })
  })

  test('login form should match baseline @visual', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    const form = page.locator('form')
    await expect(form).toHaveScreenshot('login-form.png', {
      maxDiffPixels: 50,
    })
  })
})

test.describe('Visual Regression - Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    const loginPage = new LoginPage(page)
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password)
  })

  test('settings bots tab should match baseline @visual', async ({ page }) => {
    await page.goto('/settings?tab=bots')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('settings-bots.png', {
      maxDiffPixels: 200,
      threshold: 0.3,
    })
  })

  test('settings models tab should match baseline @visual', async ({ page }) => {
    await page.goto('/settings?tab=models')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('settings-models.png', {
      maxDiffPixels: 200,
      threshold: 0.3,
    })
  })

  test('settings teams tab should match baseline @visual', async ({ page }) => {
    await page.goto('/settings?tab=team')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('settings-teams.png', {
      maxDiffPixels: 200,
      threshold: 0.3,
    })
  })
})

test.describe('Visual Regression - Chat Page', () => {
  test.beforeEach(async ({ page }) => {
    const loginPage = new LoginPage(page)
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password)
  })

  test('chat page should match baseline @visual', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('chat-page.png', {
      maxDiffPixels: 200,
      threshold: 0.3,
    })
  })
})

test.describe('Visual Regression - Responsive Views', () => {
  test('login page mobile view @visual', async ({ page }) => {
    await page.setViewportSize(ViewportConfigs.mobile)
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('login-mobile.png', {
      maxDiffPixels: 100,
    })
  })

  test('login page tablet view @visual', async ({ page }) => {
    await page.setViewportSize(ViewportConfigs.tablet)
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('login-tablet.png', {
      maxDiffPixels: 100,
    })
  })

  test('login page desktop view @visual', async ({ page }) => {
    await page.setViewportSize(ViewportConfigs.desktop)
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('login-desktop.png', {
      maxDiffPixels: 100,
    })
  })
})

test.describe('Visual Regression - Components', () => {
  test.beforeEach(async ({ page }) => {
    const loginPage = new LoginPage(page)
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password)
  })

  test('create bot dialog should match baseline @visual', async ({ page }) => {
    await page.goto('/settings?tab=bots')
    await page.waitForLoadState('networkidle')

    // Click create button
    await page.click('button:has-text("Create Bot"), button:has-text("New Bot")')
    await page.waitForSelector('[role="dialog"]')
    await page.waitForTimeout(300)

    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toHaveScreenshot('create-bot-dialog.png', {
      maxDiffPixels: 100,
    })
  })
})
