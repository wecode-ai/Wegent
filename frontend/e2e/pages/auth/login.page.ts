import { Page, Locator } from '@playwright/test'
import { BasePage } from '../base.page'

/**
 * Login Page Object
 */
export class LoginPage extends BasePage {
  private readonly usernameInput: Locator
  private readonly passwordInput: Locator
  private readonly loginButton: Locator
  private readonly errorMessage: Locator

  constructor(page: Page) {
    super(page)
    this.usernameInput = page
      .locator('input[name="user_name"], input[name="username"], input[type="text"]')
      .first()
    this.passwordInput = page.locator('input[name="password"], input[type="password"]').first()
    this.loginButton = page.locator('button[type="submit"]')
    this.errorMessage = page.locator(
      '.error, [data-error], [role="alert"]:not([data-sonner-toaster])'
    )
  }

  /**
   * Navigate to login page
   */
  async navigate(): Promise<void> {
    await this.goto('/login')
  }

  /**
   * Fill login form
   */
  async fillCredentials(username: string, password: string): Promise<void> {
    await this.usernameInput.clear()
    await this.usernameInput.fill(username)
    await this.passwordInput.clear()
    await this.passwordInput.fill(password)
  }

  /**
   * Click login button
   */
  async clickLogin(): Promise<void> {
    await this.loginButton.click()
  }

  /**
   * Perform complete login
   */
  async login(username: string, password: string): Promise<void> {
    await this.navigate()
    await this.waitForSelector(
      'input[name="user_name"], input[name="username"], input[type="text"]'
    )
    await this.fillCredentials(username, password)

    // Set up response listener
    const responsePromise = this.page.waitForResponse(
      response => response.url().includes('/api/auth/login'),
      { timeout: 30000 }
    )

    await this.clickLogin()
    await responsePromise

    // Wait for redirect after successful login
    await this.page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30000 })
  }

  /**
   * Check if login form is visible
   */
  async isLoginFormVisible(): Promise<boolean> {
    return await this.usernameInput.isVisible()
  }

  /**
   * Get error message text
   */
  async getErrorMessage(): Promise<string | null> {
    if (await this.errorMessage.isVisible({ timeout: 3000 }).catch(() => false)) {
      return await this.errorMessage.textContent()
    }
    return null
  }

  /**
   * Check if currently on login page
   */
  isOnLoginPage(): boolean {
    return this.getCurrentUrl().includes('/login')
  }

  /**
   * Wait for login to complete and redirect
   */
  async waitForLoginComplete(timeout: number = 30000): Promise<void> {
    await this.page.waitForURL(url => !url.pathname.includes('/login'), { timeout })
  }
}
