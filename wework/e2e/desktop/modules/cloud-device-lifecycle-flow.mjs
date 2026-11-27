import {
  ACTIVE_WORKBENCH_SELECTOR,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
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
  writeFile,
} from './shared.mjs'
import { CLOUD_DEVICE_LIFECYCLE_THRESHOLD, MANAGED_CLOUD_SANDBOX_ID } from './cloud-environment.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { sendPrompt } from './conversation-navigation.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

const BUSY_MODEL_SCENARIO = 'cloud_device_restart_busy'
const RESTART_DIALOG = '[data-testid="confirm-restart-device-dialog"]'
const UPGRADE_REMINDER = '[data-testid="cloud-device-upgrade-reminder"]'
const TERMINAL_PANEL = '[data-testid="settings-device-terminal-panel"]'
const CONFIRM_RESTART = '[data-testid="confirm-restart-device-button"]'
const CANCEL_RESTART = '[data-testid="cancel-restart-device-button"]'
const BUSY_REMINDER = /同一沙箱仍有任务|work is still running in its sandbox/i
const WAITING_ONLINE = /处于离线状态|is restarting and offline/i
const RECOVERED = /重新在线|back online/i

async function useTerminal(control, deviceId = CLOUD_DEVICE_ID) {
  await control.command('click', `[data-testid="connection-terminal-button-${deviceId}"]`)
  await control.command('waitFor', TERMINAL_PANEL, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
}

async function closeTerminal(control) {
  await control.command('click', '[data-testid="settings-device-terminal-close-button"]')
}

async function simulateNextReminderDay(control) {
  const { apiBaseUrl, user } = JSON.parse(
    await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
  )
  assert.ok(apiBaseUrl && user?.id != null, 'Cloud reminder requires an authenticated device scope')
  const scope = JSON.stringify([apiBaseUrl, user.id])
  const key = `wework:cloud-upgrade-reminder:${JSON.stringify([scope, MANAGED_CLOUD_SANDBOX_ID])}`
  const previous = await control.command('getLocalStorageItem', 'body', { value: key })
  assert.match(previous, /^\d{4}-\d{1,2}-\d{1,2}$/, 'The previous reminder did not persist its day')
  await control.command('setLocalStorageItem', 'body', {
    value: JSON.stringify({ key, value: '2000-1-1' }),
  })
}

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
  await control.command('waitFor', UPGRADE_REMINDER, { visible: false })

  await useTerminal(control, SANDBOX_SIBLING_ID)
  await control.command('waitFor', UPGRADE_REMINDER, { visible: false, stableMs: 250 })
  await closeTerminal(control)

  await useTerminal(control)
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
  await closeTerminal(control)

  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await useTerminal(control)
  await control.command('waitFor', UPGRADE_REMINDER, { visible: false, stableMs: 250 })
  await closeTerminal(control)
}

async function verifyWorkspaceReminderActions(control, cloud, createProject) {
  const { composerSelector } = await createProject()
  await control.command('waitFor', UPGRADE_REMINDER, { visible: false, stableMs: 250 })

  await simulateNextReminderDay(control)
  control.setScenario('checkpoint_task')
  try {
    await sendPrompt(control, composerSelector, CHECKPOINT_TASK_PROMPT)
    await control.command('waitFor', UPGRADE_REMINDER, {
      text: CLOUD_DEVICE_LIFECYCLE_LATEST_VERSION,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', CANCEL_RESTART)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: CHECKPOINT_TASK_COMPLETION_TEXT,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const task = JSON.parse(await control.command('snapshot', 'body')).workbench?.currentRuntimeTask
    assert.equal(
      task?.deviceId,
      CLOUD_DEVICE_ID,
      'The submitted task must use the old cloud Executor'
    )
  } finally {
    control.setScenario('initial')
  }

  await simulateNextReminderDay(control)
  const marker = 'cloud-upgrade-reminder-evidence.txt'
  const markerContent = 'Cloud device reminder file fixture'
  await writeFile(join(cloud.workspacePath, marker), markerContent + '\n')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  const panel = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  if (panel.testIds.includes('right-workspace-new-tab-button')) {
    await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
  }
  await control.command('clickWhenEnabled', '[data-testid="right-workspace-file-option"]')
  await control.command('waitFor', UPGRADE_REMINDER, {
    text: CLOUD_DEVICE_LIFECYCLE_LATEST_VERSION,
  })
  await control.command('click', CANCEL_RESTART)
  await control.command('fill', '[data-testid="workspace-file-search-input"]', { value: marker })
  await control.command('clickWhenEnabled', `button[data-type="item"][aria-label="${marker}"]`)
  await control.command('waitFor', '[data-testid="workspace-file-preview"]', {
    text: markerContent,
  })
  assert.equal(
    cloud.sandboxRestartRequestCount(),
    1,
    'Deferring task and file reminders restarted the sandbox'
  )
  console.log(
    '[cloud-device-lifecycle] Submitting a cloud task and opening cloud files prompted on explicit use'
  )
}

async function verifyBusyReminder(control, cloud) {
  await waitForCondition(
    async () => (await cloud.device(SANDBOX_SIBLING_ID))?.slot_used > 0,
    DEFAULT_STEP_TIMEOUT_MS,
    'The cloud device list did not expose the sibling as busy'
  )
  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await useTerminal(control)
  await waitForRestartStatus(
    control,
    UPGRADE_REMINDER,
    BUSY_REMINDER,
    'The reminder did not show the busy sandbox'
  )
  await assert.rejects(control.command('click', CONFIRM_RESTART), /disabled/)
  assert.equal(
    cloud.sandboxRestartRequestCount(),
    0,
    'The busy reminder reached the restart provider'
  )
  await captureVerificationScreenshot(control, 'cloud-device-reminder-busy.png')
  await control.command('click', CANCEL_RESTART)
  await closeTerminal(control)
}

async function verifyReminderRestart(control, cloud) {
  const restartStatus = `[data-testid="connection-device-restart-status-${CLOUD_DEVICE_ID}"]`
  const terminalButton = `[data-testid="connection-terminal-button-${CLOUD_DEVICE_ID}"]`
  const target = CLOUD_DEVICE_LIFECYCLE_LATEST_VERSION
  await waitForCondition(
    async () => {
      const [primary, sibling] = await Promise.all([
        runtimeSettings(cloud, CLOUD_DEVICE_ID),
        runtimeSettings(cloud, SANDBOX_SIBLING_ID),
      ])
      return primary.active_tasks === 0 && sibling.active_tasks === 0
    },
    DEFAULT_STEP_TIMEOUT_MS,
    'The sandbox did not become idle before the reminder upgrade'
  )
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await simulateNextReminderDay(control)
  await useTerminal(control)
  await control.command('waitFor', UPGRADE_REMINDER, { text: target })
  await control.command('waitFor', CONFIRM_RESTART, { enabled: true })

  const before = cloud.sandboxRestartRequestCount()
  const restart = cloud.armSandboxRestart()
  try {
    await control.command('click', CONFIRM_RESTART)
    assert.equal(
      (await cloud.waitForSandboxRestartRequest(before)).sandboxId,
      MANAGED_CLOUD_SANDBOX_ID
    )
    restart.allowShutdown()
    await waitForRestartStatus(
      control,
      restartStatus,
      WAITING_ONLINE,
      'The upgrade did not observe the cloud Executor going offline'
    )
    restart.allowStartup()
    await restart.finish()

    const old = await cloud.device(CLOUD_DEVICE_ID)
    assert.equal(old.status, 'online')
    assert.equal(old.executor_version.replace(/^v/i, ''), CLOUD_DEVICE_LIFECYCLE_THRESHOLD)
    // Keep the old Executor online through a full renderer device poll.
    const waiting = await control.command('getText', restartStatus)
    assert.match(
      waiting,
      WAITING_ONLINE,
      'The old Executor version incorrectly completed the upgrade'
    )
    await control.command('waitFor', restartStatus, { text: waiting, stableMs: 2_250 })
    await assert.rejects(control.command('click', terminalButton), /disabled/)
    await captureVerificationScreenshot(control, 'cloud-device-reminder-old-version.png')

    await Promise.all([
      waitForRestartStatus(
        control,
        restartStatus,
        RECOVERED,
        'The upgrade did not recover on the published version'
      ),
      cloud.restartCloudExecutor({ version: target }),
    ])
    const upgraded = await cloud.device(CLOUD_DEVICE_ID)
    assert.equal(upgraded.status, 'online')
    assert.equal(upgraded.executor_version.replace(/^v/i, ''), target)
    assert.equal(upgraded.cloud_upgrade_reminder, undefined)
    await control.command('waitFor', terminalButton, { enabled: true })
    await captureVerificationScreenshot(control, 'cloud-device-reminder-target-version.png')
    assert.equal(
      cloud.sandboxRestartRequestCount(),
      before + 1,
      'Upgrade sent multiple restart requests'
    )
    console.log(
      '[cloud-device-lifecycle] Reminder restarted the sandbox and recovered only on the published version'
    )
  } finally {
    await restart.finish()
  }
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

export async function verifyCloudDeviceLifecycleFlow(control, cloud, createProject) {
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
    await verifyBusyReminder(control, cloud)

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
    control.releaseScenarioResponse(BUSY_MODEL_SCENARIO)
    control.setScenario('initial')
    await simulateNextReminderDay(control)
    await verifyUpgradeReminder(control, cloud)
    await verifyWorkspaceReminderActions(control, cloud, createProject)
    await verifyReminderRestart(control, cloud)
  } finally {
    control.releaseScenarioResponse(BUSY_MODEL_SCENARIO)
    control.setScenario('initial')
    await restart.finish()
    await cloud.setExecutorLatestVersion(currentDevice.executor_version)
  }
}
