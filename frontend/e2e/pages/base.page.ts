import { Page, Locator, expect } from '@playwright/test'

/**
 * Base Page Object class
 * All page objects should extend this class
 */
export abstract class BasePage {
  constructor(protected page: Page) {}

  // Navigation
  async goto(path: string): Promise<void> {
    await this.page.goto(path)
    await this.waitForPageLoad()
  }

  async waitForPageLoad(): Promise<void> {
    // Use domcontentloaded instead of networkidle to avoid timeout issues in CI
    await this.page.waitForLoadState('domcontentloaded')
    // Add a small delay to allow for initial rendering
    await this.page.waitForTimeout(500)
  }

  // Loading states
  async waitForLoading(): Promise<void> {
    await this.page
      .locator('[data-loading="true"], [role="progressbar"]')
      .waitFor({ state: 'detached', timeout: 15000 })
      .catch(() => {})
  }

  // Toast notifications
  async waitForToast(text?: string, _type?: 'success' | 'error'): Promise<void> {
    const selector = text ? `[data-sonner-toast]:has-text("${text}")` : '[data-sonner-toast]'
    await this.page.waitForSelector(selector, { timeout: 10000 })
  }

  async getToastText(): Promise<string> {
    const toast = await this.page.locator('[data-sonner-toast]').first()
    return (await toast.textContent()) || ''
  }

  // Dialog operations
  async waitForDialog(): Promise<void> {
    await this.page.locator('[role="dialog"]').waitFor({ state: 'visible' })
  }

  async closeDialog(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await this.page.locator('[role="dialog"]').waitFor({ state: 'detached' })
  }

  async clickButton(text: string): Promise<void> {
    await this.page.click(`button:has-text("${text}")`)
  }

  async confirmDialog(confirmText: string = 'Confirm'): Promise<void> {
    await this.clickButton(confirmText)
    await this.waitForLoading()
  }

  // Form operations
  async fillInput(label: string, value: string): Promise<void> {
    const input = this.page
      .locator(
        `label:has-text("${label}") ~ input, input[placeholder*="${label}"], input[name="${label}"]`
      )
      .first()
    await input.fill(value)
  }

  async selectOption(label: string, optionText: string): Promise<void> {
    const trigger = this.page.locator(`[role="combobox"]:has-text("${label}")`).first()
    await trigger.click()
    await this.page.locator(`[role="option"]:has-text("${optionText}")`).click()
  }

  async fillTextarea(label: string, value: string): Promise<void> {
    const textarea = this.page
      .locator(`label:has-text("${label}") ~ textarea, textarea[placeholder*="${label}"]`)
      .first()
    await textarea.fill(value)
  }

  // Assertions
  async expectVisible(selector: string): Promise<void> {
    await expect(this.page.locator(selector)).toBeVisible()
  }

  async expectText(selector: string, text: string): Promise<void> {
    await expect(this.page.locator(selector)).toContainText(text)
  }

  async expectNotVisible(selector: string): Promise<void> {
    await expect(this.page.locator(selector)).not.toBeVisible()
  }

  // Performance measurement
  async measureLoadTime(): Promise<number> {
    const performanceTiming = await this.page.evaluate(() => {
      const timing = performance.timing
      return timing.loadEventEnd - timing.navigationStart
    })
    return performanceTiming
  }

  // Visual regression
  async takeScreenshot(name: string): Promise<Buffer> {
    return await this.page.screenshot({
      fullPage: true,
      path: `e2e/screenshots/${name}.png`,
    })
  }

  async compareVisual(name: string): Promise<void> {
    await expect(this.page).toHaveScreenshot(`${name}.png`, {
      maxDiffPixels: 100,
    })
  }

  // Helper to get locator
  protected getLocator(selector: string): Locator {
    return this.page.locator(selector)
  }

  // Wait for specific element
  async waitForSelector(
    selector: string,
    options?: { state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }
  ): Promise<void> {
    if (options) {
      await this.page.waitForSelector(selector, options)
    } else {
      await this.page.waitForSelector(selector)
    }
  }

  // Check if element exists
  async elementExists(selector: string): Promise<boolean> {
    const count = await this.page.locator(selector).count()
    return count > 0
  }

  // Get current URL
  getCurrentUrl(): string {
    return this.page.url()
  }

  // Wait for URL to change
  async waitForUrl(urlPattern: string | RegExp, timeout: number = 10000): Promise<void> {
    await this.page.waitForURL(urlPattern, { timeout })
  }

  // Get page title
  async getPageTitle(): Promise<string> {
    return await this.page.title()
  }

  // Scroll to element
  async scrollToElement(selector: string): Promise<void> {
    const element = this.page.locator(selector)
    await element.scrollIntoViewIfNeeded()
  }

  // Wait for network idle - use with caution as it can timeout in CI
  async waitForNetworkIdle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      // Fallback to domcontentloaded if networkidle times out
    })
  }

  // Get all text content from elements matching selector
  async getAllText(selector: string): Promise<string[]> {
    const elements = this.page.locator(selector)
    return await elements.allTextContents()
  }

  // Count elements
  async countElements(selector: string): Promise<number> {
    return await this.page.locator(selector).count()
  }
}
