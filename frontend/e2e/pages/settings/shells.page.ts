import { Page } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Settings Shell Page Object
 * Handles shell management interactions
 */
export class ShellsPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  // Navigation
  async navigate(): Promise<void> {
    await this.goto('/settings?section=personal&tab=personal-shells')
  }

  async navigateToGroupShells(groupName?: string): Promise<void> {
    const groupParam = groupName ? `&group=${encodeURIComponent(groupName)}` : ''
    await this.goto(`/settings?section=groups&tab=group-shells${groupParam}`)
  }

  isOnSettingsPage(): boolean {
    return this.page.url().includes('/settings')
  }

  // Shell list operations
  async getShellCount(): Promise<number> {
    await this.waitForPageLoad()
    const cards = this.page.locator('[data-testid="shell-card"], .shell-card, .space-y-3 > div')
    return await cards.count()
  }

  async clickCreateShell(): Promise<void> {
    await this.page.click(
      'button:has-text("Create Shell"), button:has-text("新建Shell"), button:has-text("New Shell")'
    )
    await this.waitForDialog()
  }

  async fillShellForm(data: {
    name: string
    description?: string
    shellType?: 'ClaudeCode' | 'Agno' | 'Dify' | 'Chat'
    baseImage?: string
  }): Promise<void> {
    // Fill shell name
    const nameInput = this.page
      .locator(
        '[role="dialog"] input[placeholder*="shell"], [role="dialog"] input#name, [role="dialog"] input'
      )
      .first()
    await nameInput.fill(data.name)

    // Fill description if provided
    if (data.description) {
      const descInput = this.page
        .locator('[role="dialog"] textarea, [role="dialog"] input[placeholder*="description"]')
        .first()
      if (await descInput.isVisible()) {
        await descInput.fill(data.description)
      }
    }

    // Select shell type if provided
    if (data.shellType) {
      const typeSelect = this.page.locator('[role="dialog"] [role="combobox"]').first()
      if (await typeSelect.isVisible()) {
        await typeSelect.click()
        await this.page.click(`[role="option"]:has-text("${data.shellType}")`)
      }
    }

    // Fill base image if provided
    if (data.baseImage) {
      const imageInput = this.page
        .locator('[role="dialog"] input[placeholder*="image"], [role="dialog"] input#baseImage')
        .first()
      if (await imageInput.isVisible()) {
        await imageInput.fill(data.baseImage)
      }
    }
  }

  async submitShellForm(): Promise<void> {
    await this.page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存"), [role="dialog"] button:has-text("Create")'
    )
    await this.waitForLoading()
  }

  async searchShell(searchTerm: string): Promise<void> {
    const searchInput = this.page
      .locator('input[placeholder*="search"], input[placeholder*="搜索"]')
      .first()
    if (await searchInput.isVisible()) {
      await searchInput.fill(searchTerm)
      await this.page.waitForTimeout(500) // Debounce
    }
  }

  async shellExists(shellName: string): Promise<boolean> {
    await this.waitForPageLoad()
    const shellCard = this.page.locator(`text="${shellName}"`)
    return await shellCard.isVisible({ timeout: 3000 }).catch(() => false)
  }

  async clickEditShell(shellName: string): Promise<void> {
    const shellCard = this.page
      .locator(
        `.space-y-3 > div:has-text("${shellName}"), [data-testid="shell-card"]:has-text("${shellName}")`
      )
      .first()
    const editButton = shellCard.locator('button[title*="Edit"], button:has-text("Edit")').first()
    await editButton.click()
    await this.waitForDialog()
  }

  async clickDeleteShell(shellName: string): Promise<void> {
    const shellCard = this.page
      .locator(
        `.space-y-3 > div:has-text("${shellName}"), [data-testid="shell-card"]:has-text("${shellName}")`
      )
      .first()
    const deleteButton = shellCard
      .locator('button[title*="Delete"], button:has-text("Delete")')
      .first()
    await deleteButton.click()
    await this.waitForDialog()
  }

  async confirmDelete(): Promise<void> {
    await this.page.click(
      '[role="alertdialog"] button:has-text("Delete"), [role="alertdialog"] button:has-text("删除"), [role="alertdialog"] button:has-text("Continue")'
    )
    await this.waitForLoading()
  }

  async selectScope(scope: 'personal' | 'group' | 'all'): Promise<void> {
    const scopeSelector = this.page
      .locator('[data-testid="scope-selector"], [role="combobox"]')
      .first()
    if (await scopeSelector.isVisible()) {
      await scopeSelector.click()
      await this.page.click(`[role="option"]:has-text("${scope}")`)
      await this.waitForPageLoad()
    }
  }

  async validateImage(_imageName: string): Promise<void> {
    const validateButton = this.page
      .locator('button:has-text("Validate"), button:has-text("验证")')
      .first()
    if (await validateButton.isVisible()) {
      await validateButton.click()
      await this.waitForLoading()
    }
  }
}
