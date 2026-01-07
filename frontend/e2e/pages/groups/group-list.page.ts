import { Page, Locator } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Groups Page Object
 */
export class GroupsPage extends BasePage {
  private readonly createButton: Locator
  private readonly groupList: Locator

  constructor(page: Page) {
    super(page)
    this.createButton = page.locator(
      'button:has-text("Create Group"), button:has-text("New Group")'
    )
    this.groupList = page.locator('[data-testid="group-list"], .group-list')
  }

  /**
   * Navigate to groups page (usually in settings)
   */
  async navigate(): Promise<void> {
    await this.goto('/settings?tab=groups')
  }

  /**
   * Click create group button
   */
  async clickCreateGroup(): Promise<void> {
    await this.createButton.click()
    await this.waitForDialog()
  }

  /**
   * Fill group creation form
   */
  async fillGroupForm(groupData: {
    name: string
    displayName?: string
    description?: string
    visibility?: string
  }): Promise<void> {
    // Fill name
    await this.page.fill('input[name="name"], input[placeholder*="name" i]', groupData.name)

    // Fill display name
    if (groupData.displayName) {
      await this.page.fill('input[name="display_name"]', groupData.displayName)
    }

    // Fill description
    if (groupData.description) {
      await this.page.fill('textarea[name="description"]', groupData.description)
    }

    // Select visibility
    if (groupData.visibility) {
      const visibilitySelector = this.page.locator(
        '[data-testid="visibility-select"], [role="combobox"]:has-text("Visibility")'
      )
      if (await visibilitySelector.isVisible({ timeout: 2000 }).catch(() => false)) {
        await visibilitySelector.click()
        await this.page.click(`[role="option"]:has-text("${groupData.visibility}")`)
      }
    }
  }

  /**
   * Submit group creation form
   */
  async submitGroupForm(): Promise<void> {
    await this.page.click(
      'button:has-text("Create"), button:has-text("Save"), button[type="submit"]'
    )
    await this.waitForLoading()
  }

  /**
   * Create a new group
   */
  async createGroup(groupData: {
    name: string
    displayName?: string
    description?: string
    visibility?: string
  }): Promise<void> {
    await this.clickCreateGroup()
    await this.fillGroupForm(groupData)
    await this.submitGroupForm()
    await this.waitForToast()
  }

  /**
   * Get group item by name
   */
  getGroupItem(name: string): Locator {
    return this.page.locator(
      `[data-testid="group-item"]:has-text("${name}"), .group-item:has-text("${name}")`
    )
  }

  /**
   * Check if group exists
   */
  async groupExists(name: string): Promise<boolean> {
    const item = this.getGroupItem(name)
    return await item.isVisible({ timeout: 3000 }).catch(() => false)
  }

  /**
   * Open group details
   */
  async openGroup(name: string): Promise<void> {
    const item = this.getGroupItem(name)
    await item.click()
    await this.waitForLoading()
  }

  /**
   * Delete a group
   */
  async deleteGroup(name: string): Promise<void> {
    const item = this.getGroupItem(name)
    await item.locator('[data-testid="delete-button"], button:has-text("Delete")').click()
    await this.waitForDialog()
    await this.confirmDialog('Delete')
    await this.waitForToast()
  }

  /**
   * Open members dialog
   */
  async openMembersDialog(name: string): Promise<void> {
    const item = this.getGroupItem(name)
    await item.locator('[data-testid="members-button"], button:has-text("Members")').click()
    await this.waitForDialog()
  }

  /**
   * Add member to group
   */
  async addMember(userId: number, role: string): Promise<void> {
    await this.page.click('button:has-text("Add Member")')

    // Select user
    const userSelector = this.page.locator('[data-testid="user-select"]')
    await userSelector.click()
    await this.page.click(`[role="option"][data-user-id="${userId}"]`)

    // Select role
    const roleSelector = this.page.locator('[data-testid="role-select"]')
    await roleSelector.click()
    await this.page.click(`[role="option"]:has-text("${role}")`)

    await this.page.click('button:has-text("Add")')
    await this.waitForLoading()
  }

  /**
   * Get member count
   */
  async getMemberCount(groupName: string): Promise<number> {
    const item = this.getGroupItem(groupName)
    const countText = await item.locator('[data-testid="member-count"]').textContent()
    return parseInt(countText || '0', 10)
  }

  /**
   * Get all group names
   */
  async getAllGroupNames(): Promise<string[]> {
    const items = this.page.locator(
      '[data-testid="group-item"] [data-testid="group-name"], .group-item .group-name'
    )
    return await items.allTextContents()
  }
}
