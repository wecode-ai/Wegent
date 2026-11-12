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
