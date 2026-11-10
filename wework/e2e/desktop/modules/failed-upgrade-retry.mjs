import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForUpdatePreparation } from './update-preparation-progress.mjs'
import { verifyCrossSlotProfile } from './cross-slot-profile.mjs'
import { processIsAlive } from '../process-lifecycle.mjs'

const UPDATE_BUTTON = '[data-testid="about-check-update-button"]'
const RETRY_DIALOG = '[data-testid="app-update-retry-dialog"]'
const RETRY_CONFIRM = '[data-testid="app-update-retry-confirm"]'
const RETRY_CANCEL = '[data-testid="app-update-retry-cancel"]'

/** A delivered source may require its rollback confirmation before preparation can start. */
export async function confirmPendingUpdateRetry(control, version) {
  const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  const confirmation = progress.update?.retryConfirmation
  if (!confirmation) return false
  assert.equal(confirmation.version, version, 'Retry confirmation identifies another target')
  await control.command('waitFor', RETRY_DIALOG, { text: version })
  await control.command('clickWhenEnabled', RETRY_CONFIRM)
  return true
}

export async function quitActiveRelease(control, root) {
  const pid = Number(await readFile(join(root, 'active-pid'), 'utf8'))
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'The active release must identify its process')
  const snapshot = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
  assert.equal(snapshot.applicationPid, pid, 'The controller is connected to another release')
  await control.command('quitApp', 'body')
  const deadline = Date.now() + 10_000
  while (processIsAlive(pid) && Date.now() < deadline)
    await new Promise(accept => setTimeout(accept, 25))
  assert.equal(processIsAlive(pid), false, 'The recovered release did not exit before restart')
}

export async function readRollbackHistory(root, target, reason) {
  let history
  try {
    history = JSON.parse(await readFile(join(root, 'update-rollback-history.json'), 'utf8'))
  } catch (error) {
    throw new Error(
      'The immutable source must include rollback retry support; rebuild the source from the fix before running app-update-retry',
      { cause: error }
    )
  }
  assert.ok(Array.isArray(history), 'Rollback history must be a structured array')
  const entry = history.find(item => item.version === target.version && item.reason === reason)
  assert.ok(entry, `The production rollback did not record ${reason} for ${target.version}`)
  assert.equal(entry.packageSha256, target.sha256, 'Rollback history identifies another package')
  assert.ok(entry.token, 'Rollback history lost the real activation token')
  assert.ok(Number.isFinite(Date.parse(entry.occurredAt)), 'Rollback time is missing')
  return history
}

export async function requestRetryConfirmation(control, version) {
  let progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  if (progress.update?.retryConfirmation?.version !== version) {
    await control.command('clickWhenEnabled', UPDATE_BUTTON)
    await control.command('waitFor', '[data-testid="about-update-status"]', { text: version })
    progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  }
  assert.equal(
    progress.update?.retryConfirmation?.version,
    version,
    'The source package must expose the explicit retry confirmation; old packages cannot certify this regression'
  )
  if (Number(await control.command('getElementCount', RETRY_DIALOG)) === 0)
    await control.command('clickWhenEnabled', UPDATE_BUTTON)
  await control.command('waitFor', RETRY_DIALOG)
  assert.ok((await control.command('getText', RETRY_DIALOG)).includes(version))
  return progress.update.retryConfirmation
}

/** Continue an actual failed A -> B activation through the user's retry and rollback UI. */
export async function finishFailedUpgradeRetry(control, options) {
  const {
    root,
    homePath,
    pair,
    requests,
    resultDir,
    restartDesktopApp,
    workbenchReadyTimeoutMs,
    about,
    send,
    installedVersion,
    assertSelectedComposition,
    captureScreenshot,
    routeCurrentUpdateRequests,
  } = options
  const history = await readRollbackHistory(root, pair.to, 'startup-failed')
  assert.equal(
    history.find(item => item.version === pair.to.version && item.reason === 'startup-failed')
      .fromVersion,
    pair.from.version
  )
  // The native launcher replaced the driver's initial child during recovery.
  // Quit the connected source before mutating its profile or starting another host.
  await quitActiveRelease(control, root)
  await restartDesktopApp({
    afterStop: () => verifyCrossSlotProfile(root, resultDir, homePath),
    appEnvironmentOverrides: { WEWORK_E2E_RELEASE_FAILURE_VERSION: '' },
  })
  assert.equal(await installedVersion(), pair.from.version)
  await routeCurrentUpdateRequests()
  await about()
  const initial = await requestRetryConfirmation(control, pair.to.version)
  assert.equal(initial.reason, 'startup-failed')
  await captureScreenshot(control, 'app-update-retry-confirmation.png', RETRY_DIALOG)
  const archiveRequests = () => requests.filter(item => item.path === `/${pair.to.name}`).length
  const beforeCancel = archiveRequests()
  await control.command('click', RETRY_CANCEL)
  await control.command('waitFor', UPDATE_BUTTON, { text: pair.to.version, stableMs: 750 })
  assert.equal(Number(await control.command('getElementCount', RETRY_DIALOG)), 0)
  const cancelled = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  assert.equal(cancelled.update?.retryConfirmation?.token, initial.token)
  assert.equal(
    ['preparing', 'host', 'extracting', 'runtime', 'installing'].includes(cancelled.phase),
    false,
    'Cancelling confirmation started an update operation'
  )
  assert.equal(archiveRequests(), beforeCancel, 'Cancelling retry downloaded a release')
  assert.deepEqual(await readRollbackHistory(root, pair.to, 'startup-failed'), history)

  await control.command('clickWhenEnabled', UPDATE_BUTTON)
  await control.command('waitFor', RETRY_DIALOG)
  assert.equal(await confirmPendingUpdateRetry(control, pair.to.version), true)
  await waitForUpdatePreparation(async () =>
    JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  )
  await control.command('waitFor', '[data-testid="app-update-restart-confirm"]')
  const beforeInstall = control.readyCount
  await control.command('click', '[data-testid="app-update-restart-confirm"]')
  await control.awaitReadyAfter(beforeInstall, workbenchReadyTimeoutMs)
  assert.equal(await installedVersion(), pair.to.version)
  await assertSelectedComposition(pair.to.version)
  await continueTask(control, send, 'after a confirmed retry', workbenchReadyTimeoutMs)
  const confirmedHistory = JSON.parse(
    await readFile(join(root, 'update-rollback-history.json'), 'utf8')
  )
  assert.equal(
    confirmedHistory.some(item => item.version === pair.to.version),
    false,
    'Healthy startup retained the previous failed activation'
  )

  await about()
  await control.command('clickWhenEnabled', '[data-testid="about-rollback-button"]')
  await control.command('waitFor', '[data-testid="app-update-rollback-confirm"]')
  const beforeRollback = control.readyCount
  await control.command('click', '[data-testid="app-update-rollback-confirm"]')
  await control.awaitReadyAfter(beforeRollback, workbenchReadyTimeoutMs)
  assert.equal(await installedVersion(), pair.from.version)
  await assertSelectedComposition(pair.from.version)
  await readRollbackHistory(root, pair.to, 'rolled-back')
  await continueTask(
    control,
    send,
    'after manually rolling back the retry',
    workbenchReadyTimeoutMs
  )
  await routeCurrentUpdateRequests()
  await about()
  assert.equal((await requestRetryConfirmation(control, pair.to.version)).reason, 'rolled-back')
  await captureScreenshot(control, 'app-update-manual-rollback-confirmation.png', RETRY_DIALOG)
  await control.command('click', RETRY_CANCEL)
  await writeFile(
    join(resultDir, 'upgrade-retry-result.json'),
    JSON.stringify({
      source: pair.from.sha256,
      target: pair.to.sha256,
      failedActivation: 'recovered',
      cancelledRetry: 'preserved-history',
      confirmedRetry: 'healthy',
      manualRollback: 'retry-available',
      archiveRequests: archiveRequests(),
    })
  )
}

async function continueTask(control, send, stage, timeoutMs) {
  await control.command(
    'waitFor',
    '[data-testid="new-chat-button"], [data-testid="settings-back-button"]',
    { timeoutMs }
  )
  if (Number(await control.command('getElementCount', '[data-testid="settings-back-button"]')) > 0)
    await control.command('click', '[data-testid="settings-back-button"]')
  await send(`WEWORK_UPGRADE_PERSISTENCE continue ${stage}`)
}
