import {
  CLOUD_DEVICE_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
} from './shared.mjs'
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
  const restartStatus = `[data-testid="connection-device-restart-status-${CLOUD_DEVICE_ID}"]`
  const restartRetryButton = `[data-testid="connection-device-restart-retry-${CLOUD_DEVICE_ID}"]`
  const terminalButton = `[data-testid="connection-terminal-button-${CLOUD_DEVICE_ID}"]`
  const moreButton = `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`
  const supportsManagedRestart =
    typeof cloudEnvironment.nevisRestartRequestCount === 'function' &&
    typeof cloudEnvironment.waitForNevisRestartRequest === 'function'
  const restartRequestCount = supportsManagedRestart
    ? cloudEnvironment.nevisRestartRequestCount()
    : 0

  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', deviceCard, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
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
  if (!supportsManagedRestart) {
    await control.command('waitFor', restartStatus, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await waitForCondition(
      async () => {
        const text = await control.command('getText', restartStatus)
        return /重启请求发送失败|restart request failed/i.test(text) ? text : null
      },
      DEFAULT_STEP_TIMEOUT_MS,
      'The public cloud device flow did not expose the deployment-specific restart failure'
    )
    await control.command('waitFor', restartRetryButton, {
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
    await captureVerificationScreenshot(control, 'cloud-device-restart-error.png')
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
