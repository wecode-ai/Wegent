import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { RuntimeEventProxy } from './runtime-event-proxy.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { currentExecutorPid } from './executor-restart-readiness.mjs'
import { waitForCompletedRuntimeTaskThread } from './runtime-task-evidence.mjs'
import { commandOutputAsync, fetchJson, repoDir } from './shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from './response-protocol.mjs'

const PREFIX = 'WEWORK_CI_NOTIFICATION_RECONNECT_'

// Protocol integration: real Executor, reconnect, Rust Backend and Redis receipts.
// Only the model and the external DingTalk API are substituted.
export function createRuntimeNotificationReconnect({
  executorHome,
  workspacePath,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  let cloud
  let control
  let storedProfile
  let deviceId
  let notificationDeviceId
  let sessionKey
  let proxy
  let api
  let userId
  let active = false
  const messages = []
  const gates = new Map()
  const proxies = []
  const events = () => proxies.flatMap(value => value.events)
  const request = (path, body, method = 'POST') =>
    fetchJson(`${cloud.backendUrl}${path}`, {
      ...(body ? { method, body: JSON.stringify(body) } : {}),
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    })
  const fixture = async payload => {
    const output = await commandOutputAsync(
      'uv',
      ['run', '--no-sync', 'python', 'tests/e2e/runtime_notification_reconnect_fixture.py'],
      {
        cwd: join(repoDir, 'backend'),
        env: {
          ...cloud.backendEnv,
          PYTHONPATH: [repoDir, join(repoDir, 'backend')].join(delimiter),
          WEWORK_IM_RECONNECT_FIXTURE: JSON.stringify({ userId, ...payload }),
        },
      }
    )
    return output.trim() ? JSON.parse(output.trim().split('\n').at(-1)) : null
  }
  const terminal = (entry, taskId) =>
    entry.event === 'response.completed' && entry.payload.taskId === taskId

  async function waitForBackendTerminal(taskId) {
    // This Rust handler writes "forwarded" only after IM side effects finish.
    // It also proves that the real migrated handler consumed the terminal event.
    await until(
      async () => {
        const directory = join(dirname(cloud.backendLogPath), 'backend-rs-logs')
        const files = (await readdir(directory)).filter(name => name.startsWith('info.log'))
        return (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8')))).join(
          '\n'
        )
      },
      log =>
        log
          .split('\n')
          .some(
            line =>
              line.includes('runtime terminal relay') &&
              line.includes(taskId) &&
              line.includes(JSON.stringify(notificationDeviceId)) &&
              /phase["\s:=]*forwarded/.test(line)
          ),
      `Rust Backend did not finish terminal processing: ${taskId}`,
      uiTimeoutMs
    )
  }

  async function subscribe(address) {
    const result = await request(
      '/api/runtime-work/im-notifications/runtime-task',
      {
        address: { deviceId: notificationDeviceId, localTaskId: address.taskId },
        sessionKeys: [sessionKey],
      },
      'PUT'
    )
    assert.equal(result.subscribed, true)
    assert.equal(result.address.deviceId, notificationDeviceId)
    assert.deepEqual(result.sessionKeys, [sessionKey])
  }

  async function createTask(name, subscribed = true) {
    const taskWorkspace = join(workspacePath, `notification-reconnect-${name}`)
    await mkdir(taskWorkspace, { recursive: true })
    // APP devices accept task commands through their local IPC, not remote APIs.
    const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
    const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
    assert.ok(model, 'The reconnect fixture requires the configured real Codex model route')
    const taskId = `notification-reconnect-${name}-${randomUUID()}`
    const prompt = `${PREFIX}${name}`
    const task = await requestExecutor(
      control,
      'runtime.tasks.create',
      {
        taskId,
        workspacePath: taskWorkspace,
        runtime: 'codex',
        message: prompt,
        title: `Reconnect ${name}`,
        executionRequest: {
          task_id: taskId,
          subtask_id: `${taskId}-initial`,
          user_id: userId,
          prompt,
          new_session: true,
          bot: [{ shell_type: 'Codex', name: 'Reconnect verification' }],
          model_config: {
            model_id: model.local_model_id,
            model_provider: model.provider,
            runtime_config: { codex: { use_user_config: true, configured: true } },
          },
        },
      },
      uiTimeoutMs
    )
    assert.equal(task.accepted, true, task.error)
    assert.equal(task.taskId, taskId)
    const address = { deviceId, taskId: task.taskId, workspacePath: taskWorkspace }
    await until(
      () => gates.get(name),
      Boolean,
      `Executor never reached model: ${name}`,
      modelResponseTimeoutMs
    )
    if (subscribed) {
      await subscribe(address)
    }
    return address
  }

  async function reconnect() {
    // A new real socket endpoint forces the desktop controller to rebuild its
    // runner while retaining the app's shared Runtime handler and event journal.
    proxy = await new RuntimeEventProxy(cloud.socketUrl).start()
    proxies.push(proxy)
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        cloudConnection: {
          ...storedProfile,
          backendUrl: cloud.backendUrl,
          apiBaseUrl: `${cloud.backendUrl}/api`,
          socketBaseUrl: proxy.url,
          socketBaseUrlOverride: proxy.url,
        },
      }),
    })
    const readyCount = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await control.awaitReadyAfter(readyCount)
    // The device can still appear online on its previous connection. Wait for
    // the new native profile and its actual transport before reading presence.
    const status = await until(
      async () => {
        assert.ifError(proxy.failure)
        return requestExecutor(control, 'executor.backend.status', {}, uiTimeoutMs)
      },
      value =>
        value.socket_url === proxy.url && value.connected === true && proxy.websockets.size > 0,
      `Desktop did not connect through the new Runtime transport: ${proxy.url}`,
      uiTimeoutMs
    )
    const device = await cloud.waitForDeviceStatus(deviceId, 'online', cloud.backendLogPath)
    assert.ok(proxy.websockets.size, 'Executor bypassed the real transport fault')
    assert.equal(status.device_type, 'app', 'The regression requires the shared desktop Runtime')
    assert.equal(
      status.socket_url,
      proxy.url,
      'Desktop did not rebuild its connection for the new endpoint'
    )
    assert.equal(status.connected, true)
    return device.runtime_instance_id
  }

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const name = ['old', 'offline', 'barrier'].find(value =>
        JSON.stringify(body).includes(`${PREFIX}${value}`)
      )
      if (!name) return false
      assert.equal(gates.has(name), false, `Model request duplicated for ${name}`)
      const stream = streamingTextEvents(
        `notification-${name}`,
        `${PREFIX}${name}_DONE`,
        'final_answer'
      )
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(createSse(stream.start))
      let finished = false
      const release = () => {
        if (finished) return
        finished = true
        response.end(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta: `${PREFIX}${name}_DONE`,
            },
            ...stream.finish,
          ])
        )
      }
      gates.set(name, release)
      return true
    },
    async verify(value, desktopControl) {
      cloud = value
      control = desktopControl
      active = true
      storedProfile = JSON.parse(
        await control.command('getLocalStorageItem', 'body', {
          value: 'wework.cloudConnection',
        })
      )
      assert.ok(storedProfile?.backendUrl, 'Desktop cloud profile is unavailable')
      const app = await cloud.waitForConnectedAppDevice()
      deviceId = app.device_id
      // Device-list names and the APP notification transport route differ.
      notificationDeviceId = app.socket_device_id
      assert.ok(notificationDeviceId, 'The APP notification route is unavailable')
      assert.equal(notificationDeviceId, app.execution_target_id)
      const instance = app.runtime_instance_id
      const executorPid = await currentExecutorPid(control)
      assert.ok(executorPid, 'The desktop Executor must already be running')
      userId = (await request('/api/users/me')).id
      api = createServer(async (req, res) => {
        try {
          const body = await readRequestBody(req)
          assert.equal(req.method, 'POST')
          res.setHeader('content-type', 'application/json')
          if (req.url === '/v1.0/oauth2/accessToken') {
            assert.deepEqual(body, { appKey: 'reconnect-ci-app', appSecret: 'reconnect-ci-secret' })
            res.end(JSON.stringify({ accessToken: 'ci-access', expireIn: 7200 }))
          } else {
            assert.equal(req.url, '/v1.0/robot/oToMessages/batchSend')
            assert.equal(req.headers['x-acs-dingtalk-access-token'], 'ci-access')
            assert.equal(body.robotCode, 'reconnect-ci-app')
            assert.deepEqual(body.userIds, ['reconnect-ci-staff'])
            assert.equal(body.msgKey, 'sampleText')
            messages.push(JSON.parse(body.msgParam).content)
            res.end(JSON.stringify({ processQueryKey: `reconnect-${messages.length}` }))
          }
        } catch (error) {
          api.failure = error
          res.writeHead(500).end('{}')
        }
      })
      await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
      try {
        assert.equal(await reconnect(), instance, 'Setup replaced the Runtime identity')
        // No receipt exists for the old task. Enabling its subscription afterwards
        // makes an incorrect replay observable even if receipt deduplication works.
        await fixture({ operation: 'disable' })
        const baseline = Object.keys((await fixture({ operation: 'receipts' })).receipts).length
        const old = await createTask('old', false)
        gates.get('old')()
        await waitForCompletedRuntimeTaskThread(control, old.taskId, modelResponseTimeoutMs)
        await proxy.waitForEvent(entry => terminal(entry, old.taskId))
        await waitForBackendTerminal(old.taskId)
        const seeded = await fixture({
          operation: 'seed',
          apiBase: `http://127.0.0.1:${api.address().port}`,
        })
        sessionKey = seeded.sessionKey
        const settings = await request('/api/runtime-work/im-notifications')
        assert.equal(settings.global.enabled, true)
        assert.equal(settings.global.session?.sessionKey, sessionKey)
        await subscribe(old)
        const offline = await createTask('offline')
        proxy.disconnectWebSockets(true)
        await cloud.waitForDeviceStatus(deviceId, 'offline', cloud.backendLogPath)
        gates.get('offline')()
        // Observe the real Executor's durable terminal fact before reconnecting.
        const indexPath = join(executorHome, 'runtime-work/index.json')
        await until(
          async () =>
            JSON.parse(await readFile(indexPath, 'utf8')).tasks[offline.taskId]?.local_execution,
          execution => execution?.status === 'done' && execution.turn_status === 'completed',
          'The task did not finish while the Executor was disconnected',
          modelResponseTimeoutMs
        )
        assert.equal(events().filter(entry => terminal(entry, offline.taskId)).length, 0)
        assert.equal(messages.length, 0, 'Disconnected task was delivered early')
        assert.equal(await reconnect(), instance, 'Network reconnect restarted the Executor')
        await proxy.waitForEvent(entry => terminal(entry, offline.taskId), {
          timeoutMs: uiTimeoutMs,
        })
        await waitForCompletedRuntimeTaskThread(control, offline.taskId, modelResponseTimeoutMs)
        await waitForBackendTerminal(offline.taskId)
        assert.ifError(api.failure)
        assert.equal(messages.length, 1, 'Offline task must notify exactly once after reconnect')
        proxy.disconnectWebSockets(true)
        await cloud.waitForDeviceStatus(deviceId, 'offline', cloud.backendLogPath)
        assert.equal(await reconnect(), instance)
        const barrier = await createTask('barrier')
        gates.get('barrier')()
        await proxy.waitForEvent(entry => terminal(entry, barrier.taskId), {
          timeoutMs: uiTimeoutMs,
        })
        await waitForCompletedRuntimeTaskThread(control, barrier.taskId, modelResponseTimeoutMs)
        await waitForBackendTerminal(barrier.taskId)
        assert.ifError(api.failure)
        assert.equal(
          Object.keys((await fixture({ operation: 'receipts' })).receipts).length,
          baseline + 2,
          'Backend did not persist both successful delivery receipts'
        )
        assert.equal(
          await currentExecutorPid(control),
          executorPid,
          'Network recovery replaced the Executor process'
        )
        assert.equal(messages.length, 2, 'Reconnect duplicated DingTalk delivery')
        assert.equal(messages.filter(text => text.includes(`${PREFIX}offline_DONE`)).length, 1)
        assert.equal(messages.filter(text => text.includes(`${PREFIX}barrier_DONE`)).length, 1)
        assert.equal(
          messages.some(text => text.includes(`${PREFIX}old_DONE`)),
          false
        )
        for (const address of [old, offline, barrier]) {
          assert.equal(
            events().filter(entry => terminal(entry, address.taskId)).length,
            1,
            `Executor replayed a previously relayed terminal event: ${address.taskId}`
          )
        }
        console.log('[desktop-e2e] Runtime notification reconnect verified', {
          disconnects: 2,
          oldTaskDeliveries: 0,
          offlineTaskDeliveries: 1,
          terminalEventsPerTask: 1,
          newReceipts: 2,
        })
      } finally {
        await this.cleanup()
      }
    },
    async cleanup() {
      for (const finish of gates.values()) finish()
      try {
        if (storedProfile) {
          const profile = storedProfile
          storedProfile = null
          await control.command('setAppPreferences', 'body', {
            value: JSON.stringify({ cloudConnection: profile }),
          })
          const readyCount = control.readyCount
          await control.command('reloadMainWindow', 'body')
          await control.awaitReadyAfter(readyCount)
        }
      } finally {
        active = false
        const results = await Promise.allSettled([
          ...proxies.map(value => value.stop()),
          (async () => {
            if (api?.listening) {
              api.closeAllConnections()
              await new Promise(resolve => api.close(resolve))
            }
          })(),
        ])
        const errors = results
          .filter(result => result.status === 'rejected')
          .map(result => result.reason)
        if (errors.length) throw new AggregateError(errors, 'Reconnect fixture cleanup failed')
      }
    },
  }
}
