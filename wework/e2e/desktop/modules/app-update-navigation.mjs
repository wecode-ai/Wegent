import { waitForValue } from './workspace-agent-setup.mjs'

/** Open About through the visible navigation of the current desktop surface. */
export async function openAboutSettings(control) {
  if (
    Number(await control.command('getElementCount', '[data-testid="wework-settings-page"]')) > 0
  ) {
    await control.command('clickWhenEnabled', '[data-testid="settings-nav-about"]')
  } else {
    await control.command('clickWhenEnabled', '[data-testid="settings-button"]')
    await control.command('clickWhenEnabled', '[data-testid="about-menu-button"]')
  }
  await control.command('waitFor', '[data-testid="about-settings-page"]')
}

export async function dismissPreparedUpdateDialog(control, confirmId) {
  const cancelId = `${confirmId}-cancel-button`
  await waitForValue(
    () => control.command('getActiveElementTestId', 'body'),
    id => id === cancelId,
    `Opening ${confirmId} should focus Cancel`,
    5_000
  )
  await control.command('nativePress', `[data-testid="${cancelId}"]`, { key: 'Escape' })
  await waitForValue(
    () => control.command('getElementCount', `[data-testid="${confirmId}"]`),
    count => Number(count) === 0,
    `Escape should dismiss ${confirmId}`,
    5_000
  )
}
