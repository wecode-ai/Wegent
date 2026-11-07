import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  bindStoppedStandIn,
  readStandInBinding,
  stopBoundStandIn,
} from '../modules/stand-in-instance-flows.mjs'
import { findRuntimeWorkTask } from '../modules/runtime-task-evidence.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID, selectE2EModel } from '../modules/shared.mjs'
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

// The existing cloud checkpoint owns binding, actual cancellation and offline recovery.
export function createDesktopScenario({
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let cloud
  let modelRequests = 0
  let heldResponse
  let heldRequestSeen = false
  let heldConnectionClosed = false
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const binding = control => readStandInBinding(control, uiTimeoutMs)
  const stop = control => stopBoundStandIn(control, uiTimeoutMs)
  const bind = (control, user, device) => bindStoppedStandIn(control, user, device, uiTimeoutMs)
  async function createRole(control, name) {
    await control.command('clickWhenEnabled', testId('stand-in-create-role'))
    await control.command('waitFor', testId('stand-in-role-name'))
    assert.equal(
      await control.command('getElementCount', testId('stand-in-device')),
      '0',
      'Role creation must stay on the bound Executor'
    )
    await control.command('fill', testId('stand-in-role-name'), { value: name })
    await control.command('clickWhenEnabled', testId('stand-in-save'))
    await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })
  }
  async function chat(control, role, message) {
    await control.command('clickWhenEnabled', testId(`stand-in-overview-role-${role}`))
    await control.command('clickWhenEnabled', testId('stand-in-role-chat'))
    const selector = testId('stand-in-conversation')
    await selectE2EModel(control, undefined, undefined, selector)
    await control.command('fill', `${selector} [data-testid="chat-message-input"]`, {
      value: message,
    })
    await control.command('press', `${selector} [data-testid="chat-message-input"]`, {
      key: 'Enter',
    })
    return selector
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
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    async cleanup() {
      heldResponse?.end()
    },
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(PROMPT) && !input.includes(LOCAL_PROMPT) && !input.includes(HOLD))
        return false
      modelRequests++
      const id = `cloud-stand-in-${modelRequests}`
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (input.includes(HOLD)) {
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
            assistantMessage(input.includes(LOCAL_PROMPT) ? LOCAL_COMPLETE : COMPLETE),
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
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const localIdentity = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      const localDevice = localIdentity.deviceId
      const remoteHome = dirname(cloud.remoteCodexHome)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', testId('stand-in-onboarding-setup'))
      const firstUse = await binding(control)
      assert.ok(
        [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].includes(firstUse.target.deviceId),
        'First use may bind an available cloud device'
      )
      assert.equal(
        await control.command('getElementCount', testId('stand-in-device')),
        '0',
        'Onboarding must not switch an active instance binding'
      )
      await control.command('clickWhenEnabled', testId('stand-in-onboarding-continue'))
      await control.command('clickWhenEnabled', testId('stand-in-onboarding-complete'))
      await control.command('waitFor', testId('stand-in-onboarding'), { visible: false })
      await stop(control)
      await bind(control, 0, localDevice)
      await control.command('navigate', 'body', { value: '/settings/connections' })
      await control.command('clickWhenEnabled', testId('settings-cloud-disconnect-button'))
      await control.command('waitFor', testId('settings-cloud-connect-button'))
      await control.command('navigate', 'body', { value: '/stand-in' })
      await createRole(control, LOCAL_NAME)
      const localBefore = await rpc(control, 'runtime.stand_in.personal.get', { userId: 0 })
      const localRole = localBefore.roles.find(row => row.name === LOCAL_NAME)
      assert.ok(localRole, 'Signed-out creation must persist under the local owner')
      const localChat = await chat(control, localRole.id, LOCAL_PROMPT)
      await control.command('waitFor', localChat, {
        text: LOCAL_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const memory = await rpc(control, 'runtime.stand_in.memory.save', {
        userId: 0,
        memory: {
          content: 'Keep local responsibilities local',
          scope: { kind: 'role', roleId: localRole.id },
        },
      })
      await control.command('setCloudSessionToken', 'body', { value: cloud.authToken })
      await observeDevice(control, CLOUD_DEVICE_ID, '在线')
      assert.equal(
        (await binding(control)).target.userId,
        0,
        'Connecting must not replace the existing local binding'
      )
      await createRole(control, 'Local role with cloud available')
      const retained = await rpc(control, 'runtime.stand_in.personal.get', { userId: 0 })
      assert.ok(retained.roles.some(role => role.name === 'Local role with cloud available'))
      await stop(control)
      await bind(control, USER, CLOUD_DEVICE_ID)
      await createRole(control, CLOUD_NAME)
      const role = readProfile(remoteHome).roles.find(row => row.name === CLOUD_NAME)
      assert.ok(role, 'The bound real cloud Executor must persist the role')
      assert.equal(role.executionDeviceId, CLOUD_DEVICE_ID)
      assert.ok(
        !readProfile(remoteHome).roles.some(row => row.id === localRole.id),
        'Binding another profile must not copy local roles'
      )
      const remoteChat = await chat(control, role.id, PROMPT)
      await control.command('waitFor', remoteChat, {
        text: COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const taskId = `stand-in-chat-${USER}-role-${role.id}`
      const indexPath = join(remoteHome, 'runtime-work/index.json')
      assert.ok(JSON.parse(await readFile(indexPath, 'utf8')).tasks[taskId]?.thread_id)
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
      // The durable index intentionally omits live status. Assert the owning
      // Runtime's native terminal projection, in addition to stream cancellation.
      await until(
        () => readFile(cloud.remoteExecutorRuntimeLogPath, 'utf8'),
        log =>
          log
            .split('\n')
            .some(
              line =>
                line.includes('runtime task Issue status projected') &&
                line.includes(`local_task_id=${taskId} `) &&
                line.includes('execution_status=cancelled')
            ),
        'The real remote task must project its native cancelled outcome'
      )
      await bind(control, 0, localDevice)
      await control.command('clickWhenEnabled', testId(`stand-in-overview-role-${localRole.id}`))
      await control.command('clickWhenEnabled', testId('stand-in-role-chat'))
      await control.command('waitFor', localChat, { text: LOCAL_COMPLETE })
      assert.ok(
        (await rpc(control, 'runtime.stand_in.memory.list', { userId: 0 })).items.some(
          row => row.id === memory.id
        ),
        'Stopping and rebinding must retain local memories'
      )
      assert.deepEqual(
        (await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })).roles,
        initial.roles,
        'Cloud execution must preserve unrelated account-local roles'
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
      await control.command('clickWhenEnabled', testId('stand-in-instance-stop'))
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
      await bind(control, 0, localDevice)
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
        })
      )
    },
  }
}
