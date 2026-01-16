import { test as base, expect, Page } from '@playwright/test'

/**
 * Custom test fixtures for Wegent E2E tests
 */

export interface TestFixtures {
  authenticatedPage: Page
  testPrefix: string
}

/**
 * Extended test with custom fixtures
 */
export const test = base.extend<TestFixtures>({
  /**
   * Authenticated page fixture
   * Uses saved storage state for authentication
   */
  authenticatedPage: async ({ page }, use) => {
    // The storage state is automatically loaded from config
    await use(page)
  },

  /**
   * Test prefix for unique naming
   * Helps avoid conflicts between test runs
   */
  testPrefix: async ({}, use) => {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(7)
    await use(`e2e-${timestamp}-${random}`)
  },
})

export { expect }

/**
 * Common page object helpers
 */
export class PageHelpers {
  constructor(private page: Page) {}

  /**
   * Navigate to a tab in settings
   */
  async navigateToSettingsTab(tab: 'team' | 'models' | 'integrations'): Promise<void> {
    await this.page.goto(`/settings?tab=${tab}`)
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Wait for toast notification
   */
  async waitForToast(
    text?: string,
    _type: 'success' | 'error' | 'default' = 'default'
  ): Promise<void> {
    const toastSelector = text ? `[data-sonner-toast]:has-text("${text}")` : '[data-sonner-toast]'
    await this.page.waitForSelector(toastSelector, { timeout: 10000 })
  }

  /**
   * Click a button with specific text
   */
  async clickButton(text: string): Promise<void> {
    await this.page.click(`button:has-text("${text}")`)
  }

  /**
   * Fill form field by label
   */
  async fillField(label: string, value: string): Promise<void> {
    const field = this.page.locator(`label:has-text("${label}") + input`)
    await field.fill(value)
  }

  /**
   * Select option from dropdown
   */
  async selectOption(selectorOrLabel: string, optionText: string): Promise<void> {
    // Click to open dropdown
    await this.page.click(selectorOrLabel)
    // Wait for options and click
    await this.page.click(`[role="option"]:has-text("${optionText}")`)
  }

  /**
   * Wait for loading to complete
   */
  async waitForLoading(): Promise<void> {
    // Wait for any loading spinners to disappear
    await this.page
      .waitForSelector('[data-loading="true"]', {
        state: 'detached',
        timeout: 15000,
      })
      .catch(() => {
        // Ignore if no loading indicator found
      })
  }

  /**
   * Confirm deletion dialog
   */
  async confirmDelete(): Promise<void> {
    await this.page.click(
      'button:has-text("Delete"), button:has-text("Confirm"), button:has-text("确认")'
    )
  }

  /**
   * Cancel dialog
   */
  async cancelDialog(): Promise<void> {
    await this.page.click('button:has-text("Cancel"), button:has-text("取消")')
  }
}

/**
 * Test data generators
 */
export const TestData = {
  /**
   * Generate unique name with prefix
   */
  uniqueName: (prefix: string): string => {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`
  },

  /**
   * Generate mock bot config
   */
  mockBotConfig: (name: string) => ({
    name,
    kind: 'Bot',
    spec: {
      description: `E2E test bot: ${name}`,
      agent: 'claude-code',
    },
  }),

  /**
   * Generate mock team config
   */
  mockTeamConfig: (name: string) => ({
    name,
    kind: 'Team',
    spec: {
      description: `E2E test team: ${name}`,
      mode: 'collaborate',
    },
  }),

  /**
   * Generate mock model config
   */
  mockModelConfig: (name: string) => ({
    name,
    provider: 'openai',
    model_id: 'gpt-4',
    api_key: 'test-api-key',
    base_url: 'https://api.openai.com/v1',
  }),
}
