import assert from 'node:assert/strict'

const ERROR_SELECTOR = '[data-testid="workbench-crash-error"]'
const COMPOSER_SELECTOR = '[data-testid="desktop-empty-composer-frame"]'
const APPEARANCE_SELECTOR = '[data-testid="appearance-settings-page"]'

async function assertTextTheme(control, selector, token) {
  const color = await control.command('getComputedStyleValue', selector, { value: 'color' })
  const channels = await control.command('getComputedStyleValue', selector, { value: token })
  assert.match(channels, /^\d+\s+\d+\s+\d+$/, `Missing theme token ${token}`)
  assert.equal(
    color,
    `rgb(${channels.trim().replace(/\s+/g, ', ')})`,
    `${selector} lost its theme text color`
  )
}

async function verifyCrashRecovery(control, recoveredSelector) {
  const readyCount = control.readyCount
  await control.command('crashRenderer', 'body')
  await control.command('waitFor', ERROR_SELECTOR)
  const snapshot = await control.command('snapshot', ERROR_SELECTOR)
  assert.match(snapshot, /刷新页面|Refresh page/)
  await assertTextTheme(control, ERROR_SELECTOR, '--color-text-primary')
  await assertTextTheme(control, `${ERROR_SELECTOR} p`, '--color-text-secondary')
  assert.equal(control.readyCount, readyCount, 'The error page must wait for the user to refresh')
  await control.command('click', '[data-testid="workbench-crash-retry"]')
  await control.awaitReadyAfter(readyCount)
  await control.command('waitFor', recoveredSelector)
}

export async function createDesktopScenario() {
  return {
    async verify(control) {
      await control.command('waitFor', COMPOSER_SELECTOR)
      await verifyCrashRecovery(control, COMPOSER_SELECTOR)
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('click', '[data-testid="settings-nav-appearance"]')
      await control.command('waitFor', APPEARANCE_SELECTOR)
      await control.command('click', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await verifyCrashRecovery(control, APPEARANCE_SELECTOR)
    },
  }
}
