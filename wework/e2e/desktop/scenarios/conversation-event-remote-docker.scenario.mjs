import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createBridgeScenario } from './stand-in-plugin-bridge.scenario.mjs'
import { createConversationEventDocker } from '../modules/conversation-event-docker.mjs'
import { createConversationEventModel } from '../modules/conversation-event-model.mjs'
import { modelRequestTexts } from '../modules/model-tool-output.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = 'WEWORK_REMOTE_DOCKER_EVENT'
const PROVIDER = '@test/connection-source/records'

// Backend, device routing, Docker, DSH, MCP and native sessions are real; only the model is simulated.
export function createDesktopScenario(options) {
  const base = createBridgeScenario(options)
  const { resultDir, workspacePath, uiTimeoutMs, workbenchReadyTimeoutMs, captureScreenshot } =
    options
  const model = createConversationEventModel({ markerPrefix: MARKER, providerId: PROVIDER })
  const deviceId = `wework-event-docker-${randomUUID()}`
  let cloud
  let docker
  let socket
  let phase = 'ordinary'
  let modelRequests = 0
  const evidence = []
  const records = []
  const save = () =>
    writeFile(
      join(resultDir, 'records.json'),
      JSON.stringify([{ id: 'archive-record', value: JSON.stringify(records) }])
    )
  async function rpc(method, params, { errorCode } = {}) {
    if (!socket) {
      const { io } = createRequire(
        new URL('../../../../packages/chat-core/package.json', import.meta.url)
      )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
      socket = io(`${cloud.backendUrl}/wework-runtime`, {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token: cloud.authToken },
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        timeout: uiTimeoutMs,
      })
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
        socket.connect()
      })
    }
    const ack = await socket.timeout(workbenchReadyTimeoutMs).emitWithAck('runtime:request', {
      type: 'request',
      id: randomUUID(),
      method,
      params,
      device_id: deviceId,
      timeout_seconds: workbenchReadyTimeoutMs / 1000,
    })
    if (errorCode) {
      assert.equal(ack.ok, false, `${method} must be denied`)
      assert.equal(ack.error?.code, errorCode, ack.error?.message)
      return
    }
    if (
      method === 'runtime.connections.catalog' &&
      ack.error?.code === 'connection_host_unavailable'
    )
      return null
    assert.equal(ack.ok, true, `${method}: ${ack.error?.message}`)
    return ack.result
  }
  async function backend(path, { method = 'GET', body, status } = {}) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const raw = await response.text()
    if (status) assert.equal(response.status, status, `${method} ${path}: ${raw}`)
    else assert.ok(response.ok, `${method} ${path}: ${raw}`)
    return raw && JSON.parse(raw)
  }
  async function createCancellationBinding(taskId) {
    await backend('/api/admin/setup-complete', { method: 'POST', body: {} })
    const owner = await backend('/api/users/me')
    const workspace = await backend('/api/v1/workspaces', {
      method: 'POST',
      body: { name: 'Remote event cancellation' },
    })
    const project = await backend(`/api/v1/workspaces/${workspace.id}/projects`, {
      method: 'POST',
      body: {
        name: 'Remote event cancellation',
        task_provider: 'local',
        visibility: 'private',
      },
    })
    const issue = await backend(`/api/v1/cloud-projects/${project.id}/loop-items`, {
      method: 'POST',
      body: { title: 'Cancel the release-document watch' },
    })
    const task = { deviceId, taskId }
    const bind = () =>
      backend(`/api/v1/loop-items/${issue.id}/tasks`, { method: 'POST', body: task })
    await bind()
    const path = '/api/v1/runtime-tasks/cloud-context'
    const query = new URLSearchParams({ device_id: deviceId, task_id: taskId })
    const context = await backend(`${path}?${query}`)
    assert.equal(context.task_user_id, owner.id)
    assert.equal(context.task_id, taskId)
    assert.equal(context.device_id, deviceId)
    assert.equal(String(context.loop_item_id), String(issue.id))
    assert.equal(String(context.cloud_project_id), String(project.id))
    return {
      bind,
      origin: {
        type: 'board_task',
        projectStore: 'cloud',
        cloudProjectId: String(project.id),
        loopItemId: String(issue.id),
      },
      unbind: async () => {
        await backend(path, { method: 'DELETE', body: task, status: 204 })
        await backend(`${path}?${query}`, { status: 404 })
      },
    }
  }
  async function verifyCloudCancellation(control, address, binding, readTask) {
    const key = `${MARKER}_cancel`
    const snapshot = async () => {
      const result = await backend('/api/runtime-observations/command', {
        method: 'POST',
        body: { action: 'get_task_subscriptions', deviceId, taskId: address.taskId },
      })
      assert.equal(result.subscriptions.length, 1)
      return result.subscriptions[0].subscription
    }
    const cancel = options =>
      rpc(
        'runtime.connections.subscriptions.cancel',
        { taskId: address.taskId, subscriptionKey: key },
        options
      )
    const active = async () =>
      (await readTask()).task.runtimeHandle.connectionEventSubscriptions?.some(
        item => item.subscription_key === key && item.status === 'armed'
      )
    const initial = await snapshot()
    assert.equal(initial.status, 'armed')
    assert.equal(initial.subscriptionKey, key)
    const requestsBefore = modelRequests
    await binding.unbind()
    try {
      await cancel({ errorCode: 'permission_denied' })
      assert.equal(await active(), true)
      assert.equal(
        (await snapshot()).status,
        'armed',
        'Denied cancellation must preserve the watch'
      )
    } finally {
      await binding.bind()
    }

    await open(control, address)
    const status = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="connection-event-status"]`
    await control.command('waitFor', status, {
      text: '等待事件，到达后自动继续',
    })
    await control.command(
      'clickWhenEnabled',
      `${status} [data-testid="cancel-connection-event-subscription"]`
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="connection-event-cancel-feedback"]`,
      { text: '已取消' }
    )
    await control.command('waitFor', status, { visible: false })
    const cancelled = await waitForValue(
      snapshot,
      subscription => subscription.status === 'cancelled',
      'The Cancel watch button must cancel the real Backend subscription',
      uiTimeoutMs
    )
    assert.equal(cancelled.id, initial.id)
    assert.equal(cancelled.subscriptionKey, key)
    assert.ok(!(await active()), 'The cancelled watch must leave the active Runtime projection')

    const receipt = await cancel()
    assert.equal(receipt.subscription.subscription_key, key)
    assert.equal(receipt.subscription.status, 'cancelled')
    assert.equal(modelRequests, requestsBefore, 'Cancellation must not invoke the model')
  }
  const open = async (control, address) => {
    await control.command('navigate', 'body', {
      value: `/runtime-tasks?${new URLSearchParams(address)}`,
    })
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      { text: `${MARKER}_${phase}_WAITING`, timeoutMs: workbenchReadyTimeoutMs }
    )
  }
  async function assertRecoveredUi(control) {
    for (const id of ['runtime-transcript-error', 'environment-read-error'])
      await control.command('waitFor', `[data-testid="${id}"]`, {
        visible: false,
        timeoutMs: workbenchReadyTimeoutMs,
      })
    await control.command('waitFor', '[data-testid="environment-device-name"]', {
      text: 'Event recovery Remote Docker',
    })
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
      value: 'Check the restored conversation',
    })
    await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, { enabled: true })
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '' })
  }
  return {
    requiresCloudEnvironment: true,
    backendEnv: {
      WEGENT_RS_JOB_ALLOWLIST: 'runtime_observation_collectors,runtime_observation_deliveries',
      SCHEDULED_TASKS_ENABLED: 'true',
      EMBEDDED_CELERY_ENABLED: 'true',
    },
    setCloudEnvironment(value) {
      cloud = value
    },
    async prepareApp(context) {
      await base.prepareApp(context)
      await save()
      await chmod(join(resultDir, 'calls.jsonl'), 0o666)
      await cp(
        new URL('../fixtures/conversation-events-provider.mjs', import.meta.url),
        join(resultDir, 'connection-adapter/index.js')
      )
      const adapterPath = join(resultDir, 'connection-adapter/package.json')
      const adapter = JSON.parse(await readFile(adapterPath, 'utf8'))
      const declaration = adapter.wework.connections
      declaration.dependencies['source-copy'] = structuredClone(declaration.dependencies.source)
      declaration.providers[0].uses.push('source-copy')
      await writeFile(adapterPath, JSON.stringify(adapter))
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!modelRequestTexts(body).includes(MARKER)) return false
      modelRequests++
      const id = `remote-docker-event-${modelRequests}`
      const completion = responseCompleted(id)
      completion.response.usage = {
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 3,
        output_tokens_details: null,
        total_tokens: 14,
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), ...model.events(body, phase), completion]))
      return true
    },
    async verify(control) {
      await cloud.stopRemoteDockerExecutorAndWaitOffline()
      docker = await createConversationEventDocker({
        cloud,
        resultDir,
        workspacePath,
        timeoutMs: workbenchReadyTimeoutMs,
        deviceId,
      })
      const pluginPath = join(resultDir, 'connection-marketplace/source/.codex-plugin/plugin.json')
      const plugin = JSON.parse(await readFile(pluginPath, 'utf8'))
      plugin.mcpServers.records.command = docker.nodeExecutable
      await writeFile(pluginPath, JSON.stringify(plugin))
      let containerId = await docker.start()
      await rpc('runtime.codex.app_server.request', {
        method: 'marketplace/add',
        params: { source: join(resultDir, 'connection-marketplace') },
      })
      await waitForValue(
        () => rpc('runtime.connections.catalog', {}),
        value => value?.items?.some(item => item.id === PROVIDER),
        'The delivered Remote Docker source provider must register before installation',
        workbenchReadyTimeoutMs
      )
      await rpc('runtime.connections.dependencies.install', {
        providerId: PROVIDER,
        aliases: ['source', 'source-copy'],
      })
      const catalog = await rpc('runtime.runner.catalog', {})
      const selectedModel = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
      assert.ok(selectedModel)
      for (const story of ['ordinary', 'goal', 'pause', 'cancel']) {
        phase = story
        const taskId = `remote-event-${phase}-${randomUUID()}`
        const address = {
          deviceId,
          taskId,
          workspacePath,
          runtime: 'codex',
        }
        const binding = phase === 'cancel' ? await createCancellationBinding(taskId) : null
        const prompt = `${MARKER}_${phase} 请订阅发布文档变化，在原会话继续处理。`
        const created = await rpc('runtime.tasks.create', {
          taskId,
          workspacePath,
          runtime: 'codex',
          message: prompt,
          ...(binding && { cloudProjectId: binding.origin.cloudProjectId, origin: binding.origin }),
          executionRequest: {
            task_id: taskId,
            subtask_id: `${taskId}-initial`,
            prompt,
            new_session: true,
            ...(binding && { auth_token: cloud.authToken }),
            bot: [{ shell_type: 'Codex' }],
            model_config: {
              model_id: selectedModel.local_model_id,
              model_provider: selectedModel.provider,
              runtime_config: { codex: { use_user_config: true, configured: true } },
            },
          },
        })
        assert.equal(created.accepted, true)
        const readTask = () => rpc('runtime.tasks.get', { address })
        const before = await waitForValue(
          readTask,
          value =>
            !value.task.running &&
            value.task.runtimeHandle?.connectionEventSubscriptions?.some(
              item => item.subscription_key === `${MARKER}_${phase}` && item.status === 'armed'
            ),
          'The remote model must arm a real source wait',
          workbenchReadyTimeoutMs
        )
        const originalGoal =
          phase === 'ordinary' ? null : (await rpc('runtime.tasks.goal.get', { address })).goal
        const armedRequests = modelRequests
        await waitForValue(
          async () => {
            assert.equal(
              modelRequests,
              armedRequests,
              'Waiting for source collection must not poll the model'
            )
            return readTask()
          },
          value =>
            value.task.runtimeHandle.connectionEventSubscriptions.some(
              item =>
                item.subscription_key === `${MARKER}_${phase}` &&
                item.last_collected_at &&
                !item.error_code
            ),
          'The real source must complete a collection before stable waiting is shown',
          workbenchReadyTimeoutMs
        )
        if (binding) {
          assert.deepEqual(before.task.runtimeHandle.origin, binding.origin)
          await verifyCloudCancellation(control, address, binding, readTask)
          continue
        }
        const nativeTurns = async () => {
          const result = await rpc('runtime.tasks.transcript', { address, refresh: true })
          await writeFile(
            join(resultDir, `remote-event-${phase}-transcript.json`),
            JSON.stringify(result)
          )
          assert.equal(result.threadId, before.task.threadId)
          assert.ok(Array.isArray(result.turns))
          return result.turns.map(turn => turn.id)
        }
        const originalTurns = await nativeTurns()
        if (originalGoal) {
          assert.equal(originalGoal.status, 'blocked')
          assert.equal(originalGoal.tokenBudget, 20000)
        }
        await open(control, address)
        await control.command('waitFor', '[data-testid="connection-event-status"]', {
          text: '等待事件，到达后自动继续',
        })
        await captureScreenshot(control, `remote-event-${phase}-waiting.png`)
        if (phase === 'pause') {
          await control.command('clickWhenEnabled', '[data-testid="pause-goal-button"]')
          await control.command('waitFor', '[data-testid="connection-event-status"]', {
            visible: false,
          })
        }
        const requestsBefore = modelRequests
        const oldDevice = await cloud.device(deviceId)
        assert.equal(await docker.destroy(), containerId)
        const summaryToggle = '[data-testid="environment-info-button"]'
        if (
          (await control.command('getAttribute', summaryToggle, { value: 'aria-expanded' })) ===
          'true'
        ) {
          await control.command('click', summaryToggle)
          await control.command('waitFor', '[data-testid="environment-info-popover"]', {
            visible: false,
          })
        }
        await control.command('click', summaryToggle)
        await control.command('waitFor', '[data-testid="environment-read-error"]', {
          text: 'Event recovery Remote Docker',
        })
        if (phase !== 'pause') {
          const status = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="connection-event-status"]`
          await control.command('waitFor', status, { text: '设备离线，恢复后可取消' })
          assert.doesNotMatch(await control.command('getText', status), /需升级执行器/)
        }
        await captureScreenshot(control, `remote-event-${phase}-offline.png`)
        const event = {
          id: `${phase}-real-record-change`,
          eventType: 'message.received',
          topicId: 'release-document',
          text: `${MARKER}_${phase}_EVENT_RECEIVED`,
          at: new Date().toISOString(),
        }
        records.push(event, event)
        await save()
        const deadline = Date.now() + 1500
        while (Date.now() < deadline) {
          assert.equal(
            modelRequests,
            requestsBefore,
            'A destroyed execution container cannot poll the model'
          )
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        const replacementId = await docker.start()
        assert.notEqual(replacementId, containerId, 'The old container must actually be destroyed')
        const newDevice = await cloud.device(deviceId)
        assert.equal(newDevice.runtime_instance_id, oldDevice.runtime_instance_id)
        if (phase === 'pause') {
          const deadline = Date.now() + 17000
          while (Date.now() < deadline) {
            assert.equal(
              modelRequests,
              requestsBefore,
              'A preserved human pause must prevent event wakeup after recreation'
            )
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          const paused = (await rpc('runtime.tasks.goal.get', { address })).goal
          assert.equal(paused.status, 'paused')
          assert.equal(paused.createdAt, originalGoal.createdAt)
          assert.equal(paused.tokenBudget, originalGoal.tokenBudget)
          assert.equal(paused.tokensUsed, originalGoal.tokensUsed)
          const preserved = await readTask()
          assert.equal(preserved.task.threadId, before.task.threadId)
          assert.ok(
            !preserved.task.runtimeHandle.connectionEventSubscriptions.some(
              item => item.subscription_key === `${MARKER}_${phase}`
            ),
            'Cancelled subscriptions leave the active conversation projection'
          )
          const snapshotResponse = await fetch(
            `${cloud.backendUrl}/api/runtime-observations/command`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${cloud.authToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                action: 'get_task_subscriptions',
                deviceId: address.deviceId,
                taskId,
              }),
            }
          )
          assert.equal(snapshotResponse.status, 200)
          const snapshot = await snapshotResponse.json()
          assert.equal(snapshot.subscriptions.length, 1)
          assert.equal(snapshot.subscriptions[0].subscription.status, 'cancelled')
          assert.deepEqual(await nativeTurns(), originalTurns)
          await assertRecoveredUi(control)
          await control.command('waitFor', '[data-testid="goal-status-bar"]', { text: '已暂停' })
          await captureScreenshot(control, 'remote-event-paused-after-recreation.png')
        } else {
          const after = await waitForValue(
            readTask,
            value =>
              !value.task.running &&
              model.completed.has(phase) &&
              value.task.runtimeHandle?.connectionEventSubscriptions?.some(
                item =>
                  item.subscription_key === `${MARKER}_${phase}` && item.status === 'delivered'
              ),
            'The replacement container must resume the original conversation once',
            workbenchReadyTimeoutMs
          )
          assert.equal(after.task.threadId, before.task.threadId)
          await docker.captureNativeHistory(before.task.threadId, phase)
          if (originalGoal) {
            const completedGoal = (await rpc('runtime.tasks.goal.get', { address })).goal
            assert.equal(completedGoal.status, 'complete')
            assert.equal(completedGoal.createdAt, originalGoal.createdAt)
            assert.equal(completedGoal.tokenBudget, originalGoal.tokenBudget)
          }
          await open(control, address)
          await control.command(
            'waitFor',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
            { text: `${MARKER}_${phase}_DONE` }
          )
          await control.command('waitFor', '[data-testid="connection-event-status"]', {
            visible: false,
          })
          await assertRecoveredUi(control)
          const deliveryNote = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="connection-event-message"]`
          await control.command('waitFor', deliveryNote, { text: '发布文档' })
          const deliveryText = await control.command('getText', deliveryNote)
          assert.match(deliveryText, /发布文档/)
          assert.doesNotMatch(deliveryText, /Wework connection event delivery|"events"\s*:/)
          assert.doesNotMatch(deliveryText, new RegExp(MARKER))
          await captureScreenshot(control, `remote-event-${phase}-continued.png`)
          const completedRequests = modelRequests
          const dedupeDeadline = Date.now() + 17000
          while (Date.now() < dedupeDeadline) {
            assert.equal(
              modelRequests,
              completedRequests,
              'Duplicate source records must not start another model turn in a later collection cycle'
            )
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          const continuedTurns = await nativeTurns()
          assert.deepEqual(continuedTurns.slice(0, originalTurns.length), originalTurns)
          assert.equal(
            continuedTurns.length,
            originalTurns.length + 1,
            'A duplicate source record must produce exactly one new native turn'
          )
        }
        evidence.push({
          phase,
          originalContainer: containerId,
          replacementContainer: replacementId,
          deviceId: address.deviceId,
          taskId,
          nativeThreadId: before.task.threadId,
          goal: originalGoal,
        })
        containerId = replacementId
      }
      await docker.evidence({ cases: evidence, modelRequests })
    },
    async cleanup() {
      socket?.disconnect()
      await docker?.cleanup()
    },
    diagnostics() {
      return { phase, modelRequests, cases: evidence }
    },
  }
}
