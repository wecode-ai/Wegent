import { Page, Locator } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Chat Task Page Object
 */
export class ChatTaskPage extends BasePage {
  private readonly chatInput: Locator
  private readonly sendButton: Locator
  private readonly messageList: Locator
  private readonly teamSelector: Locator
  private readonly newChatButton: Locator

  constructor(page: Page) {
    super(page)
    this.chatInput = page.locator(
      '[data-testid="chat-input"], textarea[placeholder*="message" i], textarea[placeholder*="type" i]'
    )
    this.sendButton = page.locator(
      '[data-testid="send-button"], button[type="submit"]:has-text("Send")'
    )
    this.messageList = page.locator('[data-testid="message-list"], .message-list')
    this.teamSelector = page.locator(
      '[data-testid="team-selector"], [role="combobox"]:has-text("Team")'
    )
    this.newChatButton = page.locator('button:has-text("New Chat"), button:has-text("New Task")')
  }

  /**
   * Navigate to chat page
   */
  async navigate(): Promise<void> {
    await this.goto('/chat')
  }

  /**
   * Start a new chat
   */
  async startNewChat(): Promise<void> {
    await this.newChatButton.click()
    await this.waitForLoading()
  }

  /**
   * Select a team for chat
   */
  async selectTeam(teamName: string): Promise<void> {
    await this.teamSelector.click()
    await this.page.click(`[role="option"]:has-text("${teamName}")`)
    await this.waitForLoading()
  }

  /**
   * Type message in chat input
   */
  async typeMessage(message: string): Promise<void> {
    await this.chatInput.fill(message)
  }

  /**
   * Send message
   */
  async sendMessage(message?: string): Promise<void> {
    if (message) {
      await this.typeMessage(message)
    }
    await this.sendButton.click()
    await this.waitForLoading()
  }

  /**
   * Wait for response message
   */
  async waitForResponse(timeout: number = 30000): Promise<void> {
    await this.page.waitForSelector('[data-testid="message-response"], [data-role="assistant"]', {
      timeout,
    })
  }

  /**
   * Get all messages
   */
  async getMessages(): Promise<string[]> {
    const messages = this.page.locator('[data-testid="message-content"], .message-content')
    return await messages.allTextContents()
  }

  /**
   * Get message count
   */
  async getMessageCount(): Promise<number> {
    return await this.page.locator('[data-testid="message"], .message').count()
  }

  /**
   * Check if chat input is enabled
   */
  async isChatInputEnabled(): Promise<boolean> {
    return await this.chatInput.isEnabled()
  }

  /**
   * Clear chat input
   */
  async clearChatInput(): Promise<void> {
    await this.chatInput.clear()
  }

  /**
   * Check if on chat page
   */
  isOnChatPage(): boolean {
    return this.getCurrentUrl().includes('/chat')
  }

  /**
   * Wait for streaming to complete
   */
  async waitForStreamingComplete(timeout: number = 60000): Promise<void> {
    // Wait for streaming indicator to disappear
    await this.page
      .waitForSelector('[data-streaming="true"]', { state: 'detached', timeout })
      .catch(() => {})
    // Or wait for send button to be enabled again
    await this.page
      .waitForSelector('[data-testid="send-button"]:not([disabled])', { timeout })
      .catch(() => {})
  }

  /**
   * Cancel current task
   */
  async cancelTask(): Promise<void> {
    const cancelButton = this.page.locator('button:has-text("Cancel"), button:has-text("Stop")')
    if (await cancelButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelButton.click()
      await this.waitForLoading()
    }
  }

  /**
   * Toggle web search
   */
  async toggleWebSearch(): Promise<void> {
    const webSearchToggle = this.page.locator('[data-testid="web-search-toggle"]')
    if (await webSearchToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      await webSearchToggle.click()
    }
  }

  /**
   * Upload attachment
   */
  async uploadAttachment(filePath: string): Promise<void> {
    const fileInput = this.page.locator('input[type="file"]')
    await fileInput.setInputFiles(filePath)
    await this.waitForLoading()
  }

  /**
   * Export chat as PDF
   */
  async exportPdf(): Promise<void> {
    const exportButton = this.page.locator('button:has-text("Export"), button:has-text("PDF")')
    if (await exportButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await exportButton.click()
      await this.waitForLoading()
    }
  }
}
