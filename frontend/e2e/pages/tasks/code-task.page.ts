import { Page, Locator } from '@playwright/test'
import { BaseTaskPage } from './base-task.page'

/**
 * Code Task Page Object - /code route
 * Extends BaseTaskPage with Code-specific functionality
 * Includes Workbench, repository selector, and code editor features
 */
export class CodeTaskPage extends BaseTaskPage {
  // Code-specific locators
  private readonly repoSelector: Locator
  private readonly workspaceSelector: Locator
  private readonly workbenchToggle: Locator
  private readonly workbenchPanel: Locator
  private readonly fileExplorer: Locator
  private readonly codeEditor: Locator

  constructor(page: Page) {
    super(page)
    this.repoSelector = page
      .locator(
        '[data-testid="repo-selector"], [data-testid="workspace-selector"], [placeholder*="repo" i], [placeholder*="仓库" i]'
      )
      .first()
    this.workspaceSelector = page
      .locator('[data-testid="workspace-selector"], [placeholder*="workspace" i]')
      .first()
    this.workbenchToggle = page.locator(
      'button:has-text("Workbench"), button:has-text("工作台"), [data-testid="workbench-toggle"]'
    )
    this.workbenchPanel = page
      .locator('[data-testid="workbench"], .workbench, [class*="workbench"]')
      .first()
    this.fileExplorer = page
      .locator('[data-testid="file-explorer"], .file-explorer, [class*="file-explorer"]')
      .first()
    this.codeEditor = page
      .locator('[data-testid="code-editor"], .code-editor, .monaco-editor, [class*="editor"]')
      .first()
  }

  /**
   * Navigate to code page
   */
  async navigate(): Promise<void> {
    await this.goto('/code')
  }

  /**
   * Check if currently on code page
   */
  isOnCodePage(): boolean {
    return this.getCurrentUrl().includes('/code')
  }

  /**
   * Check if repository selector is available
   */
  async hasRepoSelector(): Promise<boolean> {
    const count = await this.repoSelector.count()
    if (count === 0) return false
    return await this.repoSelector.isVisible().catch(() => false)
  }

  /**
   * Select a repository/workspace
   */
  async selectRepository(repoName: string): Promise<void> {
    if (await this.hasRepoSelector()) {
      await this.repoSelector.click({ force: true })
      await this.page.waitForTimeout(300)
      const option = this.page.locator(`[role="option"]:has-text("${repoName}")`)
      await option.click()
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * Check if workbench toggle is available
   */
  async hasWorkbenchToggle(): Promise<boolean> {
    return await this.workbenchToggle.isVisible().catch(() => false)
  }

  /**
   * Toggle workbench visibility
   */
  async toggleWorkbench(): Promise<void> {
    if (await this.hasWorkbenchToggle()) {
      await this.workbenchToggle.click()
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * Check if workbench panel is visible
   */
  async isWorkbenchVisible(): Promise<boolean> {
    return await this.workbenchPanel.isVisible().catch(() => false)
  }

  /**
   * Wait for workbench to be visible
   */
  async waitForWorkbench(timeout: number = 5000): Promise<void> {
    await this.workbenchPanel.waitFor({ state: 'visible', timeout })
  }

  /**
   * Check if file explorer is available in workbench
   */
  async hasFileExplorer(): Promise<boolean> {
    return await this.fileExplorer.isVisible().catch(() => false)
  }

  /**
   * Check if code editor is available
   */
  async hasCodeEditor(): Promise<boolean> {
    return await this.codeEditor.isVisible().catch(() => false)
  }

  /**
   * Click on a file in the file explorer
   */
  async openFile(fileName: string): Promise<void> {
    const fileItem = this.page.locator(
      `[data-testid="file-item"]:has-text("${fileName}"), .file-item:has-text("${fileName}")`
    )
    await fileItem.click()
    await this.page.waitForTimeout(500)
  }

  /**
   * Get workbench panel width (useful for testing collapse/expand)
   */
  async getWorkbenchWidth(): Promise<number | null> {
    const box = await this.workbenchPanel.boundingBox()
    return box?.width ?? null
  }

  /**
   * Check if sidebar is collapsed (width < 100)
   */
  async isSidebarCollapsed(): Promise<boolean> {
    const sidebar = this.page.locator('[data-testid="task-sidebar"], aside').first()
    const box = await sidebar.boundingBox()
    return (box?.width ?? 200) < 100
  }

  /**
   * Toggle sidebar collapse
   */
  async toggleSidebar(): Promise<void> {
    const collapseButton = this.page.locator(
      'button[title*="Collapse"], button[title*="收起"], [data-testid="collapse-sidebar"]'
    )
    if (await collapseButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await collapseButton.click()
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * Start a new code task
   */
  async startNewCodeTask(): Promise<void> {
    if (await this.hasNewTaskButton()) {
      await this.createNewTask()
    }
  }

  /**
   * Check if on mobile viewport by looking for mobile menu button
   */
  async isMobileViewport(): Promise<boolean> {
    const mobileMenu = this.page.locator('[data-testid="mobile-menu"], button[aria-label*="menu"]')
    return await mobileMenu.isVisible().catch(() => false)
  }

  /**
   * Open mobile menu (if on mobile viewport)
   */
  async openMobileMenu(): Promise<void> {
    const mobileMenu = this.page.locator('[data-testid="mobile-menu"], button[aria-label*="menu"]')
    if (await mobileMenu.isVisible({ timeout: 3000 }).catch(() => false)) {
      await mobileMenu.click()
      await this.page.waitForTimeout(300)
    }
  }
}
