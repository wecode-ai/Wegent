import { openStandInConversationFromHome } from '../modules/stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  chooseStandInExecutionDevice,
  readStandInBinding,
} from '../modules/stand-in-instance-flows.mjs'
import { findRuntimeWorkTask } from '../modules/runtime-task-evidence.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { CLOUD_DEVICE_ID, fetchJson } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 1
const PROMPT = 'CLOUD_STAND_IN_DEVICE_EXECUTION'
const COMPLETE = 'CLOUD_STAND_IN_DEVICE_EXECUTION_COMPLETE'
const REOPEN_PROMPT = 'CLOUD_STAND_IN_VERIFY_REOPENED_RELAY'
const REOPEN_COMPLETE = 'CLOUD_STAND_IN_REOPENED_RELAY_CONFIRMED'
const PREVIOUS_ADDRESS = 'https://previous-stand-in.example.invalid/api'
const HOLD = 'CLOUD_STAND_IN_STOP_RUNNING_CONVERSATION'
const LOCAL_PROMPT = 'LOCAL_STAND_IN_DEVICE_HISTORY'
const LOCAL_COMPLETE = 'LOCAL_STAND_IN_HISTORY_PRESERVED'
const testId = id => `[data-testid=${JSON.stringify(id)}]`

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

// Exercise cloud execution, cancellation and reopening through the account assistant.
export function createDesktopScenario({
  resultDir,
  uiTimeoutMs,
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
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ collaborationExperienceEnabled: false }),
      })
      const localDevice = JSON.parse(
        await control.command('getLocalExecutorStatus', 'body')
      ).deviceId
      for (const invoke of [(method, params) => rpc(control, method, params), remoteRpc]) {
        await invoke('runtime.stand_in.onboarding.complete', {
          userId: USER,
          weeklyReview: false,
          language: 'zh-CN',
        })
      }

      const readAssistant = async () =>
        (
          await fetchJson(cloud.backendUrl + '/api/v1/personal-assistant', {
            headers: { Authorization: 'Bearer ' + cloud.authToken },
            signal: AbortSignal.timeout(uiTimeoutMs),
          })
        ).assistant
      await control.command('navigate', 'body', { value: '/stand-in' })
      const composer = testId('stand-in-conversation')
      const input = `${composer} [data-testid="chat-message-input"]`
      const openAssistant = () => openStandInConversationFromHome(control, input, uiTimeoutMs)
      await openAssistant()
      assert.equal((await binding(control)).status, 'unbound')
      assert.equal((await readAssistant()).definitions[0].team.spec.collaborationModel, 'solo')

      const choose = async device => {
        await chooseStandInExecutionDevice(control, device, uiTimeoutMs, () =>
          until(
            readAssistant,
            account => account.definitions[0].bot.spec.execution_policy.environment_id === device,
            'The account default must record the device chosen in Manage Assistant',
            uiTimeoutMs
          )
        )
        await openAssistant()
      }
      const sendChat = async text => {
        await control.command('fill', input, { value: text })
        await control.command('clickWhenEnabled', `${composer} [data-testid="send-message-button"]`)
      }
      const taskId = `stand-in-chat-${USER}-primary`
      await choose(CLOUD_DEVICE_ID)
      const remoteHome = dirname(cloud.remoteCodexHome)
      const issuesBefore = readConversationIssueState(remoteHome, taskId)
      assert.deepEqual(issuesBefore.bindings, [])
      await sendChat(PROMPT)
      await control.command('waitFor', composer, {
        text: COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const remoteTask = () => remoteRpc('runtime.tasks.get', { taskId })
      const completed = await until(
        remoteTask,
        result => result.task?.status === 'done' && result.task.running !== true,
        'The cloud Executor must finish the assistant turn',
        modelResponseTimeoutMs
      )
      assert.ok(completed.task.threadId)
      const localTasks = await rpc(control, 'runtime.tasks.list', {})
      assert.equal(localTasks.coverage.authorized_index_complete, true)
      assert.equal(findRuntimeWorkTask(localTasks, taskId), undefined)

      await sendChat(HOLD)
      await until(
        () => heldRequestSeen,
        Boolean,
        'Cloud Codex must start the held turn',
        modelResponseTimeoutMs
      )
      await remoteRpc('runtime.stand_in.personal.lifecycle', { userId: USER, operation: 'stop' })
      await until(() => heldConnectionClosed, Boolean, 'Stopping must cancel the real model stream')
      const cancelled = await until(
        remoteTask,
        result => result.task?.status === 'cancelled' && result.task.running === false,
        'The cloud Executor must project native cancellation',
        modelResponseTimeoutMs
      )
      assert.equal(cancelled.task.threadId, completed.task.threadId)
      assert.deepEqual(readConversationIssueState(remoteHome, taskId), issuesBefore)

      const stale = await saveBinding(control, {
        userId: USER,
        deviceId: localDevice,
        backendUrl: PREVIOUS_ADDRESS,
      })
      await remoteRpc('runtime.stand_in.personal.lifecycle', { userId: USER, operation: 'start' })
      await reloadMainWindow(control)
      await openAssistant()
      await control.command('waitFor', composer, { text: COMPLETE })
      await sendChat(REOPEN_PROMPT)
      await control.command('waitFor', composer, {
        text: REOPEN_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const reopened = await until(
        remoteTask,
        result => result.task?.status === 'done' && result.task.running !== true,
        'The cloud Executor must finish the reopened conversation',
        modelResponseTimeoutMs
      )
      assert.equal(reopened.task.threadId, completed.task.threadId)
      assert.deepEqual(await binding(control), stale)

      await cloud.stopRemoteDockerExecutorAndWaitOffline()
      await stopProcessGroup(cloud.remoteExecutor)
      await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
      await reloadMainWindow(control)
      await control.command('waitFor', testId('stand-in-overview-retry'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        (await readAssistant()).definitions[0].bot.spec.execution_policy.environment_id,
        CLOUD_DEVICE_ID
      )
      await choose(localDevice)
      await sendChat(LOCAL_PROMPT)
      await control.command('waitFor', composer, {
        text: LOCAL_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      const local = await rpc(control, 'runtime.tasks.get', { taskId })
      assert.ok(local.task.threadId)
      assert.notEqual(local.task.threadId, completed.task.threadId)
      assert.deepEqual(await binding(control), stale)
      await captureScreenshot(control, 'personal-assistant-switched-from-offline-device.png')
      await writeFile(
        join(resultDir, 'stand-in-cloud-device-evidence.json'),
        JSON.stringify({
          taskId,
          modelRequests,
          cloudThread: completed.task.threadId,
          localThread: local.task.threadId,
        })
      )
    },
  }
}
