import {
  CLOUD_DEVICE_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
} from './shared.mjs'
import { remoteDeviceE2EExtension } from '../remote-device-extension.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

async function waitForCondition(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

export async function verifyCloudDeviceLifecycleFlow(control, cloudEnvironment) {
  const deviceCard = `[data-testid="connection-device-${CLOUD_DEVICE_ID}"]`
  const upgradeBadge = `[data-testid="connection-upgrade-badge-${CLOUD_DEVICE_ID}"]`
  const restartStatus = `[data-testid="connection-device-restart-status-${CLOUD_DEVICE_ID}"]`
  const terminalButton = `[data-testid="connection-terminal-button-${CLOUD_DEVICE_ID}"]`
  const moreButton = `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`
  const restartRetry = `[data-testid="connection-device-restart-retry-${CLOUD_DEVICE_ID}"]`
  const restartRequestCount = remoteDeviceE2EExtension.supportsStatusRecovery
    ? cloudEnvironment.nevisRestartRequestCount()
    : null
  const currentDevice = await cloudEnvironment.device(CLOUD_DEVICE_ID)
  assert.ok(currentDevice?.executor_version, 'The cloud lifecycle fixture has no Executor version')
  const testLatestVersion = '999.0.0'
  await control.command('navigate', 'body', { value: '/settings/general' })
  await cloudEnvironment.setExecutorLatestVersion(testLatestVersion)
  await waitForCondition(
    async () => {
      const refreshedDevice = await cloudEnvironment.device(CLOUD_DEVICE_ID)
      return refreshedDevice?.latest_version === testLatestVersion ? refreshedDevice : null
    },
    DEFAULT_STEP_TIMEOUT_MS,
    'The cloud lifecycle fixture did not expose the overridden latest Executor version'
  )

  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', deviceCard, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', upgradeBadge, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const upgradeLabel = await control.command('getText', upgradeBadge)
  assert.match(
    upgradeLabel,
    /有新版本|update available/i,
    'The cloud device card did not expose the Backend-reported available update'
  )
  await control.command('click', upgradeBadge)
  const upgradeConfirmation = await control.command(
    'getText',
    '[data-testid="confirm-upgrade-device-dialog"]'
  )
  assert.match(
    upgradeConfirmation,
    new RegExp(currentDevice.executor_version.replaceAll('.', '\\.')),
    'The upgrade confirmation did not show the current Executor version'
  )
  assert.match(
    upgradeConfirmation,
    new RegExp(testLatestVersion.replaceAll('.', '\\.')),
    'The upgrade confirmation did not show the latest Executor version'
  )
  assert.match(
    upgradeConfirmation,
    /短暂离线|temporarily go offline/i,
    'The upgrade confirmation did not warn about temporary offline status'
  )
  await captureVerificationScreenshot(control, 'cloud-device-upgrade-confirmation.png')
  await control.command('click', '[data-testid="cancel-upgrade-device-button"]')
  await cloudEnvironment.setExecutorLatestVersion(currentDevice.executor_version)

  await control.command('click', moreButton)
  await control.command('click', `[data-testid="connection-restart-menu-item-${CLOUD_DEVICE_ID}"]`)
  const confirmationText = await control.command(
    'getText',
    '[data-testid="confirm-restart-device-dialog"]'
  )
  assert.match(
    confirmationText,
    /短暂离线|temporarily go offline/i,
    'The cloud restart confirmation did not warn about temporary offline status'
  )
  assert.match(
    confirmationText,
    /终端|terminal/i,
    'The cloud restart confirmation did not explain session interruption'
  )

  await control.command('click', '[data-testid="confirm-restart-device-button"]')
  if (!remoteDeviceE2EExtension.supportsStatusRecovery) {
    await waitForCondition(
      async () => {
        try {
          const text = await control.command('getText', restartStatus)
          return /重启请求发送失败|could not send the restart request/i.test(text) ? text : null
        } catch {
          return null
        }
      },
      DEFAULT_STEP_TIMEOUT_MS,
      'The public Backend rejection did not surface as a restart error'
    )
    await control.command('waitFor', restartRetry, {
      enabled: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', terminalButton, {
      enabled: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', moreButton, {
      enabled: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const deviceStatus = await control.command(
      'getText',
      `${deviceCard} [data-testid="connection-device-status"]`
    )
    assert.match(
      deviceStatus,
      /在线|online/i,
      'A rejected restart request incorrectly presented the cloud device as offline'
    )
    await captureVerificationScreenshot(control, 'cloud-device-restart-unavailable.png')
    return
  }

  const restartRequest = await cloudEnvironment.waitForNevisRestartRequest(restartRequestCount)
  assert.equal(
    restartRequest.sandboxId,
    'wework-e2e-managed-cloud-sandbox',
    'The restart action targeted the Executor device ID instead of the managed Sandbox ID'
  )
  await control.command('waitFor', restartStatus, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForCondition(
    async () => {
      const text = await control.command('getText', restartStatus)
      return /短暂离线|briefly go offline/i.test(text) ? text : null
    },
    DEFAULT_STEP_TIMEOUT_MS,
    'The accepted restart request did not show the temporary offline reminder'
  )
  await assert.rejects(
    control.command('click', terminalButton),
    /disabled/,
    'Terminal remained enabled while the cloud device restart was pending'
  )
  await assert.rejects(
    control.command('click', moreButton),
    /disabled/,
    'Cloud lifecycle actions remained enabled while restart was pending'
  )
  await captureVerificationScreenshot(control, 'cloud-device-restart-pending.png')

  await cloudEnvironment.restartCloudExecutor()
  await waitForCondition(
    async () => {
      try {
        const text = await control.command('getText', restartStatus)
        return /重新在线|back online/i.test(text) ? text : null
      } catch {
        return null
      }
    },
    DEFAULT_STEP_TIMEOUT_MS,
    'The cloud device card did not report recovery after the Executor reconnected'
  )
  await control.command('waitFor', terminalButton, {
    enabled: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', moreButton, {
    enabled: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-device-restart-recovered.png')
}
