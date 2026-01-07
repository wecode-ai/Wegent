import { Page, Locator, expect } from '@playwright/test'
import { SettingsBasePage } from './settings-base.page'

/**
 * Bots Page Object
 */
export class BotsPage extends SettingsBasePage {
  private readonly createButton: Locator
  private readonly botCards: Locator

  constructor(page: Page) {
    super(page)
    // Button text is "New Bot" (en) or "新建Bot" (zh-CN) from i18n
    this.createButton = page.locator(
      'button:has-text("New Bot"), button:has-text("新建Bot"), button:has-text("Create Bot")'
    )
    this.botCards = page.locator('[data-testid="bot-card"], [data-testid="resource-card"]')
  }

  /**
   * Navigate to bots tab
   */
  async navigate(): Promise<void> {
    await super.navigate('bots')
  }

  /**
   * Click create bot button
   */
  async clickCreateBot(): Promise<void> {
    await this.createButton.click()
    await this.waitForDialog()
  }

  /**
   * Fill bot creation form
   */
  async fillBotForm(botData: {
    name: string
    description?: string
    ghost?: string
    shell?: string
    model?: string
  }): Promise<void> {
    // Fill name
    await this.page.fill('input[name="name"], input[placeholder*="name" i]', botData.name)

    // Fill description if provided
    if (botData.description) {
      await this.page.fill(
        'textarea[name="description"], textarea[placeholder*="description" i]',
        botData.description
      )
    }

    // Select ghost if provided
    if (botData.ghost) {
      const ghostSelector = this.page.locator(
        '[data-testid="ghost-select"], [role="combobox"]:has-text("Ghost")'
      )
      if (await ghostSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
        await ghostSelector.click()
        await this.page.click(`[role="option"]:has-text("${botData.ghost}")`)
      }
    }

    // Select shell if provided
    if (botData.shell) {
      const shellSelector = this.page.locator(
        '[data-testid="shell-select"], [role="combobox"]:has-text("Shell")'
      )
      if (await shellSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
        await shellSelector.click()
        await this.page.click(`[role="option"]:has-text("${botData.shell}")`)
      }
    }

    // Select model if provided
    if (botData.model) {
      const modelSelector = this.page.locator(
        '[data-testid="model-select"], [role="combobox"]:has-text("Model")'
      )
      if (await modelSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
        await modelSelector.click()
        await this.page.click(`[role="option"]:has-text("${botData.model}")`)
      }
    }
  }

  /**
   * Submit bot creation form
   */
  async submitBotForm(): Promise<void> {
    await this.page.click(
      'button:has-text("Create"), button:has-text("Save"), button[type="submit"]'
    )
    await this.waitForLoading()
  }

  /**
   * Create a new bot
   */
  async createBot(botData: {
    name: string
    description?: string
    ghost?: string
    shell?: string
    model?: string
  }): Promise<void> {
    await this.clickCreateBot()
    await this.fillBotForm(botData)
    await this.submitBotForm()
    await this.waitForToast()
  }

  /**
   * Get bot card by name
   */
  getBotCard(name: string): Locator {
    return this.page.locator(
      `[data-testid="bot-card"]:has-text("${name}"), [data-testid="resource-card"]:has-text("${name}")`
    )
  }

  /**
   * Check if bot exists
   */
  async botExists(name: string): Promise<boolean> {
    const card = this.getBotCard(name)
    return await card.isVisible({ timeout: 3000 }).catch(() => false)
  }

  /**
   * Click edit on a bot
   */
  async editBot(name: string): Promise<void> {
    const card = this.getBotCard(name)
    await card.locator('[data-testid="edit-button"], button:has-text("Edit")').click()
    await this.waitForDialog()
  }

  /**
   * Delete a bot
   */
  async deleteBot(name: string): Promise<void> {
    const card = this.getBotCard(name)
    await card.locator('[data-testid="delete-button"], button:has-text("Delete")').click()
    await this.waitForDialog()
    await this.confirmDialog('Delete')
    await this.waitForToast()
  }

  /**
   * Get number of bot cards
   */
  async getBotCount(): Promise<number> {
    return await this.botCards.count()
  }

  /**
   * Get all bot names
   */
  async getAllBotNames(): Promise<string[]> {
    const cards = this.botCards
    const count = await cards.count()
    const names: string[] = []

    for (let i = 0; i < count; i++) {
      const nameElement = cards
        .nth(i)
        .locator('[data-testid="bot-name"], .bot-name, h3, h4')
        .first()
      const name = await nameElement.textContent()
      if (name) names.push(name.trim())
    }

    return names
  }

  /**
   * Search for bot
   */
  async searchBot(name: string): Promise<void> {
    await this.search(name)
  }

  /**
   * Verify bot card is visible
   */
  async expectBotVisible(name: string): Promise<void> {
    await expect(this.getBotCard(name)).toBeVisible()
  }

  /**
   * Verify bot card is not visible
   */
  async expectBotNotVisible(name: string): Promise<void> {
    await expect(this.getBotCard(name)).not.toBeVisible()
  }
}
