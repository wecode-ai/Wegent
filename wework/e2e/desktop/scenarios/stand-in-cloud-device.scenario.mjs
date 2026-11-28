import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { openStandInDetails, openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  assertStandInAccountDevice,
  bindStoppedStandIn,
  finishStandInOnboarding,
  readStandInBinding,
  stopBoundStandIn,
} from '../modules/stand-in-instance-flows.mjs'
import { findRuntimeWorkTask } from '../modules/runtime-task-evidence.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import {
  createStandInCloudPeerClient,
  PEER_CLOUD_PROMPT,
  PEER_CLOUD_COMPLETE,
  PEER_FALLBACK_PROMPT,
  PEER_FALLBACK_COMPLETE,
  OFFLINE_SWITCH_PROMPT,
  OFFLINE_SWITCH_COMPLETE,
} from '../modules/stand-in-cloud-peer-client.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID, fetchJson } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 1
const CLOUD_NAME = 'Cloud stand-in bound device'
const PROMPT = 'CLOUD_STAND_IN_DEVICE_EXECUTION'
const COMPLETE = 'CLOUD_STAND_IN_DEVICE_EXECUTION_COMPLETE'
const REOPEN_PROMPT = 'CLOUD_STAND_IN_VERIFY_REOPENED_RELAY'
const REOPEN_COMPLETE = 'CLOUD_STAND_IN_REOPENED_RELAY_CONFIRMED'
const PREVIOUS_ADDRESS = 'https://previous-stand-in.example.invalid/api'
const HOLD = 'CLOUD_STAND_IN_STOP_RUNNING_CONVERSATION'
const LOCAL_NAME = 'Signed-out local stand-in'
const LOCAL_PROMPT = 'LOCAL_STAND_IN_DEVICE_HISTORY'
const LOCAL_COMPLETE = 'LOCAL_STAND_IN_HISTORY_PRESERVED'
const testId = id => `[data-testid=${JSON.stringify(id)}]`

function readProfile(home) {
  const database = new DatabaseSync(join(home, 'data/tasks.sqlite'), { readOnly: true })
  try {
    const row = database
      .prepare(
        "SELECT metadata FROM loop_items WHERE resource_type='personal_stand_in' AND json_extract(metadata,'$.userId')=?"
      )
      .get(USER)
    return row ? JSON.parse(row.metadata) : null
  } finally {
    database.close()
  }
}

function readConversationIssueState(home, taskId) {
  const database = new DatabaseSync(join(home, 'data/tasks.sqlite'), { readOnly: true })
  try {
    return {
      issues: database
        .prepare(
          "SELECT id FROM loop_items WHERE resource_type='task' AND cloud_project_id='default-work-items' ORDER BY id"
        )
        .all(),
      bindings: database
        .prepare(
          "SELECT id,loop_item_id FROM loop_items WHERE resource_type='execution' AND task_id=? AND loop_item_id IS NOT NULL ORDER BY id"
        )
        .all(taskId),
    }
  } finally {
    database.close()
  }
}

// The existing cloud checkpoint owns binding, actual cancellation and offline recovery.
export function createDesktopScenario({
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
  workspacePath,
}) {
  let cloud
  let modelRequests = 0
  let heldResponse
  let heldRequestSeen = false
  let heldConnectionClosed = false
  let remoteSocket
  const peerClient = createStandInCloudPeerClient({
    resultDir,
    workspacePath,
    uiTimeoutMs,
    workbenchReadyTimeoutMs,
    modelResponseTimeoutMs,
    userId: USER,
  })
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const stop = control => stopBoundStandIn(control, uiTimeoutMs)
  const bind = (control, user, device) =>
    bindStoppedStandIn(control, user, device, uiTimeoutMs, cloud)
  const readCloudAssistant = (token = cloud.authToken) =>
    fetchJson(`${cloud.backendUrl}/api/v1/personal-assistant`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
  const readPrimaryDevice = async (token = cloud.authToken) =>
    (await readCloudAssistant(token)).assistant?.definitions?.find(
      entry => entry.roleId === '@primary'
    )?.bot?.spec?.execution_policy?.environment_id
  const setPrimaryDevice = async (deviceId, token = cloud.authToken) => {
    const current = (await readCloudAssistant(token)).assistant
    const definitions = current.definitions.map(entry => ({
      roleId: entry.roleId,
      name: entry.bot.metadata.displayName ?? '',
      prompt: entry.ghost.spec.systemPrompt,
      executionDeviceId:
        entry.roleId === '@primary' ? deviceId : entry.bot.spec?.execution_policy?.environment_id,
    }))
    return fetchJson(`${cloud.backendUrl}/api/v1/personal-assistant`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: current.revision, desired: { definitions } }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
  }
  async function remoteRpc(method, params) {
    if (!remoteSocket) {
      const { io } = createRequire(
        new URL('../../../../packages/chat-core/package.json', import.meta.url)
      )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
      remoteSocket = io(`${cloud.backendUrl}/wework-runtime`, {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token: cloud.authToken },
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        timeout: uiTimeoutMs,
      })
      await new Promise((resolve, reject) => {
        remoteSocket.once('connect', resolve)
        remoteSocket.once('connect_error', reject)
        remoteSocket.connect()
      })
    }
    const ack = await remoteSocket.timeout(uiTimeoutMs).emitWithAck('runtime:request', {
      type: 'request',
      id: randomUUID(),
      method,
      params,
      device_id: CLOUD_DEVICE_ID,
      timeout_seconds: uiTimeoutMs / 1000,
    })
    assert.equal(ack.ok, true, `${method}: ${ack.error?.message}`)
    return ack.result
  }
  async function createRole(control, name, deviceId) {
    await control.command('clickWhenEnabled', testId('stand-in-create-role'))
    await control.command('waitFor', testId('stand-in-role-name'))
    assert.equal(
      await control.command('getElementCount', testId('stand-in-device')),
      '0',
      'Role creation must not expose a primary binding switch'
    )
    await control.command('waitFor', testId('stand-in-role-device'))
    if (deviceId)
      await control.command('select', testId('stand-in-role-device'), { value: deviceId })
    await control.command('fill', testId('stand-in-role-name'), { value: name })
    await control.command('clickWhenEnabled', testId('stand-in-save'))
    await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })
  }
  async function chat(control, role, message) {
    await control.command('clickWhenEnabled', testId(`stand-in-overview-role-${role}`))
    await control.command('waitFor', testId('stand-in-conversation'))
    const selector = testId('stand-in-conversation')
    await sendChat(control, selector, message)
    return selector
  }
  async function sendChat(control, selector, message) {
    await control.command('fill', `${selector} [data-testid="chat-message-input"]`, {
      value: message,
    })
    // Model selection can still disable submission while the composer is mounted.
    await control.command('clickWhenEnabled', `${selector} [data-testid="send-message-button"]`, {
      visible: true,
      timeoutMs: uiTimeoutMs,
    })
  }
  async function observeDevice(control, device, status) {
    await control.command('navigate', 'body', { value: '/cloud-work' })
    await control.command(
      'waitFor',
      `${testId(`connection-device-${device}`)} [data-testid="connection-device-status"]`,
      { text: status, timeoutMs: workbenchReadyTimeoutMs }
    )
    await control.command('navigate', 'body', { value: '/stand-in' })
  }
  async function verifyDefinitionBackupSettingsEntry(control) {
    const backup = testId('stand-in-download-definition-backups')
    assert.equal(await control.command('getElementCount', backup), '0')
    assert.equal(await control.command('getElementCount', testId('stand-in-migration-expand')), '0')
    assert.equal(await control.command('getElementCount', testId('stand-in-migration')), '0')
    await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
    await openStandInSettings(control)
    await control.command('waitFor', backup, { timeoutMs: uiTimeoutMs })
    await control.command('clickWhenEnabled', testId('stand-in-primary-profile-close'))
    await control.command('waitFor', backup, { visible: false, timeoutMs: uiTimeoutMs })
  }

  async function verifyUnreachableSourceInitialization(control, readAssistant) {
    const missingDevice = 'stand-in-unregistered-source'
    await setPrimaryDevice(missingDevice)
    await reloadMainWindow(control)
    const migration = testId('stand-in-migration')
    await control.command('waitFor', migration, { timeoutMs: uiTimeoutMs })
    assert.equal(await control.command('getElementCount', testId('stand-in-conversation')), '0')
    assert.equal(
      await readPrimaryDevice(),
      missingDevice,
      'An unavailable source stays selected until recovery'
    )
    const existing = (await readAssistant()).assistant
    await control.command('select', testId('stand-in-migration-device'), { value: CLOUD_DEVICE_ID })
    await control.command('clickWhenEnabled', testId('stand-in-migrate-open'))
    await control.command('clickWhenEnabled', testId('stand-in-migrate-confirm'))
    await until(
      () => readPrimaryDevice(),
      deviceId => deviceId === CLOUD_DEVICE_ID,
      'An unreachable source must allow the destination to use the cloud assistant',
      uiTimeoutMs
    )
    await control.command('waitFor', migration, { visible: false, timeoutMs: uiTimeoutMs })
    await control.command('waitFor', testId('stand-in-overview'), { timeoutMs: uiTimeoutMs })
    await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
    await control.command('waitFor', testId('stand-in-conversation'), { timeoutMs: uiTimeoutMs })
    const saved = (await readAssistant()).assistant
    assert.deepEqual(
      saved.definitions.map(definition => [definition.roleId, definition.ghost.spec.systemPrompt]),
      existing.definitions.map(definition => [
        definition.roleId,
        definition.ghost.spec.systemPrompt,
      ])
    )
    assert.equal(
      saved.definitions.find(definition => definition.roleId === '@primary').bot.spec
        .execution_policy.environment_id,
      CLOUD_DEVICE_ID
    )
    await verifyDefinitionBackupSettingsEntry(control)
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({ collaborationExperienceEnabled: true }),
    })
    await control.command('navigate', 'body', { value: '/stand-in' })
    await control.command('waitFor', testId('collaboration-exp-assistant-input'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('clickWhenEnabled', testId('stand-in-instance-stop'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('clickWhenEnabled', testId('stand-in-instance-stop-confirm'))
    await control.command('waitFor', testId('stand-in-instance-stopped'))
    assert.equal(
      (await remoteRpc('runtime.stand_in.personal.get', { userId: USER })).lifecycle.status,
      'stopped'
    )
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({ collaborationExperienceEnabled: false }),
    })
  }

  async function verifyRegularBinding(control, localDevice) {
    const username = `stand-in-binding-${process.pid}`
    const credentials = { user_name: username, password: randomUUID() }
    const authRequest = (path, body, method = 'POST') =>
      fetchJson(`${cloud.backendUrl}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cloud.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
    const member = await authRequest('/admin/users', {
      ...credentials,
      role: 'user',
      auth_source: 'password',
    })
    try {
      const session = await authRequest('/auth/login', credentials)
      // Prepare this account's local profile before entering the account initialization screen.
      await control.command('navigate', 'body', { value: '/cloud-work' })
      await control.command('setCloudSessionToken', 'body', { value: session.access_token })
      await rpc(control, 'runtime.stand_in.onboarding.complete', {
        userId: member.id,
        weeklyReview: false,
        language: 'zh-CN',
      })
      await rpc(control, 'runtime.stand_in.personal.lifecycle', {
        userId: member.id,
        operation: 'start',
      })
      const localProfile = await rpc(control, 'runtime.stand_in.personal.get', {
        userId: member.id,
      })
      const legacyPrompt = 'Check the source before answering.'
      await rpc(control, 'runtime.stand_in.personal.save', {
        userId: member.id,
        settings: {
          ...localProfile,
          primary: {
            enabled: true,
            preferences: '',
            ...localProfile.primary,
            prompt: legacyPrompt,
          },
        },
      })
      assert.equal((await readCloudAssistant(session.access_token)).assistant, null)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await reloadMainWindow(control)
      const migrateConfirm = testId('personal-assistant-account-migrate-confirm')
      await control.command('waitFor', migrateConfirm, { timeoutMs: uiTimeoutMs })
      await captureScreenshot(control, 'personal-assistant-01-migration-confirmation.png')
      await control.command('clickWhenEnabled', testId('personal-assistant-account-migrate-cancel'))
      await control.command('waitFor', migrateConfirm, { visible: false, timeoutMs: uiTimeoutMs })
      assert.equal(
        (await readCloudAssistant(session.access_token)).assistant,
        null,
        'Cancel leaves the cloud account uninitialized'
      )
      const migrate = testId('personal-assistant-account-initialize')
      await control.command('waitFor', migrate)
      assert.equal(await control.command('getElementCount', testId('stand-in-conversation')), '0')
      await captureScreenshot(control, 'personal-assistant-02-migration-deferred.png')
      await control.command('clickWhenEnabled', migrate)
      await control.command('clickWhenEnabled', migrateConfirm)
      await control.command('waitFor', migrate, { visible: false, timeoutMs: uiTimeoutMs })
      await control.command('waitFor', testId('transient-notice'), {
        text: '云端助理已就绪',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', testId('stand-in-overview'))
      await captureScreenshot(control, 'personal-assistant-03-migration-complete.png')
      const shared = (await readCloudAssistant(session.access_token)).assistant
      const primary = shared.definitions.find(definition => definition.roleId === '@primary')
      assert.deepEqual(primary.bot.spec.ghostRef, {
        name: primary.ghost.metadata.name,
        namespace: primary.ghost.metadata.namespace,
      })
      assert.equal(primary.ghost.spec.systemPrompt, legacyPrompt)
      assert.deepEqual(primary.bot.spec.execution_policy, {
        mode: 'fixed',
        environment_id: localDevice,
      })

      await createRole(control, 'Ordinary account stand-in')
      const profile = await rpc(control, 'runtime.stand_in.personal.get', { userId: member.id })
      const role = profile.roles.find(row => row.name === 'Ordinary account stand-in')
      assert.ok(role)
      const sharedRole = (
        await readCloudAssistant(session.access_token)
      ).assistant.definitions.find(definition => definition.roleId === role.id)
      assert.equal(
        sharedRole?.bot.metadata.displayName,
        role.name,
        'New roles are saved to the cloud'
      )
      const renamedUsername = `${username}-renamed`
      const renamed = await authRequest(
        `/admin/users/${member.id}`,
        { user_name: renamedUsername },
        'PUT'
      )
      assert.equal(renamed.id, member.id)
      assert.equal(renamed.user_name, renamedUsername)
      const renamedSession = await authRequest('/auth/login', {
        ...credentials,
        user_name: renamedUsername,
      })
      await control.command('setCloudSessionToken', 'body', { value: renamedSession.access_token })
      await reloadMainWindow(control)
      await control.command('waitFor', testId(`stand-in-overview-role-${role.id}`))
      assert.equal(await readPrimaryDevice(renamedSession.access_token), localDevice)

      // Navigating with an explicit notification userId for another account still guards mismatch,
      // while normal account switching opens the signed-in account directly.
      await control.command('navigate', 'body', {
        value: `/stand-in?${new URLSearchParams({ userId: String(USER), profileId: '@primary', deviceId: localDevice })}`,
      })
      await control.command('waitFor', testId('stand-in-route-error'), {
        text: '你无权访问链接中的助理或设备。',
      })
      assert.equal(await control.command('getElementCount', testId('stand-in-conversation')), '0')
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', testId(`stand-in-overview-role-${role.id}`))
    } finally {
      await control.command('setCloudSessionToken', 'body', { value: cloud.authToken })
      const removed = await fetch(`${cloud.backendUrl}/api/admin/users/${member.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
      assert.equal(removed.status, 204, 'The renamed fixture account must be removed')
    }
  }
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    prepareApp: peerClient.prepareApp,
    async cleanup() {
      heldResponse?.end()
      remoteSocket?.disconnect()
      await peerClient.cleanup()
    },
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const input = JSON.stringify(body.input ?? [])
      const reopened = input.includes(REOPEN_PROMPT)
      const peerFallback = input.includes(PEER_FALLBACK_PROMPT)
      const peerCloud = input.includes(PEER_CLOUD_PROMPT)
      const offlineSwitch = input.includes(OFFLINE_SWITCH_PROMPT)
      if (
        !reopened &&
        !peerFallback &&
        !peerCloud &&
        !offlineSwitch &&
        !input.includes(PROMPT) &&
        !input.includes(LOCAL_PROMPT) &&
        !input.includes(HOLD)
      )
        return false
      modelRequests++
      const id = `cloud-stand-in-${modelRequests}`
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (!reopened && !peerFallback && !peerCloud && !offlineSwitch && input.includes(HOLD)) {
        heldResponse = res
        heldRequestSeen = true
        res.on('close', () => {
          heldConnectionClosed = true
        })
        res.write(createSse([responseCreated(id)]))
      } else {
        res.end(
          createSse([
            responseCreated(id),
            assistantMessage(
              peerFallback
                ? PEER_FALLBACK_COMPLETE
                : peerCloud
                  ? PEER_CLOUD_COMPLETE
                  : offlineSwitch
                    ? OFFLINE_SWITCH_COMPLETE
                    : reopened
                      ? REOPEN_COMPLETE
                      : input.includes(LOCAL_PROMPT)
                        ? LOCAL_COMPLETE
                        : COMPLETE
            ),
            responseCompleted(id),
          ])
        )
      }
      return true
    },
    async verify(control) {
      for (const userId of [0, USER]) {
        await rpc(control, 'runtime.stand_in.onboarding.complete', {
          userId,
          weeklyReview: false,
          language: 'zh-CN',
        })
      }
      await remoteRpc('runtime.stand_in.onboarding.complete', {
        userId: USER,
        weeklyReview: false,
        language: 'zh-CN',
      })
      const localIdentity = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      const localDevice = localIdentity.deviceId
      const remoteHome = dirname(cloud.remoteCodexHome)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ collaborationExperienceEnabled: false }),
      })
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command(
        'waitFor',
        `${testId('stand-in-conversation')} [data-testid="chat-message-input"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const beforeSetup = await readStandInBinding(control, uiTimeoutMs)
      assert.equal(beforeSetup.status, 'unbound')
      assert.equal(beforeSetup.target, null)
      const firstUseDevice = await readPrimaryDevice()
      assert.ok(
        [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].includes(firstUseDevice),
        'First use may select an available cloud device'
      )
      assert.equal(
        await control.command('getElementCount', testId('stand-in-device')),
        '0',
        'Account assistant must not expose the legacy binding switch'
      )
      assert.equal(await readPrimaryDevice(), firstUseDevice)
      const readInitialAssistant = () => readCloudAssistant()
      const initialAssistant = (await readInitialAssistant()).assistant
      assert.equal(initialAssistant.definitions[0].roleId, '@primary')
      assert.equal(initialAssistant.definitions[0].team.spec.collaborationModel, 'solo')
      await control.command('waitFor', testId('stand-in-overview'), { visible: true })
      const executionDevice = testId('personal-assistant-execution-device')
      async function openExecutionSettings() {
        await openStandInDetails(control)
        assert.equal(await control.command('getElementCount', executionDevice), '0')
        await openStandInSettings(control)
        await control.command('clickWhenEnabled', testId('stand-in-primary-execution-toggle'))
      }
      async function reopenExecutionSettings(deviceId) {
        await assertStandInAccountDevice(USER, deviceId, uiTimeoutMs, cloud)
        // Account navigation remounts the overview when its execution device changes.
        await control.command('waitFor', testId('stand-in-profile-panel'), {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
        await openExecutionSettings()
        await control.command('waitFor', `${executionDevice}:not(:disabled)`, {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(await control.command('getValue', executionDevice), deviceId)
      }
      assert.equal(await control.command('getElementCount', executionDevice), '0')
      await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
      await openExecutionSettings()
      await control.command('clickWhenEnabled', executionDevice)
      await control.command('waitFor', '[role="listbox"] [role="option"]', {
        text: '当前设备',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'personal-assistant-05-execution-choices.png')
      await control.command(
        'clickWhenEnabled',
        `[role="listbox"] [role="option"][data-value=${JSON.stringify(localDevice)}]`
      )
      await reopenExecutionSettings(localDevice)
      await control.command('waitFor', executionDevice, {
        text: '当前设备',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'personal-assistant-04-execution-device.png')
      await reloadMainWindow(control)
      await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
      await control.command('waitFor', testId('stand-in-conversation'))
      await sendChat(control, testId('stand-in-conversation'), LOCAL_PROMPT)
      await control.command('waitFor', testId('stand-in-conversation'), {
        text: LOCAL_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const localTurn = await until(
        () => rpc(control, 'runtime.tasks.get', { taskId: `stand-in-chat-${USER}-primary` }),
        value => value.task?.status === 'done' && value.task.running !== true,
        'The selected local Executor must finish the primary conversation',
        modelResponseTimeoutMs
      )
      assert.ok(localTurn.task.threadId, 'The selected local Executor must own the conversation')
      assert.equal(
        await readPrimaryDevice(),
        localDevice,
        'Execution selection updates the cloud primary device directly without stopping'
      )
      await openExecutionSettings()
      await control.command('clickWhenEnabled', executionDevice)
      await control.command(
        'clickWhenEnabled',
        `[role="listbox"] [role="option"][data-value=${JSON.stringify(firstUseDevice)}]`
      )
      await reopenExecutionSettings(firstUseDevice)
      await control.command('clickWhenEnabled', testId('stand-in-primary-profile-close'))
      await stop(control)
      if (firstUseDevice !== CLOUD_DEVICE_ID) {
        await bind(control, USER, CLOUD_DEVICE_ID)
        await finishStandInOnboarding(control)
        await stop(control)
      }
      await bind(control, USER, localDevice)
      await createRole(control, 'Account-local history', localDevice)
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const historyRole = initial.roles.find(row => row.name === 'Account-local history')
      assert.ok(historyRole)
      const localChat = await chat(control, historyRole.id, LOCAL_PROMPT)
      await control.command('waitFor', localChat, {
        text: LOCAL_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const localWithMigrationRole = await rpc(control, 'runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...initial,
          roles: [...initial.roles, { ...historyRole, name: LOCAL_NAME, id: 'legacy-role' }],
        },
      })
      const localRole = localWithMigrationRole.roles.find(row => row.name === LOCAL_NAME)
      assert.ok(localRole, 'The existing local profile must retain its role')
      const memory = await rpc(control, 'runtime.stand_in.memory.save', {
        userId: USER,
        memory: {
          content: 'Keep local responsibilities local',
          scope: { kind: 'role', roleId: localRole.id },
        },
      })
      await control.command('navigate', 'body', { value: '/settings/connections' })
      await control.command('clickWhenEnabled', testId('settings-cloud-disconnect-button'))
      await control.command('waitFor', testId('settings-cloud-connect-button'))
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', testId('personal-assistant-connect-cloud'))
      assert.equal(await control.command('getElementCount', testId('stand-in-conversation')), '0')
      await captureScreenshot(control, 'personal-assistant-cloud-disconnected.png')
      await control.command('clickWhenEnabled', testId('personal-assistant-connect-cloud'))
      await control.command('waitFor', testId('settings-cloud-connect-button'))
      await control.command('setCloudSessionToken', 'body', { value: cloud.authToken })
      await observeDevice(control, CLOUD_DEVICE_ID, '在线')
      await control.command('waitFor', testId('stand-in-overview'))
      await stop(control)
      const stoppedAccount = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const beforeMigration = readProfile(remoteHome)
      assert.equal(beforeMigration.lifecycle?.status, 'stopped', 'Migration target starts stopped')
      await control.command('waitFor', testId('stand-in-migration'))
      await control.command('select', testId('stand-in-migration-role'), { value: localRole.id })
      await control.command('select', testId('stand-in-migration-device'), {
        value: CLOUD_DEVICE_ID,
      })
      await control.command('clickWhenEnabled', testId('stand-in-migrate-open'))
      await control.command('clickWhenEnabled', testId('stand-in-migrate-cancel'))
      await control.command('waitFor', testId('stand-in-migrate-confirm'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await readPrimaryDevice(),
        localDevice,
        'Cancelling migration must preserve the account primary device'
      )
      assert.deepEqual(
        readProfile(remoteHome),
        beforeMigration,
        'Cancelling migration must never write target settings'
      )
      await control.command('clickWhenEnabled', testId('stand-in-migrate-open'))
      await control.command('clickWhenEnabled', testId('stand-in-migrate-confirm'))
      await control.command('waitFor', testId('stand-in-migration'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', testId('stand-in-instance-stopped'))
      assert.equal(await control.command('getElementCount', testId('stand-in-conversation')), '0')
      assert.equal(readProfile(remoteHome).lifecycle?.status, 'stopped')
      assert.equal(
        await readPrimaryDevice(),
        localDevice,
        'Copying a secondary role must preserve the account primary device'
      )
      const migrated = readProfile(remoteHome).roles.find(row => row.name === LOCAL_NAME)
      assert.ok(
        migrated,
        'Successful migration must retain portable responsibilities on the target'
      )
      const migratedDefinition = (await readInitialAssistant()).assistant.definitions.find(
        definition => definition.roleId === migrated.id
      )
      assert.equal(migratedDefinition?.bot.metadata.displayName, LOCAL_NAME)
      assert.equal(migratedDefinition?.bot.spec.execution_policy.environment_id, CLOUD_DEVICE_ID)
      assert.equal(migrated.enabled, false, 'Migration must not enable unconfigured device grants')
      assert.equal(migrated.workspace, undefined)
      assert.equal(migrated.connections, undefined)
      const database = new DatabaseSync(join(remoteHome, 'data/tasks.sqlite'), { readOnly: true })
      try {
        const memories = database
          .prepare(
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?"
          )
          .all(USER)
          .map(row => JSON.parse(row.metadata))
        assert.ok(
          memories.some(row => row.content === memory.content && row.scope.roleId === migrated.id),
          'Role memory must migrate to the same imported identity'
        )
      } finally {
        database.close()
      }
      assert.equal(
        (await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })).lifecycle.status,
        'stopped',
        'The old stopped profile on the source device must remain stopped after migration'
      )
      await bind(control, USER, CLOUD_DEVICE_ID)
      await createRole(control, CLOUD_NAME, CLOUD_DEVICE_ID)
      const role = readProfile(remoteHome).roles.find(row => row.name === CLOUD_NAME)
      assert.ok(role, 'The bound real cloud Executor must persist the role')
      assert.equal(role.executionDeviceId, CLOUD_DEVICE_ID)
      const taskId = `stand-in-chat-${USER}-role-${role.id}`
      const issuesBefore = readConversationIssueState(remoteHome, taskId)
      assert.deepEqual(issuesBefore.bindings, [])
      const remoteChat = await chat(control, role.id, PROMPT)
      await control.command('waitFor', remoteChat, {
        text: COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const indexPath = join(remoteHome, 'runtime-work/index.json')
      const threadId = JSON.parse(await readFile(indexPath, 'utf8')).tasks[taskId]?.thread_id
      assert.ok(threadId)
      const localTasks = await rpc(control, 'runtime.tasks.list', {})
      assert.equal(localTasks.coverage.authorized_index_complete, true)
      assert.equal(
        findRuntimeWorkTask(localTasks, taskId),
        undefined,
        'Remote conversations must not run on the local Executor'
      )
      await sendChat(control, remoteChat, HOLD)
      await until(
        () => heldRequestSeen,
        Boolean,
        'The real cloud Codex must start the held turn',
        modelResponseTimeoutMs
      )
      await stop(control)
      await until(() => heldConnectionClosed, Boolean, 'Stopping must cancel the real model stream')
      assert.equal(readProfile(remoteHome).lifecycle.status, 'stopped')
      assert.ok(readProfile(remoteHome).roles.every(row => !row.enabled))
      const cancelled = await until(
        () => remoteRpc('runtime.tasks.get', { taskId }),
        result => {
          assert.equal(result.success, true, result.error)
          assert.equal(result.task.taskId, taskId)
          assert.equal(result.task.threadId, threadId)
          return result.task.status === 'cancelled' && result.task.running === false
        },
        'The real remote task must project its native cancelled outcome'
      )
      assert.equal(cancelled.task.status, 'cancelled')
      assert.equal(cancelled.task.running, false)
      assert.deepEqual(
        readConversationIssueState(remoteHome, taskId),
        issuesBefore,
        'Ordinary identity conversation and cancellation must not create a business Issue'
      )

      // The stopped UI precedes the asynchronous shared marker clear. Wait for
      // its acknowledgement before restarting directly through the Executor RPC.
      await until(
        async () => (await readCloudAssistant()).assistant,
        account =>
          Boolean(
            account && !account.stopIntents?.some(intent => intent.deviceId === CLOUD_DEVICE_ID)
          ),
        'The completed cloud stop must clear its marker before restart',
        uiTimeoutMs
      )
      const staleBinding = await rpc(control, 'runtime.stand_in.binding', {
        operation: 'bind',
        version: (await readStandInBinding(control, uiTimeoutMs)).version,
        target: { userId: USER, deviceId: localDevice, backendUrl: PREVIOUS_ADDRESS },
      })
      await remoteRpc('runtime.stand_in.personal.lifecycle', { userId: USER, operation: 'start' })
      await reloadMainWindow(control)
      await control.command('waitFor', testId('stand-in-overview'))
      await control.command('clickWhenEnabled', testId(`stand-in-overview-role-${role.id}`))
      await control.command('waitFor', remoteChat, { text: COMPLETE })
      await sendChat(control, remoteChat, REOPEN_PROMPT)
      await control.command('waitFor', remoteChat, {
        text: REOPEN_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const reopened = await until(
        () => remoteRpc('runtime.tasks.get', { taskId }),
        result => result.task?.status === 'done' && result.task.running !== true,
        'The bound cloud Executor must finish the turn after reopening',
        modelResponseTimeoutMs
      )
      assert.equal(reopened.success, true, reopened.error)
      assert.equal(reopened.task.threadId, threadId)
      assert.equal(await readPrimaryDevice(), CLOUD_DEVICE_ID)
      assert.deepEqual(await readStandInBinding(control, uiTimeoutMs), staleBinding)
      await stop(control)
      await reloadMainWindow(control)
      await control.command('waitFor', testId('stand-in-instance-stopped'))
      const migrationRole = testId('stand-in-migration-role')
      await control.command('waitFor', migrationRole)
      await control.command('select', migrationRole, { value: role.id })
      assert.equal(await control.command('getValue', migrationRole), role.id)

      assert.deepEqual(
        (await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })).roles,
        stoppedAccount.roles,
        'Cloud execution must preserve unrelated account-local roles'
      )
      await bind(control, USER, localDevice)
      await control.command('clickWhenEnabled', testId(`stand-in-overview-role-${historyRole.id}`))
      await control.command('waitFor', testId('stand-in-conversation'))
      await control.command('waitFor', localChat, { text: LOCAL_COMPLETE })
      assert.ok(
        (await rpc(control, 'runtime.stand_in.memory.list', { userId: USER })).items.some(
          row => row.id === memory.id
        ),
        'Stopping and switching devices must retain local memories'
      )
      // A peer can select the stopped cloud primary while this local role remains active.
      const linkedRoleRoute =
        '/stand-in?' +
        new URLSearchParams({
          userId: String(USER),
          deviceId: localDevice,
          profileId: historyRole.id,
        }).toString()
      const linkedRoleDefinition = (await readInitialAssistant()).assistant.definitions.find(
        definition => definition.roleId === historyRole.id
      )
      assert.equal(linkedRoleDefinition?.bot.spec.execution_policy.environment_id, localDevice)
      await setPrimaryDevice(CLOUD_DEVICE_ID)
      try {
        await reloadMainWindow(control)
        await control.command('waitFor', testId('stand-in-instance-stopped'))
        await control.command('navigate', 'body', { value: linkedRoleRoute })
        await control.command('waitFor', localChat, {
          text: LOCAL_COMPLETE,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', `${localChat} [data-testid="chat-message-input"]`, {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(await readPrimaryDevice(), CLOUD_DEVICE_ID)
        assert.equal(readProfile(remoteHome).lifecycle?.status, 'stopped')
      } finally {
        await setPrimaryDevice(localDevice)
        await control.command('navigate', 'body', { value: '/stand-in' })
        await reloadMainWindow(control)
        await control.command('waitFor', testId('stand-in-overview'))
      }
      await cloud.stopRemoteDockerExecutorAndWaitOffline()
      await observeDevice(control, REMOTE_DOCKER_DEVICE_ID, '离线')
      assert.equal(
        await readPrimaryDevice(),
        localDevice,
        'Inventory changes never switch the saved primary device'
      )
      await stop(control)
      await bind(control, USER, CLOUD_DEVICE_ID)
      await peerClient.verify(control, localDevice, {
        cloud,
        rpc,
        remoteRpc,
        readCloudAssistant,
        readPrimaryDevice,
        setPrimaryDevice,
        stop,
        observeDevice,
        sendChat,
        localPrimaryThreadId: localTurn.task.threadId,
      })
      const retainedBinding = await readStandInBinding(control, uiTimeoutMs)
      for (const key of ['target', 'version', 'status']) {
        assert.deepEqual(
          retainedBinding[key],
          staleBinding[key],
          'Account routing must ignore the old local binding'
        )
      }
      await verifyUnreachableSourceInitialization(control, readInitialAssistant)
      await verifyRegularBinding(control, localDevice)
      await writeFile(
        join(resultDir, 'stand-in-cloud-device-evidence.json'),
        JSON.stringify({
          firstUseDevice,
          selectedDevice: CLOUD_DEVICE_ID,
          roleId: role.id,
          taskId,
          modelRequests,
          realTurnCancelled: true,
          offlineBindingRetained: true,
          offlineSelectionSwitchVerified: true,
          offlineStoppingReloadVerified: true,
          offlineStoppingPeerVerified: true,
          simultaneousClientsVerified: true,
          unreachableSourceMigrated: true,
          localHistoryRetained: true,
          localMemoryRetained: true,
          foreignDesktopFallbackVerified: true,
          renamedOwnerRetained: true,
          notificationUserMismatchGuarded: true,
        })
      )
    },
  }
}
