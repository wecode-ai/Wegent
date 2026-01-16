import { Page, Locator } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Settings Base Page Object
 * Provides common functionality for all settings tabs
 */
export class SettingsBasePage extends BasePage {
  protected readonly tabBots: Locator
  protected readonly tabTeams: Locator
  protected readonly tabModels: Locator
  protected readonly tabShells: Locator
  protected readonly tabSkills: Locator
  protected readonly tabIntegrations: Locator
  protected readonly searchInput: Locator
  protected readonly scopeSelector: Locator

  constructor(page: Page) {
    super(page)
    this.tabBots = page.locator('[data-tab="bots"], button:has-text("Bots")')
    this.tabTeams = page.locator('[data-tab="team"], button:has-text("Team")')
    this.tabModels = page.locator('[data-tab="models"], button:has-text("Models")')
    this.tabShells = page.locator('[data-tab="shells"], button:has-text("Shells")')
    this.tabSkills = page.locator('[data-tab="skills"], button:has-text("Skills")')
    this.tabIntegrations = page.locator(
      '[data-tab="integrations"], button:has-text("Integrations")'
    )
    this.searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]')
    this.scopeSelector = page.locator('[data-testid="scope-selector"]')
  }

  /**
   * Navigate to settings page
   */
  async navigate(tab?: string): Promise<void> {
    const path = tab ? `/settings?tab=${tab}` : '/settings'
    await this.goto(path)
  }

  /**
   * Switch to a specific tab
   */
  async switchTab(
    tab: 'bots' | 'team' | 'models' | 'shells' | 'skills' | 'integrations'
  ): Promise<void> {
    const tabLocator = {
      bots: this.tabBots,
      team: this.tabTeams,
      models: this.tabModels,
      shells: this.tabShells,
      skills: this.tabSkills,
      integrations: this.tabIntegrations,
    }[tab]

    await tabLocator.click()
    await this.waitForLoading()
  }

  /**
   * Search for an item
   */
  async search(query: string): Promise<void> {
    await this.searchInput.fill(query)
    await this.waitForLoading()
  }

  /**
   * Clear search
   */
  async clearSearch(): Promise<void> {
    await this.searchInput.clear()
    await this.waitForLoading()
  }

  /**
   * Select scope filter
   */
  async selectScope(scope: 'personal' | 'group' | 'all'): Promise<void> {
    await this.scopeSelector.click()
    await this.page.click(`[role="option"]:has-text("${scope}")`)
    await this.waitForLoading()
  }

  /**
   * Get current active tab
   */
  async getCurrentTab(): Promise<string> {
    const url = this.getCurrentUrl()
    const match = url.match(/tab=([^&]+)/)
    return match ? match[1] : 'bots'
  }

  /**
   * Check if on settings page
   */
  isOnSettingsPage(): boolean {
    return this.getCurrentUrl().includes('/settings')
  }
}
