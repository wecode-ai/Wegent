import { expect, test } from '@playwright/test'
import { WeworkApp } from '../fixtures/wework-app'

test('exposes a CI automation bridge and renders the login route', async ({ page }) => {
  const app = new WeworkApp(page)

  const sessionResponse = page.waitForResponse(
    response => new URL(response.url()).pathname === '/api/users/me'
  )
  await app.goto('/')
  expect((await sessionResponse).status()).toBe(401)

  await expect(page.getByTestId('login-form')).toBeVisible()
  await expect(page.getByTestId('login-username-input')).toBeVisible()
  await expect(page.getByTestId('login-password-input')).toBeVisible()

  await expect.poll(() => app.route()).toBe('/login')
  await expect.poll(async () => (await app.runtimeConfig())?.runtimeMode).toBe('backend')

  const loginTestIds = await app.testIds('login-')
  expect(loginTestIds).toContain('login-form')
  expect(loginTestIds).toContain('login-submit-button')
})
