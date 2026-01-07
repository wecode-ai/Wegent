import { Page } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Admin Page Object
 * Handles admin panel interactions
 */
export class AdminPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  // Navigation
  async navigate(): Promise<void> {
    await this.goto('/admin')
  }

  async navigateToTab(tab: 'users' | 'public-models' | 'system-config'): Promise<void> {
    await this.goto(`/admin?tab=${tab}`)
    // Wait for DOM to be ready
    await this.page.waitForLoadState('domcontentloaded')
    // Additional wait for content to render
    await this.page.waitForTimeout(1000)
  }

  // Tab navigation
  async clickTab(tabName: string): Promise<void> {
    await this.page.click(`button:has-text("${tabName}"), [role="tab"]:has-text("${tabName}")`)
    await this.waitForPageLoad()
  }

  isOnAdminPage(): boolean {
    return this.page.url().includes('/admin')
  }

  // Access denied check
  async isAccessDenied(): Promise<boolean> {
    const accessDenied = await this.page
      .locator('text=Access Denied, text=访问被拒绝, h1:has-text("Access")')
      .isVisible({ timeout: 3000 })
      .catch(() => false)
    return accessDenied
  }

  // ==================== User Management ====================

  async getUserCount(): Promise<number> {
    await this.waitForPageLoad()
    const cards = this.page.locator('[data-testid="user-card"], .user-card, .space-y-3 > div')
    return await cards.count()
  }

  async clickCreateUser(): Promise<void> {
    await this.page.click('button:has-text("Create User"), button:has-text("新建用户")')
    await this.waitForDialog()
  }

  async fillUserForm(data: {
    username: string
    email?: string
    password?: string
    role?: 'admin' | 'user'
  }): Promise<void> {
    // Fill username - use the actual input id from UserList.tsx
    const usernameInput = this.page
      .locator('input#username, input[placeholder*="user"], input#user_name')
      .first()
    await usernameInput.fill(data.username)

    // Fill password if provided - use the actual input id from UserList.tsx
    if (data.password) {
      const passwordInput = this.page.locator('input#password, input[type="password"]').first()
      if (await passwordInput.isVisible().catch(() => false)) {
        await passwordInput.fill(data.password)
      }
    }

    // Fill email if provided - use the actual input id from UserList.tsx
    if (data.email) {
      const emailInput = this.page.locator('input#email, input[type="email"]').first()
      if (await emailInput.isVisible()) {
        await emailInput.fill(data.email)
      }
    }

    // Select role if provided - role selector is the last combobox in the form
    // (first is auth_source selector)
    if (data.role) {
      const roleSelect = this.page.locator('[role="combobox"]').last()
      if (await roleSelect.isVisible()) {
        await roleSelect.click()
        // Wait for dropdown to open
        await this.page.waitForTimeout(300)
        // Role options display as "User" or "Admin" (capitalized)
        const roleText = data.role.charAt(0).toUpperCase() + data.role.slice(1)
        await this.page.click(`[role="option"]:has-text("${roleText}")`)
      }
    }
  }

  async submitUserForm(): Promise<void> {
    await this.page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存"), [role="dialog"] button:has-text("Create")'
    )
    await this.waitForLoading()
  }

  async searchUser(searchTerm: string): Promise<void> {
    const searchInput = this.page
      .locator('input[placeholder*="search"], input[placeholder*="搜索"]')
      .first()
    await searchInput.fill(searchTerm)
    await this.page.waitForTimeout(500) // Debounce
  }

  async userExists(username: string): Promise<boolean> {
    await this.waitForPageLoad()
    const userCard = this.page.locator(`text="${username}"`)
    return await userCard.isVisible({ timeout: 3000 }).catch(() => false)
  }

  async clickEditUser(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first()
    const editButton = userCard.locator('button[title*="Edit"], button:has-text("Edit")').first()
    await editButton.click()
    await this.waitForDialog()
  }

  async clickDeleteUser(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first()
    const deleteButton = userCard
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

  async toggleUserStatus(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first()
    const toggleButton = userCard
      .locator('button[title*="Toggle"], button[title*="Status"]')
      .first()
    await toggleButton.click()
    await this.waitForLoading()
  }

  async resetUserPassword(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first()
    const resetButton = userCard.locator('button[title*="Reset"], button:has-text("Reset")').first()
    await resetButton.click()
    await this.waitForDialog()
  }

  // ==================== Public Model Management ====================

  async getPublicModelCount(): Promise<number> {
    await this.waitForPageLoad()
    const cards = this.page.locator('[data-testid="model-card"], .model-card, .space-y-3 > div')
    return await cards.count()
  }

  async clickCreatePublicModel(): Promise<void> {
    await this.page.click(
      'button:has-text("Create Model"), button:has-text("新建模型"), button:has-text("Add Model")'
    )
    await this.waitForDialog()
  }

  async fillPublicModelForm(data: {
    name: string
    namespace?: string
    config: string
  }): Promise<void> {
    // Fill model name - use the actual input id from PublicModelList.tsx
    const nameInput = this.page.locator('input#name, input[placeholder*="model"]').first()
    await nameInput.fill(data.name)

    // Fill namespace if provided - use the actual input id from PublicModelList.tsx
    if (data.namespace) {
      const namespaceInput = this.page.locator('input#namespace').first()
      if (await namespaceInput.isVisible()) {
        await namespaceInput.fill(data.namespace)
      }
    }

    // Fill config JSON - use the actual textarea id from PublicModelList.tsx
    const configTextarea = this.page.locator('textarea#config, textarea').first()
    await configTextarea.fill(data.config)
  }

  async submitPublicModelForm(): Promise<void> {
    await this.page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存"), [role="dialog"] button:has-text("Create")'
    )
    await this.waitForLoading()
  }

  async publicModelExists(modelName: string): Promise<boolean> {
    await this.waitForPageLoad()
    const modelCard = this.page.locator(`text="${modelName}"`)
    return await modelCard.isVisible({ timeout: 3000 }).catch(() => false)
  }

  async clickEditPublicModel(modelName: string): Promise<void> {
    const modelCard = this.page.locator(`.space-y-3 > div:has-text("${modelName}")`).first()
    const editButton = modelCard.locator('button[title*="Edit"], button:has-text("Edit")').first()
    await editButton.click()
    await this.waitForDialog()
  }

  async clickDeletePublicModel(modelName: string): Promise<void> {
    const modelCard = this.page.locator(`.space-y-3 > div:has-text("${modelName}")`).first()
    const deleteButton = modelCard
      .locator('button[title*="Delete"], button:has-text("Delete")')
      .first()
    await deleteButton.click()
    await this.waitForDialog()
  }

  // ==================== System Config ====================

  async getSloganCount(): Promise<number> {
    await this.waitForPageLoad()
    const slogans = this.page.locator('[data-testid="slogan-item"], .slogan-item')
    return await slogans.count()
  }

  async clickAddSlogan(): Promise<void> {
    await this.page.click('button:has-text("Add Slogan"), button:has-text("添加标语")')
    await this.waitForDialog()
  }

  async fillSloganForm(data: { title: string; content: string }): Promise<void> {
    const titleInput = this.page.locator('[role="dialog"] textarea').first()
    await titleInput.fill(data.title)

    const contentInput = this.page.locator('[role="dialog"] textarea').nth(1)
    await contentInput.fill(data.content)
  }

  async submitSloganForm(): Promise<void> {
    await this.page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存")'
    )
    await this.waitForLoading()
  }

  async saveSystemConfig(): Promise<void> {
    await this.page.click('button:has-text("Save"), button:has-text("保存")')
    await this.waitForLoading()
  }
}
