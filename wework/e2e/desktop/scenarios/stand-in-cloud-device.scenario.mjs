import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { findRuntimeWorkTask } from '../modules/runtime-task-evidence.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID, selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 1
const MULTIPLE = 'Cloud stand-in selected device'
const SINGLE = 'Cloud stand-in automatic device'
const PROMPT = 'CLOUD_STAND_IN_DEVICE_EXECUTION'
const COMPLETE = 'CLOUD_STAND_IN_DEVICE_EXECUTION_COMPLETE'

function readRoles(home) {
  const database = new DatabaseSync(join(home, 'data/tasks.sqlite'), { readOnly: true })
  try {
    return database
      .prepare(
        "SELECT metadata FROM loop_items WHERE resource_type='personal_stand_in' AND json_extract(metadata,'$.userId')=?"
      )
      .all(USER)
      .flatMap(row => JSON.parse(row.metadata).roles)
  } finally {
    database.close()
  }
}

// User stories: select among real cloud devices, run remotely, auto-use the sole
// remaining device, and recover through Cloud work when all devices are offline.
export function createDesktopScenario({
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let cloud
  let modelRequests = 0
  async function observeOffline(control, id) {
    await control.command('navigate', 'body', { value: '/cloud-work' })
    await control.command(
      'waitFor',
      `[data-testid="connection-device-${id}"] [data-testid="connection-device-status"]`,
      {
        text: '离线',
        timeoutMs: workbenchReadyTimeoutMs,
      }
    )
    await control.command('navigate', 'body', { value: '/stand-in' })
  }
  async function saveRole(control, name) {
    await control.command('fill', '[data-testid="stand-in-role-name"]', { value: name })
    await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
    await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
  }
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (!JSON.stringify(body.input ?? []).includes(PROMPT)) return false
      modelRequests++
      const id = `cloud-stand-in-${modelRequests}`
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end(createSse([responseCreated(id), assistantMessage(COMPLETE), responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const initial = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      const remoteHome = dirname(cloud.remoteCodexHome)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await control.command('waitFor', '[data-testid="stand-in-device"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-role-name"]'),
        '0',
        'Do not initialize a profile before device selection'
      )
      await control.command('select', '[data-testid="stand-in-device"]', { value: CLOUD_DEVICE_ID })
      await saveRole(control, MULTIPLE)
      const role = readRoles(remoteHome).find(row => row.name === MULTIPLE)
      assert.ok(role, 'The selected cloud Executor must persist the role')
      assert.equal(role.executionDeviceId, CLOUD_DEVICE_ID)
      await control.command('clickWhenEnabled', `[data-testid="stand-in-overview-role-${role.id}"]`)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
      const chat = '[data-testid="stand-in-conversation"]'
      await selectE2EModel(control, undefined, undefined, chat)
      await control.command('fill', `${chat} [data-testid="chat-message-input"]`, { value: PROMPT })
      await control.command('press', `${chat} [data-testid="chat-message-input"]`, { key: 'Enter' })
      await control.command('waitFor', chat, { text: COMPLETE, timeoutMs: modelResponseTimeoutMs })
      const taskId = `stand-in-chat-${USER}-role-${role.id}`
      const remoteIndex = JSON.parse(
        await readFile(join(remoteHome, 'runtime-work/index.json'), 'utf8')
      )
      assert.ok(
        remoteIndex.tasks[taskId]?.thread_id,
        'The real remote Executor must own the Codex conversation'
      )
      const localTasks = await requestExecutor(control, 'runtime.tasks.list', {}, uiTimeoutMs)
      assert.equal(localTasks.coverage.authorized_index_complete, true)
      assert.equal(
        findRuntimeWorkTask(localTasks.workspaces, taskId),
        undefined,
        'The local Executor must not own this conversation'
      )
      await cloud.stopRemoteDockerExecutorAndWaitOffline()
      await observeOffline(control, REMOTE_DOCKER_DEVICE_ID)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-device"]'),
        '0',
        'One available cloud device requires no picker'
      )
      await saveRole(control, SINGLE)
      assert.equal(
        readRoles(remoteHome).find(row => row.name === SINGLE)?.executionDeviceId,
        CLOUD_DEVICE_ID
      )
      const local = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      assert.deepEqual(local.roles, initial.roles, 'Cloud creation must preserve the local profile')
      await stopProcessGroup(cloud.remoteExecutor)
      await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
      await observeOffline(control, CLOUD_DEVICE_ID)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await control.command('waitFor', '[data-testid="stand-in-open-cloud-work"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-role-name"]'),
        '0'
      )
      await control.command('click', '[data-testid="stand-in-open-cloud-work"]')
      await control.command('waitFor', '[data-testid="cloud-work-page"]')
      await writeFile(
        join(resultDir, 'stand-in-cloud-device-evidence.json'),
        JSON.stringify({
          selectedDevice: CLOUD_DEVICE_ID,
          roleId: role.id,
          taskId,
          modelRequests,
          singleDevice: true,
          noLocalFallback: true,
        })
      )
    },
  }
}
