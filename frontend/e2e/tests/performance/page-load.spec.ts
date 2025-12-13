import { test, expect } from '@playwright/test'
import { createPerformanceMonitor, PerformanceMonitor, PerformanceThresholds } from '../../utils/performance'
import { ADMIN_USER } from '../../config/test-users'
import { LoginPage } from '../../pages/auth/login.page'

test.describe('Performance - Page Load', () => {
  let perfMonitor: PerformanceMonitor

  test.beforeEach(async ({ page }) => {
    perfMonitor = createPerformanceMonitor(page)
    perfMonitor.startListening()
  })

  test('login page should load within acceptable time', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    const metrics = await perfMonitor.measurePageLoad()
    await perfMonitor.logMetrics('Login Page')

    expect(metrics.loadTime).toBeLessThan(PerformanceThresholds.pageLoad.acceptable)
    expect(metrics.domContentLoaded).toBeLessThan(PerformanceThresholds.domContentLoaded.acceptable)
  })

  test('settings page should load within acceptable time', async ({ page }) => {
    // Login first
    const loginPage = new LoginPage(page)
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password)

    // Navigate to settings
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    const metrics = await perfMonitor.measurePageLoad()
    await perfMonitor.logMetrics('Settings Page')

    expect(metrics.loadTime).toBeLessThan(PerformanceThresholds.pageLoad.acceptable)
  })

  test('chat page should load within acceptable time', async ({ page }) => {
    // Login first
    const loginPage = new LoginPage(page)
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password)

    // Navigate to chat
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')

    const metrics = await perfMonitor.measurePageLoad()
    await perfMonitor.logMetrics('Chat Page')

    expect(metrics.loadTime).toBeLessThan(PerformanceThresholds.pageLoad.acceptable)
  })

  test('API responses should be within acceptable time', async ({ page }) => {
    // Login first
    const loginPage = new LoginPage(page)
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password)

    // Navigate to settings to trigger API calls
    await page.goto('/settings?tab=bots')
    await page.waitForLoadState('networkidle')

    const apiTimings = perfMonitor.getApiTimings()
    const avgTime = perfMonitor.getAverageApiTime()

    console.log(`\n⚡ API Performance Summary:`)
    console.log(`  Total Calls: ${apiTimings.length}`)
    console.log(`  Average Response: ${avgTime.toFixed(2)}ms`)

    const slowestCalls = perfMonitor.getSlowestApiCalls(3)
    if (slowestCalls.length > 0) {
      console.log(`  Slowest Calls:`)
      slowestCalls.forEach((call, i) => {
        console.log(`    ${i + 1}. ${call.method} ${call.url.split('/api')[1]} - ${call.duration}ms`)
      })
    }

    expect(avgTime).toBeLessThan(PerformanceThresholds.apiResponse.acceptable)
  })

  test('page should have reasonable resource count', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    const metrics = await perfMonitor.measurePageLoad()

    console.log(`\n📦 Resource Summary:`)
    console.log(`  Resource Count: ${metrics.resourceCount}`)
    console.log(`  Total Transfer Size: ${(metrics.totalTransferSize / 1024).toFixed(2)}KB`)

    // Login page should not load excessive resources
    expect(metrics.resourceCount).toBeLessThan(100)
  })
})

test.describe('Performance - First Contentful Paint', () => {
  test('FCP should be within acceptable range', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    const perfMonitor = createPerformanceMonitor(page)
    const metrics = await perfMonitor.measurePageLoad()

    console.log(`\n🎨 Paint Metrics:`)
    console.log(`  First Contentful Paint: ${metrics.firstContentfulPaint}ms`)

    expect(metrics.firstContentfulPaint).toBeLessThan(PerformanceThresholds.firstContentfulPaint.acceptable)
  })
})
