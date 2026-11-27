import {
  CLOUD_DEVICE_ID,
  CLOUD_DEVICE_LIFECYCLE_LATEST_VERSION,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_OPTIONS,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_REQUEST_TIMEOUT_MS,
  REMOTE_DOCKER_DEVICE_ID as SANDBOX_SIBLING_ID,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  fetchJson,
  join,
  mkdir,
} from './shared.mjs'
import { CLOUD_DEVICE_LIFECYCLE_THRESHOLD, MANAGED_CLOUD_SANDBOX_ID } from './cloud-environment.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

const BUSY_MODEL_SCENARIO = 'cloud_device_restart_busy'
const RESTART_DIALOG = '[data-testid="confirm-restart-device-dialog"]'
const UPGRADE_REMINDER = '[data-testid="cloud-device-upgrade-reminder"]'
const TERMINAL_PANEL = '[data-testid="settings-device-terminal-panel"]'

async function verifyUpgradeReminder(control, cloud) {
  const device = await cloud.device(CLOUD_DEVICE_ID)
  assert.equal(device.executor_version.replace(/^v/i, ''), CLOUD_DEVICE_LIFECYCLE_THRESHOLD)
  assert.deepEqual(device.cloud_upgrade_reminder, {
    target_version: CLOUD_DEVICE_LIFECYCLE_LATEST_VERSION,
  })
  const sibling = await cloud.device(SANDBOX_SIBLING_ID)
  assert.equal(
    sibling.update_available,
    true,
    'The newer sibling must still have an available update'
  )
  assert.equal(
    sibling.cloud_upgrade_reminder,
    undefined,
    'A version above the threshold must not prompt'
  )
  const useTerminal = async deviceId => {
    await control.command('click', `[data-testid="connection-terminal-button-${deviceId}"]`)
    await control.command('waitFor', TERMINAL_PANEL, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  }
  const closeTerminal = () =>
    control.command('click', '[data-testid="settings-device-terminal-close-button"]')
  await control.command('waitFor', UPGRADE_REMINDER, { visible: false })

  await useTerminal(SANDBOX_SIBLING_ID)
  await control.command('waitFor', UPGRADE_REMINDER, { visible: false })
  await closeTerminal()

  await useTerminal(CLOUD_DEVICE_ID)
  await control.command('waitFor', UPGRADE_REMINDER, {
    text: CLOUD_DEVICE_LIFECYCLE_LATEST_VERSION,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.ok(
    (await control.command('getText', UPGRADE_REMINDER)).includes(CLOUD_DEVICE_LIFECYCLE_THRESHOLD)
  )
  await captureVerificationScreenshot(control, 'cloud-device-upgrade-reminder.png')
  await control.command('click', '[data-testid="cancel-restart-device-button"]')
  assert.equal(cloud.sandboxRestartRequestCount(), 1, 'Postponing must not restart the device')
  await closeTerminal()

  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await useTerminal(CLOUD_DEVICE_ID)
  await control.command('waitFor', UPGRADE_REMINDER, { visible: false })
  await closeTerminal()
}

async function waitForCondition(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

function jsonPost(authToken, body) {
  return {
    method: 'POST',
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

async function createNonOwner(cloud) {
  const userName = `cloud-restart-non-owner-${process.pid}`
  const password = 'cloud-restart-e2e-password'
  await fetchJson(
    `${cloud.backendUrl}/api/admin/users`,
    jsonPost(cloud.authToken, {
      user_name: userName,
      password,
      role: 'user',
      auth_source: 'password',
    })
  )
  const login = await fetchJson(
    `${cloud.backendUrl}/api/auth/login`,
    jsonPost(null, { user_name: userName, password })
  )
  assert.ok(login.access_token, 'The non-owner must have a valid session')
  return login.access_token
}

function runtimeSettings(cloud, deviceId) {
  return fetchJson(
    `${cloud.backendUrl}/api/devices/${encodeURIComponent(deviceId)}/runtime-settings`,
    { headers: { Authorization: `Bearer ${cloud.authToken}` } }
  )
}

async function startBusySiblingTask(control, cloud) {
  const teams = await fetchJson(`${cloud.backendUrl}/api/teams?page=1&limit=100`, {
    headers: { Authorization: `Bearer ${cloud.authToken}` },
  })
  const teamId = teams.items?.[0]?.id
  assert.ok(teamId, 'The cloud lifecycle checkpoint requires an existing Team')
  const workspacePath = join(cloud.workspacePath, 'cloud-sandbox-restart-task')
  await mkdir(workspacePath, { recursive: true })
  const task = await fetchJson(
    `${cloud.backendUrl}/api/runtime-work/create`,
    jsonPost(cloud.authToken, {
      deviceId: SANDBOX_SIBLING_ID,
      workspacePath,
      teamId,
      runtime: 'codex',
      message: 'Keep this cloud restart E2E task running until the sandbox is restarted.',
      title: 'Sandbox restart task protection',
      modelId: CLOUD_PUBLIC_MODEL_NAME,
      modelType: 'public',
      modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
      modelSelection: {
        modelName: CLOUD_PUBLIC_MODEL_NAME,
        modelType: 'public',
        options: CLOUD_PUBLIC_MODEL_OPTIONS,
      },
    })
  )
  assert.equal(task.accepted, true, `The same-sandbox task was not accepted: ${task.error}`)
  assert.ok(task.taskId, 'The sibling executor did not return the runtime task ID')
  await control.awaitScenarioRequestCount(BUSY_MODEL_SCENARIO, 1, MODEL_REQUEST_TIMEOUT_MS)
  await waitForCondition(
    async () => {
      const [sibling, runtimeTask] = await Promise.all([
        runtimeSettings(cloud, SANDBOX_SIBLING_ID),
        cloud.runtimeTask(task.taskId),
      ])
      return (
        sibling.active_tasks > 0 &&
        (runtimeTask?.running === true || runtimeTask?.status === 'running')
      )
    },
    DEFAULT_STEP_TIMEOUT_MS,
    'The real sibling Executor did not report an active task and an occupied slot'
  )
}

async function expectUpgradeRejected(cloud, authToken, body, status, detail) {
  const response = await fetch(
    `${cloud.backendUrl}/api/devices/${encodeURIComponent(CLOUD_DEVICE_ID)}/upgrade`,
    jsonPost(authToken, body)
  )
  const payload = await response.json()
  assert.equal(response.status, status, JSON.stringify(payload))
  assert.match(payload.detail, detail)
}

async function waitForRestartStatus(control, selector, pattern, message) {
  await waitForCondition(
    async () => pattern.test(await control.command('getText', selector).catch(() => '')),
    DEFAULT_STEP_TIMEOUT_MS,
    message
  )
}

async function verifyUnconfiguredRestart(control, cloud, controls) {
  const { deviceCard, restartStatus, terminalButton, moreButton } = controls
  await expectUpgradeRejected(
    cloud,
    cloud.authToken,
    { force_stop_tasks: true },
    501,
    /device restart is not configured in this deployment/i
  )
  await control.command('click', '[data-testid="confirm-restart-device-button"]')
  await waitForRestartStatus(
    control,
    restartStatus,
    /重启请求发送失败|could not send the restart request/i,
    'The unconfigured public Backend did not surface a restart error'
  )
  const restartRetry = `[data-testid="connection-device-restart-retry-${CLOUD_DEVICE_ID}"]`
  for (const selector of [restartRetry, terminalButton, moreButton]) {
    await control.command('waitFor', selector, {
      enabled: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }
  const deviceStatus = await control.command(
    'getText',
    `${deviceCard} [data-testid="connection-device-status"]`
  )
  assert.match(deviceStatus, /在线|online/i, 'The rejected restart did not leave the UI online')
  assert.equal((await cloud.device(CLOUD_DEVICE_ID))?.status, 'online')
  assert.equal(cloud.sandboxRestartRequestCount(), 0, 'The unconfigured request reached a provider')
  await captureVerificationScreenshot(control, 'cloud-device-restart-unavailable.png')
  console.log(
    '[cloud-device-lifecycle] Unconfigured restart rejected; device stayed online and actions remained enabled'
  )
}

async function openRestartDialog(control) {
  await control.command('click', `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`)
  await control.command('click', `[data-testid="connection-restart-menu-item-${CLOUD_DEVICE_ID}"]`)
}

export async function verifyCloudDeviceRestartFocus(control, cloud) {
  await openRestartDialog(control)
  const menuConfirmation = await control.command('getText', RESTART_DIALOG)
  assert.match(menuConfirmation, /短暂离线|temporarily go offline/i)
  assert.match(menuConfirmation, /终端|terminal/i)
  const focused = await waitForCondition(
    async () => {
      const id = await control.command('getActiveElementTestId', 'body')
      return ['confirm-restart-device-button', 'cancel-restart-device-button'].includes(id) && id
    },
    5_000,
    'Opening the restart dialog did not move focus to either action'
  )
  await control.command('nativePress', `[data-testid="${focused}"]`, { key: 'Escape' })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('confirm-restart-device-dialog'),
    'Escape did not dismiss the restart dialog',
    5_000
  )
  assert.equal(cloud.sandboxRestartRequestCount(), 0, 'Dismissing the dialog restarted the sandbox')
  assert.equal(focused, 'cancel-restart-device-button', 'Opening the dialog must focus Cancel')
  console.log('[cloud-device-lifecycle] Restart initially focused Cancel; Escape dismissed it')
}

export async function verifyCloudDeviceLifecycleFlow(control, cloud) {
  const deviceCard = `[data-testid="connection-device-${CLOUD_DEVICE_ID}"]`
  const versionBadge = `[data-testid="connection-upgrade-badge-${CLOUD_DEVICE_ID}"]`
  const restartStatus = `[data-testid="connection-device-restart-status-${CLOUD_DEVICE_ID}"]`
  const terminalButton = `[data-testid="connection-terminal-button-${CLOUD_DEVICE_ID}"]`
  const moreButton = `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`
  const currentDevice = await cloud.device(CLOUD_DEVICE_ID)
  const sibling = await cloud.device(SANDBOX_SIBLING_ID)
  const testLatestVersion = CLOUD_DEVICE_LIFECYCLE_LATEST_VERSION
  for (const device of [currentDevice, sibling]) {
    assert.equal(device?.status, 'online', 'Both sandbox Executors must start online')
    assert.ok(device.runtime_instance_id, 'The Executor did not register a Runtime identity')
    assert.equal(device.cloud_config?.sandboxId, MANAGED_CLOUD_SANDBOX_ID)
  }
  assert.notEqual(currentDevice.runtime_instance_id, sibling.runtime_instance_id)
  assert.ok(currentDevice.executor_version, 'The lifecycle fixture has no Executor version')

  await control.command('navigate', 'body', { value: '/settings/general' })
  await waitForCondition(
    async () => (await cloud.device(CLOUD_DEVICE_ID))?.latest_version === testLatestVersion,
    DEFAULT_STEP_TIMEOUT_MS,
    'The lifecycle fixture did not expose the overridden latest Executor version'
  )
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', deviceCard, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('waitFor', versionBadge, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await captureVerificationScreenshot(control, 'cloud-device-01-online.png')
  assert.match(await control.command('getText', versionBadge), /有新版本|update available/i)

  await verifyCloudDeviceRestartFocus(control, cloud)
  await openRestartDialog(control)
  if (cloud.usePublicSandboxController) {
    await verifyUnconfiguredRestart(control, cloud, {
      deviceCard,
      restartStatus,
      terminalButton,
      moreButton,
    })
    await cloud.configurePublicSandboxRestart()
  } else {
    await control.command('click', '[data-testid="cancel-restart-device-button"]')
  }

  const nonOwnerToken = await createNonOwner(cloud)
  const restart = cloud.armSandboxRestart()
  control.setScenario(BUSY_MODEL_SCENARIO)
  control.holdScenarioResponse(BUSY_MODEL_SCENARIO)
  try {
    await startBusySiblingTask(control, cloud)
    assert.equal(
      (await runtimeSettings(cloud, CLOUD_DEVICE_ID)).active_tasks,
      0,
      'The restart target must be idle'
    )
    await expectUpgradeRejected(cloud, cloud.authToken, {}, 400, /cloud device has running tasks/i)
    console.log(
      '[cloud-device-lifecycle] Owner request rejected because its sandbox sibling is busy'
    )
    await expectUpgradeRejected(
      cloud,
      nonOwnerToken,
      { force_stop_tasks: true },
      404,
      /access denied/i
    )
    console.log('[cloud-device-lifecycle] Forced request rejected for a non-owner')
    assert.equal(cloud.sandboxRestartRequestCount(), 0, 'A rejected request reached the sandbox')

    await control.command('click', versionBadge)
    await control.command('waitFor', RESTART_DIALOG, {
      text: testLatestVersion,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const confirmation = await control.command('getText', RESTART_DIALOG)
    assert.ok(
      confirmation.includes(currentDevice.executor_version.replace(/^v/i, '')),
      'Current Executor version missing'
    )
    assert.ok(confirmation.includes(testLatestVersion), 'Latest Executor version missing')
    assert.match(confirmation, /短暂离线|temporarily go offline/i)
    await captureVerificationScreenshot(control, 'cloud-device-restart-confirmation.png')
    await control.command('click', '[data-testid="confirm-restart-device-button"]')
    await waitForRestartStatus(
      control,
      restartStatus,
      /短暂离线|briefly go offline/i,
      'The forced request did not show the temporary offline reminder'
    )
    assert.equal((await cloud.waitForSandboxRestartRequest()).sandboxId, MANAGED_CLOUD_SANDBOX_ID)
    assert.equal(cloud.sandboxRestartRequestCount(), 1)
    console.log('[cloud-device-lifecycle] Version badge confirmed a forced sandbox restart')
    await assert.rejects(control.command('click', terminalButton), /disabled/)
    await assert.rejects(control.command('click', moreButton), /disabled/)
    await captureVerificationScreenshot(control, 'cloud-device-restart-pending.png')

    restart.allowShutdown()
    await waitForRestartStatus(
      control,
      restartStatus,
      /处于离线状态|is restarting and offline/i,
      'Wework did not observe the real Executor going offline'
    )
    for (const deviceId of [CLOUD_DEVICE_ID, SANDBOX_SIBLING_ID]) {
      await cloud.waitForDeviceStatus(
        deviceId,
        'offline',
        deviceId === CLOUD_DEVICE_ID
          ? cloud.remoteExecutorLogPath
          : cloud.remoteDockerExecutorLogPath
      )
    }
    await assert.rejects(control.command('click', terminalButton), /disabled/)
    await assert.rejects(control.command('click', moreButton), /disabled/)
    await captureVerificationScreenshot(control, 'cloud-device-restart-offline.png')

    restart.allowStartup()
    await waitForRestartStatus(
      control,
      restartStatus,
      /重新在线|back online/i,
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

    const completed = await restart.finish()
    assert.equal(completed?.sibling.status, 'online')
    assert.equal(completed?.sibling.runtime_instance_id, sibling.runtime_instance_id)
    const recoveredDevice = await cloud.device(CLOUD_DEVICE_ID)
    assert.equal(recoveredDevice?.status, 'online')
    assert.equal(
      recoveredDevice?.update_available,
      true,
      'Restart must preserve the available update'
    )
    assert.equal(recoveredDevice?.executor_version, currentDevice.executor_version)
    assert.equal(recoveredDevice?.runtime_instance_id, currentDevice.runtime_instance_id)
    console.log('[cloud-device-lifecycle] Both sandbox Executors went offline and recovered')
    await verifyUpgradeReminder(control, cloud)
  } finally {
    control.releaseScenarioResponse(BUSY_MODEL_SCENARIO)
    control.setScenario('initial')
    await restart.finish()
    await cloud.setExecutorLatestVersion(currentDevice.executor_version)
  }
}
