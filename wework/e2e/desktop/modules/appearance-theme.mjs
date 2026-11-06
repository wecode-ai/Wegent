import assert from 'node:assert/strict'

/** Select through the real settings UI, then return to the caller's route. */
export async function selectWorkbenchTheme(
  control,
  { mode = 'dark', themeId = 'tokyo-night', timeoutMs = 30_000 } = {}
) {
  const previousRoute = await control.command('getRoute', 'body')
  await control.command('navigate', 'body', { value: '/settings/appearance' })
  await control.command('waitFor', '[data-testid="appearance-settings-page"]', { timeoutMs })
  await control.command('click', `[data-testid="appearance-mode-${mode}"]`)
  await control.command('select', `[data-testid="appearance-theme-select-${mode}"]`, {
    value: themeId,
  })
  await control.command(
    'waitFor',
    `html[data-theme="${mode}"][data-appearance-theme="${themeId}"]`,
    {
      timeoutMs,
    }
  )
  assert.equal(
    await control.command('getValue', `[data-testid="appearance-theme-select-${mode}"]`),
    themeId,
    'The actual theme selector did not retain its selection'
  )
  if (previousRoute !== '/settings/appearance') {
    await control.command('navigate', 'body', { value: previousRoute })
  }
}
