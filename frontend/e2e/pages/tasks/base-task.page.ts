import { Page, Locator } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Base Task Page - Shared functionality between Chat and Code pages
 * Both /chat and /code routes share common UI elements like:
 * - Team selector
 * - Message input
 - Send button
 * - Task sidebar
 * - Message list
 */
export abstract class BaseTaskPage extends BasePage {
  // Common locators shared between Chat and Code pages
  protected readonly messageInput: Locator
  protected readonly sendButton: Locator
  protected readonly teamSelector: Locator
  protected readonly taskSidebar: Locator
  protected readonly messageList: Locator
  protected readonly newTaskButton: Locator

  constructor(page: Page) {
    super(page)
    this.messageInput = page
      .locator(
        '[data-testid="message-input"], textarea[placeholder*="message" i], textarea[placeholder*="type" i], textarea'
      )
      .first()
    this.sendButton = page
      .locator(
        '[data-testid="send-button"], button[type="submit"]:has-text("Send"), button[type="submit"]:has-text("发送")'
      )
      .first()
    this.teamSelector = page
      .locator(
        '[data-testid="team-selector"], [data-tour="team-selector"] [role="combobox"], [role="combobox"]'
      )
      .first()
    this.taskSidebar = page
      .locator('[data-testid="task-sidebar"], [data-testid="conversation-list"], aside')
      .first()
    this.messageList = page
      .locator('[data-testid="message-list"], [data-testid="messages"], .message-list')
      .first()
    this.newTaskButton = page
      .locator(
        'button:has-text("New"), button:has-text("新建"), [data-testid="new-task"], [data-testid="new-chat"]'
      )
      .first()
  }

  /**
   * Check if message input is visible and enabled
   */
  async isMessageInputReady(): Promise<boolean> {
    try {
      await this.messageInput.waitFor({ state: 'visible', timeout: 5000 })
      return await this.messageInput.isEnabled()
    } catch {
      return false
    }
  }

  /**
   * Type a message in the input field
   */
  async typeMessage(message: string): Promise<void> {
    await this.messageInput.fill(message)
  }

  /**
   * Send the current message
   */
  async sendMessage(message?: string): Promise<void> {
    if (message) {
      await this.typeMessage(message)
    }
    await this.sendButton.click()
  }

  /**
   * Check if team selector is available
   */
  async hasTeamSelector(): Promise<boolean> {
    const count = await this.teamSelector.count()
    if (count === 0) return false
    return await this.teamSelector.isVisible().catch(() => false)
  }

  /**
   * Select a team by name
   */
  async selectTeam(teamName: string): Promise<void> {
    // Click to open dropdown
    await this.teamSelector.click({ force: true })

    // Wait for dropdown to open with options
    await this.page.waitForSelector('[role="listbox"], [role="dropdown"], [data-state="open"]', {
      timeout: 5000,
    })

    // Wait for the specific option to be visible
    const option = this.page.locator(`[role="option"]:has-text("${teamName}")`).first()

    // Wait for option to be ready and click
    await option.waitFor({ state: 'visible', timeout: 10000 })
    await option.click()

    // Wait for selection to complete
    await this.page.waitForTimeout(500)
  }

  /**
   * Get the currently selected team name
   */
  async getSelectedTeam(): Promise<string | null> {
    try {
      return await this.teamSelector.textContent()
    } catch {
      return null
    }
  }

  /**
   * Click new task button to create a new task
   */
  async createNewTask(): Promise<void> {
    await this.newTaskButton.click()
    await this.waitForLoading()
  }

  /**
   * Check if new task button is visible
   */
  async hasNewTaskButton(): Promise<boolean> {
    return await this.newTaskButton.isVisible().catch(() => false)
  }

  /**
   * Wait for a response message to appear
   */
  async waitForResponse(timeout: number = 30000): Promise<void> {
    // Get current message count first, then wait for a new message to appear
    const currentCount = await this.getMessageCount()
    await this.page.waitForFunction(
      previousCount => {
        const messages = document.querySelectorAll(
          '[data-testid="message"], [data-role="assistant"], .message'
        )
        return messages.length > previousCount
      },
      currentCount,
      { timeout }
    )
  }

  /**
   * Get all message contents
   */
  async getMessages(): Promise<string[]> {
    const messages = this.page.locator(
      '[data-testid="message-content"], .message-content, [data-testid="message"]'
    )
    return await messages.allTextContents()
  }

  /**
   * Get the count of messages
   */
  async getMessageCount(): Promise<number> {
    return await this.page.locator('[data-testid="message"], .message').count()
  }

  /**
   * Check if task sidebar is visible
   */
  async isSidebarVisible(): Promise<boolean> {
    return await this.taskSidebar.isVisible().catch(() => false)
  }

  /**
   * Click on a task in the sidebar by index
   */
  async selectTaskByIndex(index: number = 0): Promise<void> {
    const taskItems = this.page.locator('[data-testid="task-item"], .task-item')
    await taskItems.nth(index).click()
    await this.waitForLoading()
  }

  /**
   * Get the number of tasks in the sidebar
   */
  async getTaskCount(): Promise<number> {
    return await this.page.locator('[data-testid="task-item"], .task-item').count()
  }

  /**
   * Cancel current running task
   */
  async cancelTask(): Promise<void> {
    const cancelButton = this.page.locator(
      'button:has-text("Cancel"), button:has-text("Stop"), button:has-text("取消"), [data-testid="cancel-task"]'
    )
    if (await cancelButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelButton.click()
      await this.waitForLoading()
    }
  }

  /**
   * Check if there's a visible cancel button
   */
  async hasCancelButton(): Promise<boolean> {
    return await this.page
      .locator('button:has-text("Cancel"), button:has-text("取消"), [data-testid="cancel-task"]')
      .isVisible()
      .catch(() => false)
  }

  /**
   * Wait for streaming/loading to complete
   */
  async waitForStreamingComplete(timeout: number = 60000): Promise<void> {
    await this.page.waitForSelector('[data-streaming="true"], .streaming', {
      state: 'detached',
      timeout,
    })
    await this.page.waitForSelector('[data-testid="send-button"]:not([disabled])', { timeout })
  }

  /**
   * Check if streaming is in progress
   */
  async isStreaming(): Promise<boolean> {
    const streamingIndicator = this.page.locator(
      '[data-streaming="true"], .streaming, [class*="loading"]'
    )
    return await streamingIndicator.isVisible().catch(() => false)
  }
}
