import assert from 'node:assert/strict'
import { waitForUpdatePreparation } from './update-preparation-progress.mjs'
import { confirmPendingUpdateRetry } from './failed-upgrade-retry.mjs'

/** Reuse the delivered target after rollback and prove credentials written by the bridge survive. */
export async function reupgradeAfterRollback({
  control,
  routeCurrentUpdateRequests,
  about,
  version,
  installedVersion,
  assertSelectedComposition,
  send,
  verifyCredentials,
  timeoutMs,
}) {
  await routeCurrentUpdateRequests()
  await about()
  const button = '[data-testid="about-check-update-button"]'
  const available = (await control.command('clickWhenEnabled', button)).includes(version)
  if (!available) {
    await control.command('waitFor', '[data-testid="about-update-status"]', { text: version })
    await control.command('clickWhenEnabled', button)
  }
  assert.equal(
    await confirmPendingUpdateRetry(control, version),
    true,
    'Re-upgrade requires explicit consent for the quarantined release'
  )
  await waitForUpdatePreparation(async () =>
    JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  )
  await control.command('waitFor', '[data-testid="app-update-restart-confirm"]')
  const beforeRestart = control.readyCount
  await control.command('click', '[data-testid="app-update-restart-confirm"]')
  await control.awaitReadyAfter(beforeRestart, timeoutMs)
  assert.equal(await installedVersion(), version)
  await control.command(
    'waitFor',
    '[data-testid="new-chat-button"], [data-testid="settings-back-button"]',
    { timeoutMs }
  )
  if (
    Number(await control.command('getElementCount', '[data-testid="settings-back-button"]')) > 0
  ) {
    await control.command('click', '[data-testid="settings-back-button"]')
  }
  await verifyCredentials()
  await send('WEWORK_UPGRADE_PERSISTENCE continue after re-upgrade')
  await assertSelectedComposition(version)
}
