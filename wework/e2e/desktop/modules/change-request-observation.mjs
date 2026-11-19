const ENVIRONMENT_BUTTON = '[data-testid="environment-info-button"]'

export async function openSynchronizedChangeRequestSummary(control) {
  await control.command('click', ENVIRONMENT_BUTTON)
  await control.command('waitFor', '[data-testid="environment-info-popover"]')
  await control.command('waitFor', '[data-testid="environment-change-request-status"]')
  await control.command('click', '[data-testid="environment-change-request-status"]')
  await control.command(
    'waitFor',
    '[data-testid="environment-change-request-status-popover"] [data-testid="resource-observation-status"]',
    { text: '状态同步正常' }
  )
  await control.command('click', '[data-testid="environment-change-request-status"]')
}
