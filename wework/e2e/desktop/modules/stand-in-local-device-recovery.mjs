const testId = id => `[data-testid=${JSON.stringify(id)}]`

/** Reuse the local stand-in checkpoint to verify recovery without cloud devices. */
export async function verifyStandInLocalDeviceRecovery(control, conversationSelector) {
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', testId('cloud-work-devices-empty'))
  await control.command('waitFor', testId('cloud-work-local-device-guidance'))
  await control.command('clickWhenEnabled', testId('cloud-work-local-version-button'))
  await control.command('waitFor', testId('about-settings-page'))
  await control.command('waitFor', testId('about-app-version'), { text: 'v' })
  await control.command('clickWhenEnabled', testId('settings-back-button'))
  await control.command('waitFor', testId('cloud-work-page'))
  await control.command('waitFor', testId('cloud-work-devices-empty'))
  await control.command('clickWhenEnabled', testId('personal-stand-in-button'))
  await control.command('waitFor', conversationSelector)
}
