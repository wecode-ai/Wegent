import { Page, Locator, expect } from '@playwright/test'
import { SettingsBasePage } from './settings-base.page'

/**
 * Teams Page Object
 */
export class TeamsPage extends SettingsBasePage {
  private readonly createButton: Locator
  private readonly teamCards: Locator

  constructor(page: Page) {
    super(page)
    this.createButton = page.locator('button:has-text("Create Team"), button:has-text("New Team")')
    this.teamCards = page.locator('[data-testid="team-card"], [data-testid="resource-card"]')
  }

  /**
   * Navigate to teams tab
   */
  async navigate(): Promise<void> {
    await super.navigate('team')
  }

  /**
   * Click create team button
   */
  async clickCreateTeam(): Promise<void> {
    await this.createButton.click()
    await this.waitForDialog()
  }

  /**
   * Fill team creation form
   */
  async fillTeamForm(teamData: {
    name: string
    description?: string
    collaborationModel?: string
    members?: Array<{ botName: string; role?: string }>
  }): Promise<void> {
    // Fill name
    await this.page.fill('input[name="name"], input[placeholder*="name" i]', teamData.name)

    // Fill description
    if (teamData.description) {
      await this.page.fill('textarea[name="description"]', teamData.description)
    }

    // Select collaboration model
    if (teamData.collaborationModel) {
      const modeSelector = this.page.locator(
        '[data-testid="mode-select"], [role="combobox"]:has-text("Mode")'
      )
      if (await modeSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
        await modeSelector.click()
        await this.page.click(`[role="option"]:has-text("${teamData.collaborationModel}")`)
      }
    }

    // Add members if provided
    if (teamData.members && teamData.members.length > 0) {
      for (const member of teamData.members) {
        await this.addMember(member.botName, member.role)
      }
    }
  }

  /**
   * Add a member to the team
   */
  async addMember(botName: string, role?: string): Promise<void> {
    // Click add member button
    await this.page.click('button:has-text("Add Member"), button:has-text("Add Bot")')

    // Select bot
    const botSelector = this.page.locator(
      '[data-testid="bot-select"], [role="combobox"]:has-text("Bot")'
    )
    await botSelector.click()
    await this.page.click(`[role="option"]:has-text("${botName}")`)

    // Set role if provided
    if (role) {
      await this.page.fill('input[name="role"], input[placeholder*="role" i]', role)
    }
  }

  /**
   * Submit team creation form
   */
  async submitTeamForm(): Promise<void> {
    await this.page.click(
      'button:has-text("Create"), button:has-text("Save"), button[type="submit"]'
    )
    await this.waitForLoading()
  }

  /**
   * Create a new team
   */
  async createTeam(teamData: {
    name: string
    description?: string
    collaborationModel?: string
    members?: Array<{ botName: string; role?: string }>
  }): Promise<void> {
    await this.clickCreateTeam()
    await this.fillTeamForm(teamData)
    await this.submitTeamForm()
    await this.waitForToast()
  }

  /**
   * Get team card by name
   */
  getTeamCard(name: string): Locator {
    return this.page.locator(
      `[data-testid="team-card"]:has-text("${name}"), [data-testid="resource-card"]:has-text("${name}")`
    )
  }

  /**
   * Check if team exists
   */
  async teamExists(name: string): Promise<boolean> {
    const card = this.getTeamCard(name)
    return await card.isVisible({ timeout: 3000 }).catch(() => false)
  }

  /**
   * Edit a team
   */
  async editTeam(name: string): Promise<void> {
    const card = this.getTeamCard(name)
    await card.locator('[data-testid="edit-button"], button:has-text("Edit")').click()
    await this.waitForDialog()
  }

  /**
   * Delete a team
   */
  async deleteTeam(name: string): Promise<void> {
    const card = this.getTeamCard(name)
    await card.locator('[data-testid="delete-button"], button:has-text("Delete")').click()
    await this.waitForDialog()
    await this.confirmDialog('Delete')
    await this.waitForToast()
  }

  /**
   * Get number of team cards
   */
  async getTeamCount(): Promise<number> {
    return await this.teamCards.count()
  }

  /**
   * Search for team
   */
  async searchTeam(name: string): Promise<void> {
    await this.search(name)
  }

  /**
   * Verify team card is visible
   */
  async expectTeamVisible(name: string): Promise<void> {
    await expect(this.getTeamCard(name)).toBeVisible()
  }

  /**
   * Share team
   */
  async shareTeam(name: string): Promise<void> {
    const card = this.getTeamCard(name)
    await card.locator('[data-testid="share-button"], button:has-text("Share")').click()
    await this.waitForDialog()
  }
}
