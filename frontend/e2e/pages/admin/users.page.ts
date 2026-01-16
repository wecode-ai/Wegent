import { Page, Locator } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Admin Users Page Object
 */
export class AdminUsersPage extends BasePage {
  private readonly createButton: Locator
  private readonly userTable: Locator
  private readonly searchInput: Locator

  constructor(page: Page) {
    super(page)
    this.createButton = page.locator(
      'button:has-text("Create User"), button:has-text("New User"), button:has-text("Add User")'
    )
    this.userTable = page.locator('[data-testid="users-table"], table')
    this.searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]')
  }

  /**
   * Navigate to admin users page
   */
  async navigate(): Promise<void> {
    await this.goto('/admin')
  }

  /**
   * Click create user button
   */
  async clickCreateUser(): Promise<void> {
    await this.createButton.click()
    await this.waitForDialog()
  }

  /**
   * Fill user creation form
   */
  async fillUserForm(userData: {
    username: string
    email?: string
    password: string
    role?: string
  }): Promise<void> {
    // Fill username
    await this.page.fill('input[name="user_name"], input[name="username"]', userData.username)

    // Fill email
    if (userData.email) {
      await this.page.fill('input[name="email"]', userData.email)
    }

    // Fill password
    await this.page.fill('input[name="password"], input[type="password"]', userData.password)

    // Select role
    if (userData.role) {
      const roleSelector = this.page.locator(
        '[data-testid="role-select"], [role="combobox"]:has-text("Role")'
      )
      if (await roleSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
        await roleSelector.click()
        await this.page.click(`[role="option"]:has-text("${userData.role}")`)
      }
    }
  }

  /**
   * Submit user creation form
   */
  async submitUserForm(): Promise<void> {
    await this.page.click(
      'button:has-text("Create"), button:has-text("Save"), button[type="submit"]'
    )
    await this.waitForLoading()
  }

  /**
   * Create a new user
   */
  async createUser(userData: {
    username: string
    email?: string
    password: string
    role?: string
  }): Promise<void> {
    await this.clickCreateUser()
    await this.fillUserForm(userData)
    await this.submitUserForm()
    await this.waitForToast()
  }

  /**
   * Search for user
   */
  async searchUser(query: string): Promise<void> {
    await this.searchInput.fill(query)
    await this.waitForLoading()
  }

  /**
   * Get user row by username
   */
  getUserRow(username: string): Locator {
    return this.page.locator(
      `tr:has-text("${username}"), [data-testid="user-row"]:has-text("${username}")`
    )
  }

  /**
   * Check if user exists
   */
  async userExists(username: string): Promise<boolean> {
    await this.searchUser(username)
    const row = this.getUserRow(username)
    return await row.isVisible({ timeout: 3000 }).catch(() => false)
  }

  /**
   * Edit a user
   */
  async editUser(username: string): Promise<void> {
    const row = this.getUserRow(username)
    await row.locator('[data-testid="edit-button"], button:has-text("Edit")').click()
    await this.waitForDialog()
  }

  /**
   * Delete a user
   */
  async deleteUser(username: string): Promise<void> {
    const row = this.getUserRow(username)
    await row.locator('[data-testid="delete-button"], button:has-text("Delete")').click()
    await this.waitForDialog()
    await this.confirmDialog('Delete')
    await this.waitForToast()
  }

  /**
   * Reset user password
   */
  async resetpassword(username: string): Promise<void> {
    const row = this.getUserRow(username)
    await row.locator('[data-testid="reset-password-button"], button:has-text("Reset")').click()
    await this.waitForDialog()
    await this.confirmDialog()
    await this.waitForToast()
  }

  /**
   * Toggle user status (activate/deactivate)
   */
  async toggleUserStatus(username: string): Promise<void> {
    const row = this.getUserRow(username)
    await row.locator('[data-testid="toggle-status-button"], button:has-text("Toggle")').click()
    await this.waitForLoading()
    await this.waitForToast()
  }

  /**
   * Change user role
   */
  async changeUserRole(username: string, newRole: string): Promise<void> {
    const row = this.getUserRow(username)
    const roleSelector = row.locator('[data-testid="role-select"]')
    await roleSelector.click()
    await this.page.click(`[role="option"]:has-text("${newRole}")`)
    await this.waitForLoading()
  }

  /**
   * Get user count
   */
  async getUserCount(): Promise<number> {
    return await this.page.locator('tr[data-testid="user-row"], tbody tr').count()
  }

  /**
   * Check if user is active
   */
  async isUserActive(username: string): Promise<boolean> {
    const row = this.getUserRow(username)
    const statusBadge = row.locator('[data-testid="status-badge"]')
    const statusText = await statusBadge.textContent()
    return statusText?.toLowerCase().includes('active') || false
  }

  /**
   * Get user role
   */
  async getUserRole(username: string): Promise<string> {
    const row = this.getUserRow(username)
    const roleBadge = row.locator('[data-testid="role-badge"]')
    return (await roleBadge.textContent()) || ''
  }
}
