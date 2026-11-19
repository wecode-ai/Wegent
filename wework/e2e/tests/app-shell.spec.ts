import { expect, test } from '../fixtures/collected-test'
import { WeworkApp } from '../fixtures/wework-app'

test('exposes a CI automation bridge and renders the login route', async ({ page, errors }) => {
  const app = new WeworkApp(page)

  const sessionResponse = page.waitForResponse(
    response => new URL(response.url()).pathname === '/api/users/me'
  )
  // The anonymous handshake belongs to the login route, independently of dev StrictMode.
  await app.goto('/login')
  errors.expectHttpError(await sessionResponse, 401)
  await app.goto('/')

  await expect(page.getByTestId('login-form')).toBeVisible()
  await expect(page.getByTestId('login-username-input')).toBeVisible()
  await expect(page.getByTestId('login-password-input')).toBeVisible()

  await expect.poll(() => app.route()).toBe('/login')
  await expect.poll(async () => (await app.runtimeConfig())?.runtimeMode).toBe('backend')

  const loginTestIds = await app.testIds('login-')
  expect(loginTestIds).toContain('login-form')
  expect(loginTestIds).toContain('login-submit-button')
})
