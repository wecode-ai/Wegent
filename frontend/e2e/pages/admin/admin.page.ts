import { Page } from '@playwright/test';
import { BasePage } from '../base.page';

/**
 * Admin Page Object
 * Handles admin panel interactions
 */
export class AdminPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // Navigation
  async navigate(): Promise<void> {
    await this.goto('/admin');
  }

  async navigateToTab(tab: 'users' | 'public-models' | 'system-config'): Promise<void> {
    await this.goto(`/admin?tab=${tab}`);
    // Wait for network to be idle instead of fixed timeout
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  // Tab navigation
  async clickTab(tabName: string): Promise<void> {
    await this.page.click(`button:has-text("${tabName}"), [role="tab"]:has-text("${tabName}")`);
    await this.waitForPageLoad();
  }

  isOnAdminPage(): boolean {
    return this.page.url().includes('/admin');
  }

  // Access denied check
  async isAccessDenied(): Promise<boolean> {
    const accessDenied = await this.page
      .locator('text=Access Denied, text=访问被拒绝, h1:has-text("Access")')
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    return accessDenied;
  }

  // ==================== User Management ====================

  async getUserCount(): Promise<number> {
    await this.waitForPageLoad();
    const cards = this.page.locator('[data-testid="user-card"], .user-card, .space-y-3 > div');
    return await cards.count();
  }

  async clickCreateUser(): Promise<void> {
    await this.page.click('button:has-text("Create User"), button:has-text("新建用户")');
    await this.waitForDialog();
  }

  async fillUserForm(data: {
    username: string;
    email?: string;
    password?: string;
    role?: 'admin' | 'user';
  }): Promise<void> {
    // Fill username
    const usernameInput = this.page.locator('input[placeholder*="user"], input#user_name').first();
    await usernameInput.fill(data.username);

    // Fill email if provided
    if (data.email) {
      const emailInput = this.page.locator('input[type="email"], input#email').first();
      if (await emailInput.isVisible()) {
        await emailInput.fill(data.email);
      }
    }

    // Fill password if provided
    if (data.password) {
      const passwordInput = this.page.locator('input[type="password"]').first();
      if (await passwordInput.isVisible()) {
        await passwordInput.fill(data.password);
      }
    }

    // Select role if provided
    if (data.role) {
      const roleSelect = this.page.locator('[role="combobox"]').first();
      if (await roleSelect.isVisible()) {
        await roleSelect.click();
        await this.page.click(`[role="option"]:has-text("${data.role}")`);
      }
    }
  }

  async submitUserForm(): Promise<void> {
    await this.page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存"), [role="dialog"] button:has-text("Create")'
    );
    await this.waitForLoading();
  }

  async searchUser(searchTerm: string): Promise<void> {
    const searchInput = this.page
      .locator('input[placeholder*="search"], input[placeholder*="搜索"]')
      .first();
    await searchInput.fill(searchTerm);
    await this.page.waitForTimeout(500); // Debounce
  }

  async userExists(username: string): Promise<boolean> {
    await this.waitForPageLoad();
    const userCard = this.page.locator(`text="${username}"`);
    return await userCard.isVisible({ timeout: 3000 }).catch(() => false);
  }

  async clickEditUser(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first();
    const editButton = userCard.locator('button[title*="Edit"], button:has-text("Edit")').first();
    await editButton.click();
    await this.waitForDialog();
  }

  async clickDeleteUser(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first();
    const deleteButton = userCard
      .locator('button[title*="Delete"], button:has-text("Delete")')
      .first();
    await deleteButton.click();
    await this.waitForDialog();
  }

  async confirmDelete(): Promise<void> {
    await this.page.click(
      '[role="alertdialog"] button:has-text("Delete"), [role="alertdialog"] button:has-text("删除"), [role="alertdialog"] button:has-text("Continue")'
    );
    await this.waitForLoading();
  }

  async toggleUserStatus(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first();
    const toggleButton = userCard
      .locator('button[title*="Toggle"], button[title*="Status"]')
      .first();
    await toggleButton.click();
    await this.waitForLoading();
  }

  async resetUserPassword(username: string): Promise<void> {
    const userCard = this.page.locator(`.space-y-3 > div:has-text("${username}")`).first();
    const resetButton = userCard
      .locator('button[title*="Reset"], button:has-text("Reset")')
      .first();
    await resetButton.click();
    await this.waitForDialog();
  }

  // ==================== Public Model Management ====================

  async getPublicModelCount(): Promise<number> {
    await this.waitForPageLoad();
    const cards = this.page.locator('[data-testid="model-card"], .model-card, .space-y-3 > div');
    return await cards.count();
  }

  async clickCreatePublicModel(): Promise<void> {
    await this.page.click(
      'button:has-text("Create Model"), button:has-text("新建模型"), button:has-text("Add Model")'
    );
    await this.waitForDialog();
  }

  async fillPublicModelForm(data: {
    name: string;
    displayName?: string;
    config: string;
  }): Promise<void> {
    // Fill model name
    const nameInput = this.page.locator('input[placeholder*="model"], input#name').first();
    await nameInput.fill(data.name);

    // Fill display name if provided
    if (data.displayName) {
      const displayNameInput = this.page
        .locator('input[placeholder*="display"], input#display_name')
        .first();
      if (await displayNameInput.isVisible()) {
        await displayNameInput.fill(data.displayName);
      }
    }

    // Fill config JSON
    const configTextarea = this.page.locator('textarea').first();
    await configTextarea.fill(data.config);
  }

  async submitPublicModelForm(): Promise<void> {
    await this.page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存"), [role="dialog"] button:has-text("Create")'
    );
    await this.waitForLoading();
  }

  async publicModelExists(modelName: string): Promise<boolean> {
    await this.waitForPageLoad();
    const modelCard = this.page.locator(`text="${modelName}"`);
    return await modelCard.isVisible({ timeout: 3000 }).catch(() => false);
  }

  async clickEditPublicModel(modelName: string): Promise<void> {
    const modelCard = this.page.locator(`.space-y-3 > div:has-text("${modelName}")`).first();
    const editButton = modelCard.locator('button[title*="Edit"], button:has-text("Edit")').first();
    await editButton.click();
    await this.waitForDialog();
  }

  async clickDeletePublicModel(modelName: string): Promise<void> {
    const modelCard = this.page.locator(`.space-y-3 > div:has-text("${modelName}")`).first();
    const deleteButton = modelCard
      .locator('button[title*="Delete"], button:has-text("Delete")')
      .first();
    await deleteButton.click();
    await this.waitForDialog();
  }

  // ==================== System Config ====================

  async getSloganCount(): Promise<number> {
    await this.waitForPageLoad();
    const slogans = this.page.locator('[data-testid="slogan-item"], .slogan-item');
    return await slogans.count();
  }

  async clickAddSlogan(): Promise<void> {
    await this.page.click('button:has-text("Add Slogan"), button:has-text("添加标语")');
    await this.waitForDialog();
  }

  async fillSloganForm(data: { title: string; content: string }): Promise<void> {
    const titleInput = this.page.locator('[role="dialog"] textarea').first();
    await titleInput.fill(data.title);

    const contentInput = this.page.locator('[role="dialog"] textarea').nth(1);
    await contentInput.fill(data.content);
  }

  async submitSloganForm(): Promise<void> {
    await this.page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存")'
    );
    await this.waitForLoading();
  }

  async saveSystemConfig(): Promise<void> {
    await this.page.click('button:has-text("Save"), button:has-text("保存")');
    await this.waitForLoading();
  }
}
