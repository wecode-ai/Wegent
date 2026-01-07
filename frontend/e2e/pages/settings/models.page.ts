import { Page, Locator, expect } from '@playwright/test'
import { SettingsBasePage } from './settings-base.page'

/**
 * Models Page Object
 */
export class ModelsPage extends SettingsBasePage {
  private readonly createButton: Locator
  private readonly modelCards: Locator

  constructor(page: Page) {
    super(page)
    this.createButton = page.locator(
      'button:has-text("Create Model"), button:has-text("New Model"), button:has-text("Add Model")'
    )
    this.modelCards = page.locator('[data-testid="model-card"], [data-testid="resource-card"]')
  }

  /**
   * Navigate to models tab
   */
  async navigate(): Promise<void> {
    await super.navigate('models')
  }

  /**
   * Click create model button
   */
  async clickCreateModel(): Promise<void> {
    await this.createButton.click()
    await this.waitForDialog()
  }

  /**
   * Fill model creation form
   */
  async fillModelForm(modelData: {
    name: string
    provider?: string
    modelId?: string
    apiKey?: string
    baseUrl?: string
    description?: string
  }): Promise<void> {
    // Fill name
    await this.page.fill('input[name="name"], input[placeholder*="name" i]', modelData.name)

    // Select provider if provided
    if (modelData.provider) {
      const providerSelector = this.page.locator(
        '[data-testid="provider-select"], [role="combobox"]:has-text("Provider")'
      )
      if (await providerSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
        await providerSelector.click()
        await this.page.click(`[role="option"]:has-text("${modelData.provider}")`)
      }
    }

    // Fill model ID
    if (modelData.modelId) {
      await this.page.fill(
        'input[name="model_id"], input[placeholder*="model" i]',
        modelData.modelId
      )
    }

    // Fill API key
    if (modelData.apiKey) {
      await this.page.fill('input[name="api_key"], input[type="password"]', modelData.apiKey)
    }

    // Fill base URL
    if (modelData.baseUrl) {
      await this.page.fill('input[name="base_url"], input[placeholder*="url" i]', modelData.baseUrl)
    }

    // Fill description
    if (modelData.description) {
      await this.page.fill('textarea[name="description"]', modelData.description)
    }
  }

  /**
   * Test model connection
   */
  async testConnection(): Promise<void> {
    await this.page.click('button:has-text("Test Connection"), button:has-text("Test")')
    await this.waitForLoading()
  }

  /**
   * Submit model creation form
   */
  async submitModelForm(): Promise<void> {
    await this.page.click(
      'button:has-text("Create"), button:has-text("Save"), button[type="submit"]'
    )
    await this.waitForLoading()
  }

  /**
   * Create a new model
   */
  async createModel(modelData: {
    name: string
    provider?: string
    modelId?: string
    apiKey?: string
    baseUrl?: string
    description?: string
  }): Promise<void> {
    await this.clickCreateModel()
    await this.fillModelForm(modelData)
    await this.submitModelForm()
    await this.waitForToast()
  }

  /**
   * Get model card by name
   */
  getModelCard(name: string): Locator {
    return this.page.locator(
      `[data-testid="model-card"]:has-text("${name}"), [data-testid="resource-card"]:has-text("${name}")`
    )
  }

  /**
   * Check if model exists
   */
  async modelExists(name: string): Promise<boolean> {
    const card = this.getModelCard(name)
    return await card.isVisible({ timeout: 3000 }).catch(() => false)
  }

  /**
   * Delete a model
   */
  async deleteModel(name: string): Promise<void> {
    const card = this.getModelCard(name)
    await card.locator('[data-testid="delete-button"], button:has-text("Delete")').click()
    await this.waitForDialog()
    await this.confirmDialog('Delete')
    await this.waitForToast()
  }

  /**
   * Get number of model cards
   */
  async getModelCount(): Promise<number> {
    return await this.modelCards.count()
  }

  /**
   * Search for model
   */
  async searchModel(name: string): Promise<void> {
    await this.search(name)
  }

  /**
   * Verify model card is visible
   */
  async expectModelVisible(name: string): Promise<void> {
    await expect(this.getModelCard(name)).toBeVisible()
  }
}
