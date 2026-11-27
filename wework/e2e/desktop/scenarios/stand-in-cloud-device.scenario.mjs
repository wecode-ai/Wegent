import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { openStandInDetails, openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  bindStoppedStandIn,
  finishStandInOnboarding,
  readStandInBinding,
  stopBoundStandIn,
} from '../modules/stand-in-instance-flows.mjs'
import { findRuntimeWorkTask } from '../modules/runtime-task-evidence.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
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
}) {
  let cloud
  let modelRequests = 0
  let heldResponse
  let heldRequestSeen = false
  let heldConnectionClosed = false
  let remoteSocket
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const binding = control => readStandInBinding(control, uiTimeoutMs)
  const stop = control => stopBoundStandIn(control, uiTimeoutMs)
  const bind = (control, user, device) => bindStoppedStandIn(control, user, device, uiTimeoutMs)
  const saveBinding = async (control, target) =>
    rpc(control, 'runtime.stand_in.binding', {
      operation: 'bind',
      version: (await binding(control)).version,
      target,
    })
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
  async function verifySavedLocalBinding(control, localDevice) {
    const original = await saveBinding(control, {
      userId: USER,
      deviceId: localDevice,
      backendUrl: PREVIOUS_ADDRESS,
    })
    await rpc(control, 'runtime.stand_in.personal.lifecycle', {
      userId: USER,
      operation: 'start',
    })
    await reloadMainWindow(control)
    await control.command('waitFor', testId('stand-in-overview'))
    assert.deepEqual(await binding(control), original)
    await stop(control)
  }

  async function verifyRegularBinding(control, localDevice, backendUrl) {
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
      await control.command('setCloudSessionToken', 'body', { value: session.access_token })
      await rpc(control, 'runtime.stand_in.onboarding.complete', {
        userId: member.id,
        weeklyReview: false,
        language: 'zh-CN',
      })
      const registered = { userId: member.id, deviceId: localDevice, backendUrl }
      await saveBinding(control, registered)
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
      const readCloudAssistant = () =>
        fetchJson(`${cloud.backendUrl}/api/v1/personal-assistant`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
      assert.equal((await readCloudAssistant()).assistant, null)
      await reloadMainWindow(control)
      const migrateConfirm = testId('personal-assistant-account-migrate-confirm')
      await control.command('waitFor', migrateConfirm, { timeoutMs: uiTimeoutMs })
      await captureScreenshot(control, 'personal-assistant-01-migration-confirmation.png')
      await control.command('clickWhenEnabled', testId('personal-assistant-account-migrate-cancel'))
      await control.command('waitFor', migrateConfirm, { visible: false, timeoutMs: uiTimeoutMs })
      assert.equal(
        (await readCloudAssistant()).assistant,
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
      const shared = (await readCloudAssistant()).assistant
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
      assert.deepEqual((await binding(control)).target, registered)

      await createRole(control, 'Ordinary account stand-in')
      const profile = await rpc(control, 'runtime.stand_in.personal.get', { userId: member.id })
      const role = profile.roles.find(row => row.name === 'Ordinary account stand-in')
      assert.ok(role)
      const sharedRole = (await readCloudAssistant()).assistant.definitions.find(
        definition => definition.roleId === role.id
      )
      assert.equal(
        sharedRole?.bot.metadata.displayName,
        role.name,
        'New roles are saved to the cloud'
      )
      await stop(control)
      const aliased = await saveBinding(control, {
        ...registered,
        backendUrl: PREVIOUS_ADDRESS,
      })
      await rpc(control, 'runtime.stand_in.personal.lifecycle', {
        userId: member.id,
        operation: 'start',
      })
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
      assert.deepEqual(await binding(control), aliased)
      await stop(control)

      const otherOwner = await saveBinding(control, { ...registered, userId: USER })
      await reloadMainWindow(control)
      await control.command('waitFor', testId('stand-in-instance-owner-unavailable'))
      assert.deepEqual(await binding(control), otherOwner)
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
    async cleanup() {
      heldResponse?.end()
      remoteSocket?.disconnect()
    },
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const input = JSON.stringify(body.input ?? [])
      const reopened = input.includes(REOPEN_PROMPT)
      if (
        !reopened &&
        !input.includes(PROMPT) &&
        !input.includes(LOCAL_PROMPT) &&
        !input.includes(HOLD)
      )
        return false
      modelRequests++
      const id = `cloud-stand-in-${modelRequests}`
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (!reopened && input.includes(HOLD)) {
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
              reopened ? REOPEN_COMPLETE : input.includes(LOCAL_PROMPT) ? LOCAL_COMPLETE : COMPLETE
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
      const localIdentity = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      const localDevice = localIdentity.deviceId
      const remoteHome = dirname(cloud.remoteCodexHome)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ collaborationExperienceEnabled: true }),
      })
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', testId('stand-in-onboarding-setup'))
      const beforeSetup = await binding(control)
      assert.equal(beforeSetup.status, 'unbound')
      assert.equal(beforeSetup.target, null)
      assert.equal(
        await control.command('getElementCount', testId('stand-in-device')),
        '0',
        'Onboarding must not switch an active instance binding'
      )
      await control.command('clickWhenEnabled', testId('stand-in-onboarding-continue'))
      await control.command('clickWhenEnabled', testId('stand-in-onboarding-complete'))
      await control.command('waitFor', testId('stand-in-onboarding'), { visible: false })
      const firstUse = await binding(control)
      assert.equal(firstUse.status, 'active')
      assert.ok(firstUse.target, 'Confirmed onboarding must bind a device')
      assert.equal(firstUse.target.userId, USER)
      assert.equal('username' in firstUse.target, false)
      assert.ok(firstUse.target.backendUrl)
      assert.ok(
        [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].includes(firstUse.target.deviceId),
        'First use may bind an available cloud device'
      )
      const readInitialAssistant = () =>
        fetchJson(`${cloud.backendUrl}/api/v1/personal-assistant`, {
          headers: { Authorization: `Bearer ${cloud.authToken}` },
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
      const initialAssistant = (await readInitialAssistant()).assistant
      assert.equal(initialAssistant.definitions[0].roleId, '@primary')
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ collaborationExperienceEnabled: false }),
      })
      await control.command('waitFor', testId('stand-in-overview'), { visible: true })
      const executionDevice = testId('personal-assistant-execution-device')
      async function openExecutionSettings() {
        await openStandInDetails(control)
        assert.equal(await control.command('getElementCount', executionDevice), '0')
        await openStandInSettings(control)
        await control.command('clickWhenEnabled', testId('stand-in-primary-execution-toggle'))
      }
      const activeBinding = await binding(control)
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
      const localTurn = await rpc(control, 'runtime.tasks.get', {
        taskId: `stand-in-chat-${USER}-primary`,
      })
      assert.ok(localTurn.task.threadId, 'The selected local Executor must own the conversation')
      assert.deepEqual(
        await binding(control),
        activeBinding,
        'Execution selection preserves the binding'
      )
      assert.equal(
        (await readInitialAssistant()).assistant.definitions[0].bot.spec.execution_policy
          .environment_id,
        localDevice
      )
      await openExecutionSettings()
      await control.command('clickWhenEnabled', executionDevice)
      await control.command(
        'clickWhenEnabled',
        `[role="listbox"] [role="option"][data-value=${JSON.stringify(firstUse.target.deviceId)}]`
      )
      await control.command('waitFor', `${executionDevice}:not(:disabled)`, {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        (await readInitialAssistant()).assistant.definitions[0].bot.spec.execution_policy
          .environment_id,
        firstUse.target.deviceId
      )
      await control.command('clickWhenEnabled', testId('stand-in-primary-profile-close'))
      await stop(control)
      if (firstUse.target.deviceId !== CLOUD_DEVICE_ID) {
        await bind(control, USER, CLOUD_DEVICE_ID)
        await finishStandInOnboarding(control)
        await stop(control)
      }
      await bind(control, USER, localDevice)
      await createRole(control, 'Account-local history')
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const historyRole = initial.roles.find(row => row.name === 'Account-local history')
      assert.ok(historyRole)
      const localChat = await chat(control, historyRole.id, LOCAL_PROMPT)
      await control.command('waitFor', localChat, {
        text: LOCAL_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      await stop(control)
      const stoppedAccount = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      await saveBinding(control, { userId: 0, deviceId: localDevice, backendUrl: '' })
      await rpc(control, 'runtime.stand_in.personal.lifecycle', { userId: 0, operation: 'start' })
      const legacy = await rpc(control, 'runtime.stand_in.personal.get', { userId: 0 })
      await rpc(control, 'runtime.stand_in.personal.save', {
        userId: 0,
        settings: { ...legacy, roles: [{ ...historyRole, name: LOCAL_NAME, id: 'legacy-role' }] },
      })
      await reloadMainWindow(control)
      const localBefore = await rpc(control, 'runtime.stand_in.personal.get', { userId: 0 })
      const localRole = localBefore.roles.find(row => row.name === LOCAL_NAME)
      assert.ok(localRole, 'The existing local profile must retain its role')
      const memory = await rpc(control, 'runtime.stand_in.memory.save', {
        userId: 0,
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
      assert.equal(
        (await binding(control)).target.userId,
        0,
        'Connecting must not replace the existing local binding'
      )
      await control.command('waitFor', testId('stand-in-legacy-binding'))
      assert.equal(await control.command('getElementCount', testId('stand-in-conversation')), '0')
      await stop(control)
      const beforeMigration = readProfile(remoteHome)
      await control.command('waitFor', testId('stand-in-migration'))
      await control.command('select', testId('stand-in-migration-role'), { value: localRole.id })
      await control.command('select', testId('stand-in-migration-device'), {
        value: CLOUD_DEVICE_ID,
      })
      await control.command('clickWhenEnabled', testId('stand-in-migrate-open'))
      await control.command('clickWhenEnabled', testId('stand-in-migrate-cancel'))
      assert.deepEqual(
        readProfile(remoteHome),
        beforeMigration,
        'Cancelling migration must never write target settings'
      )
      await control.command('clickWhenEnabled', testId('stand-in-migrate-open'))
      await control.command('clickWhenEnabled', testId('stand-in-migrate-confirm'))
      await control.command('waitFor', testId('stand-in-role-name'))
      assert.equal(await control.command('getValue', testId('stand-in-role-name')), LOCAL_NAME)
      assert.equal((await binding(control)).target.deviceId, CLOUD_DEVICE_ID)
      const migrated = readProfile(remoteHome).roles.find(row => row.name === LOCAL_NAME)
      assert.ok(
        migrated,
        'Successful migration must retain portable responsibilities on the target'
      )
      const migratedDefinition = (await readInitialAssistant()).assistant.definitions.find(
        definition => definition.roleId === migrated.id
      )
      assert.equal(migratedDefinition?.bot.metadata.displayName, LOCAL_NAME)
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
        (await rpc(control, 'runtime.stand_in.personal.get', { userId: 0 })).lifecycle.status,
        'stopped',
        'The old whole stand-in must remain stopped after migration'
      )
      await control.command('clickWhenEnabled', testId('stand-in-close'))
      await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })
      await createRole(control, CLOUD_NAME, CLOUD_DEVICE_ID)
      const role = readProfile(remoteHome).roles.find(row => row.name === CLOUD_NAME)
      assert.ok(role, 'The bound real cloud Executor must persist the role')
      assert.equal(role.executionDeviceId, CLOUD_DEVICE_ID)
      assert.ok(
        !readProfile(remoteHome).roles.some(row => row.id === localRole.id),
        'Binding another profile must not copy local roles'
      )
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
        findRuntimeWorkTask(localTasks.workspaces, taskId),
        undefined,
        'Remote conversations must not run on the local Executor'
      )
      await control.command('fill', `${remoteChat} [data-testid="chat-message-input"]`, {
        value: HOLD,
      })
      await control.command('press', `${remoteChat} [data-testid="chat-message-input"]`, {
        key: 'Enter',
      })
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
      // Identity conversations have no business Issue. Read the owning Runtime's
      // native terminal state instead of requiring an unrelated Issue mutation.
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

      // Reopen the saved binding after the backend address changes.
      const original = await saveBinding(control, {
        userId: USER,
        deviceId: CLOUD_DEVICE_ID,
        backendUrl: PREVIOUS_ADDRESS,
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
      assert.deepEqual(
        await binding(control),
        original,
        'Reopening must preserve the saved binding'
      )
      await stop(control)
      const stoppedBinding = await binding(control)
      assert.equal(stoppedBinding.target.backendUrl, PREVIOUS_ADDRESS)
      await reloadMainWindow(control)
      await control.command('waitFor', testId('stand-in-instance-stopped'))
      const migrationRole = testId('stand-in-migration-role')
      await control.command('waitFor', migrationRole)
      await control.command('select', migrationRole, { value: role.id })
      assert.equal(await control.command('getValue', migrationRole), role.id)
      assert.deepEqual(await binding(control), stoppedBinding)

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
        (await rpc(control, 'runtime.stand_in.memory.list', { userId: 0 })).items.some(
          row => row.id === memory.id
        ),
        'Stopping and rebinding must retain local memories'
      )
      await cloud.stopRemoteDockerExecutorAndWaitOffline()
      await observeDevice(control, REMOTE_DOCKER_DEVICE_ID, '离线')
      assert.equal(
        (await binding(control)).target.deviceId,
        localDevice,
        'Inventory changes never switch an active binding'
      )
      await stop(control)
      await bind(control, USER, CLOUD_DEVICE_ID)
      await stopProcessGroup(cloud.remoteExecutor)
      await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
      await observeDevice(control, CLOUD_DEVICE_ID, '离线')
      await control.command('clickWhenEnabled', testId('stand-in-instance-stop'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', testId('stand-in-instance-stop-confirm'))
      await control.command('waitFor', testId('stand-in-instance-stop') + ':not(:disabled)')
      assert.equal(
        (await binding(control)).status,
        'stopping',
        'Offline cancellation must not unlock rebinding'
      )
      assert.equal(
        await control.command('getElementCount', testId(`stand-in-instance-bind-0-${localDevice}`)),
        '0'
      )
      await reloadMainWindow(control)
      await control.command('waitFor', testId('stand-in-instance-stopping'))
      await cloud.restartCloudExecutor()
      await observeDevice(control, CLOUD_DEVICE_ID, '在线')
      await stop(control)
      await verifySavedLocalBinding(control, localDevice)
      await verifyRegularBinding(control, localDevice, firstUse.target.backendUrl)
      await writeFile(
        join(resultDir, 'stand-in-cloud-device-evidence.json'),
        JSON.stringify({
          firstUseDevice: firstUse.target.deviceId,
          selectedDevice: CLOUD_DEVICE_ID,
          roleId: role.id,
          taskId,
          modelRequests,
          realTurnCancelled: true,
          offlineBindingRetained: true,
          localHistoryRetained: true,
          localMemoryRetained: true,
          userIdOnlyBinding: true,
          renamedOwnerRetained: true,
          differentUserIdRejected: true,
        })
      )
    },
  }
}
