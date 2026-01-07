import { Page } from '@playwright/test'
import { ApiClient, createApiClient } from './api-client'
import { APIRequestContext } from '@playwright/test'

/**
 * Smart wait utilities that replace hardcoded waitForTimeout calls
 * These functions wait for specific conditions instead of fixed time
 */

/**
 * Wait for page to be stable (no network activity and DOM stable)
 * Use this instead of waitForTimeout after navigation or data loading
 */
export async function waitForPageStable(page: Page, timeout: number = 5000): Promise<void> {
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout }),
    page.waitForTimeout(timeout), // Fallback if networkidle never triggers
  ]).catch(() => {
    // Ignore timeout - page may already be stable
  })
}

/**
 * Wait for any loading indicators to disappear
 * Use this after actions that trigger loading states
 */
export async function waitForLoadingComplete(page: Page, timeout: number = 5000): Promise<void> {
  const loadingSelectors = [
    '[data-loading="true"]',
    '[data-testid="loading"]',
    '.loading',
    '.spinner',
    '[class*="loading"]',
    '[class*="spinner"]',
  ]

  for (const selector of loadingSelectors) {
    try {
      const loading = page.locator(selector).first()
      if (await loading.isVisible({ timeout: 500 }).catch(() => false)) {
        await loading.waitFor({ state: 'hidden', timeout })
      }
    } catch {
      // Ignore - loading indicator may not exist
    }
  }
}

/**
 * Wait for content to appear after an action
 * Use this instead of waitForTimeout after clicking buttons that load content
 */
export async function waitForContentReady(
  page: Page,
  contentSelector: string,
  timeout: number = 5000
): Promise<boolean> {
  try {
    await page.waitForSelector(contentSelector, { state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Wait for API call to complete
 * Use this when waiting for specific API responses
 */
export async function waitForApiCall(
  page: Page,
  urlPattern: string | RegExp,
  timeout: number = 10000
): Promise<void> {
  await page.waitForResponse(
    response => {
      const url = response.url()
      return typeof urlPattern === 'string' ? url.includes(urlPattern) : urlPattern.test(url)
    },
    { timeout }
  )
}

/**
 * Wait for dialog/modal to open
 * Use this after clicking buttons that open dialogs
 */
export async function waitForDialogOpen(page: Page, timeout: number = 5000): Promise<boolean> {
  try {
    await page.waitForSelector('[role="dialog"], [role="alertdialog"]', {
      state: 'visible',
      timeout,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Wait for dialog/modal to close
 * Use this after closing dialogs
 */
export async function waitForDialogClose(page: Page, timeout: number = 5000): Promise<void> {
  try {
    await page.waitForSelector('[role="dialog"], [role="alertdialog"]', {
      state: 'hidden',
      timeout,
    })
  } catch {
    // Dialog may already be closed
  }
}

/**
 * Wait for toast notification
 * Use this after actions that show toast messages
 */
export async function waitForToast(page: Page, timeout: number = 5000): Promise<boolean> {
  try {
    await page.waitForSelector('[data-sonner-toast], [role="alert"], .toast', {
      state: 'visible',
      timeout,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Wait for element to be visible
 */
export async function waitForElement(
  page: Page,
  selector: string,
  timeout: number = 10000
): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout })
}

/**
 * Wait for element to be hidden
 */
export async function waitForElementHidden(
  page: Page,
  selector: string,
  timeout: number = 10000
): Promise<void> {
  await page.waitForSelector(selector, { state: 'hidden', timeout })
}

/**
 * Wait for navigation to complete
 */
export async function waitForNavigation(page: Page, urlPattern?: string | RegExp): Promise<void> {
  if (urlPattern) {
    await page.waitForURL(urlPattern)
  } else {
    await page.waitForLoadState('networkidle')
  }
}

/**
 * Retry an action multiple times
 */
export async function retry<T>(
  action: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: Error | null = null

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await action()
    } catch (error) {
      lastError = error as Error
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError
}

/**
 * Generate a random string
 */
export function randomString(length: number = 8): string {
  return Math.random()
    .toString(36)
    .substring(2, 2 + length)
}

/**
 * Generate a unique test name
 */
export function uniqueTestName(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomString(4)}`
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
  return !!process.env.CI
}

/**
 * Get base URL for tests
 */
export function getBaseUrl(): string {
  return process.env.E2E_BASE_URL || 'http://localhost:3000'
}

/**
 * Get API URL for tests
 */
export function getApiUrl(): string {
  return process.env.E2E_API_URL || 'http://localhost:8000'
}

/**
 * Take a debugging screenshot
 */
export async function debugScreenshot(page: Page, name: string): Promise<void> {
  const timestamp = Date.now()
  await page.screenshot({
    path: `test-results/debug-${name}-${timestamp}.png`,
    fullPage: true,
  })
}

/**
 * Log page console errors
 */
export function setupConsoleErrorLogging(page: Page): void {
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error(`Page console error: ${msg.text()}`)
    }
  })

  page.on('pageerror', error => {
    console.error(`Page error: ${error.message}`)
  })
}

/**
 * Wait for API response with specific status
 */
export async function waitForApiResponseWithStatus(
  page: Page,
  urlPattern: string | RegExp,
  expectedStatus: number,
  timeout: number = 10000
): Promise<void> {
  await page.waitForResponse(
    response => {
      const matches =
        typeof urlPattern === 'string'
          ? response.url().includes(urlPattern)
          : urlPattern.test(response.url())
      return matches && response.status() === expectedStatus
    },
    { timeout }
  )
}

/**
 * Scroll to bottom of page
 */
export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight)
  })
}

/**
 * Scroll to top of page
 */
export async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0)
  })
}

/**
 * Get all cookies
 */
export async function getCookies(page: Page): Promise<{ name: string; value: string }[]> {
  const context = page.context()
  return await context.cookies()
}

/**
 * Clear all cookies
 */
export async function clearCookies(page: Page): Promise<void> {
  const context = page.context()
  await context.clearCookies()
}

/**
 * Get localStorage item
 */
export async function getLocalStorageItem(page: Page, key: string): Promise<string | null> {
  return await page.evaluate(k => localStorage.getItem(k), key)
}

/**
 * Set localStorage item
 */
export async function setLocalStorageItem(page: Page, key: string, value: string): Promise<void> {
  await page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })
}

/**
 * Clear localStorage
 */
export async function clearLocalStorage(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear())
}

/**
 * Format date for display
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}

/**
 * Get current timestamp
 */
export function getTimestamp(): number {
  return Date.now()
}

/**
 * Extract number from string
 */
export function extractNumber(str: string): number | null {
  const match = str.match(/\d+/)
  return match ? parseInt(match[0], 10) : null
}

/**
 * Truncate string to specified length
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.substring(0, maxLength - 3) + '...'
}

/**
 * Create authenticated API client
 */
export async function createAuthenticatedApiClient(
  request: APIRequestContext,
  username: string = 'admin',
  password: string = 'Wegent2025!'
): Promise<ApiClient> {
  const apiClient = createApiClient(request)
  await apiClient.login(username, password)
  return apiClient
}

/**
 * Parse JSON safely
 */
export function safeJsonParse<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json)
  } catch {
    return defaultValue
  }
}

/**
 * Check if element is in viewport
 */
export async function isInViewport(page: Page, selector: string): Promise<boolean> {
  return await page.evaluate(sel => {
    const element = document.querySelector(sel)
    if (!element) return false
    const rect = element.getBoundingClientRect()
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    )
  }, selector)
}

/**
 * Count elements matching selector
 */
export async function countElements(page: Page, selector: string): Promise<number> {
  return await page.locator(selector).count()
}

/**
 * Get all text content from elements
 */
export async function getAllTextContent(page: Page, selector: string): Promise<string[]> {
  return await page.locator(selector).allTextContents()
}

/**
 * Click element by text content
 */
export async function clickByText(page: Page, text: string): Promise<void> {
  await page.click(`text="${text}"`)
}

/**
 * Double click element
 */
export async function doubleClick(page: Page, selector: string): Promise<void> {
  await page.dblclick(selector)
}

/**
 * Right click element
 */
export async function rightClick(page: Page, selector: string): Promise<void> {
  await page.click(selector, { button: 'right' })
}

/**
 * Press keyboard key
 */
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
}

/**
 * Type text with delay
 */
export async function typeWithDelay(
  page: Page,
  selector: string,
  text: string,
  delay: number = 50
): Promise<void> {
  await page.locator(selector).pressSequentially(text, { delay })
}

/**
 * Download file and return path
 */
export async function downloadFile(page: Page, triggerSelector: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(triggerSelector)])
  const path = await download.path()
  return path || ''
}

/**
 * Upload file
 */
export async function uploadFile(
  page: Page,
  inputSelector: string,
  filePath: string
): Promise<void> {
  await page.setInputFiles(inputSelector, filePath)
}
