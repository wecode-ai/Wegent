import { Page, Locator } from '@playwright/test'
import { BaseTaskPage } from './base-task.page'

/**
 * Chat Task Page Object - /chat route
 * Extends BaseTaskPage with Chat-specific functionality
 */
export class ChatTaskPage extends BaseTaskPage {
  // Chat-specific locators
  private readonly webSearchToggle: Locator
  private readonly exportButton: Locator

  constructor(page: Page) {
    super(page)
    this.webSearchToggle = page.locator('[data-testid="web-search-toggle"]')
    this.exportButton = page.locator(
      'button:has-text("Export"), button:has-text("PDF"), [data-testid="export-chat"]'
    )
  }

  /**
   * Navigate to chat page
   */
  async navigate(): Promise<void> {
    await this.goto('/chat')
  }

  /**
   * Check if currently on chat page
   */
  isOnChatPage(): boolean {
    return this.getCurrentUrl().includes('/chat')
  }

  /**
   * Toggle web search feature (if available)
   */
  async toggleWebSearch(): Promise<void> {
    if (await this.webSearchToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      await this.webSearchToggle.click()
    }
  }

  /**
   * Check if web search toggle is available
   */
  async hasWebSearchToggle(): Promise<boolean> {
    return await this.webSearchToggle.isVisible().catch(() => false)
  }

  /**
   * Export chat as PDF (if available)
   */
  async exportChat(): Promise<void> {
    if (await this.exportButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await this.exportButton.click()
      await this.waitForLoading()
    }
  }

  /**
   * Upload file attachment
   */
  async uploadAttachment(filePath: string): Promise<void> {
    const fileInput = this.page.locator('input[type="file"]')
    await fileInput.setInputFiles(filePath)
    await this.waitForLoading()
  }

  /**
   * Check if file upload is available
   */
  async hasFileUpload(): Promise<boolean> {
    const uploadButton = this.page.locator(
      'button[title*="Upload"], button[title*="Attach"], input[type="file"]'
    )
    return await uploadButton.isVisible().catch(() => false)
  }

  /**
   * Start a new chat session
   */
  async startNewChat(): Promise<void> {
    if (await this.hasNewTaskButton()) {
      await this.createNewTask()
    }
  }

  /**
   * Send a message and wait for response
   */
  async sendMessageAndWaitForResponse(message: string, timeout: number = 30000): Promise<void> {
    await this.sendMessage(message)
    await this.waitForResponse(timeout)
  }

  /**
   * Get the last message content
   */
  async getLastMessage(): Promise<string | null> {
    const messages = await this.getMessages()
    return messages.length > 0 ? messages[messages.length - 1] : null
  }
}
