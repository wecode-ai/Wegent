import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_PUBLIC_MODEL_NAME,
  createSingleRootLocalProject,
  selectE2EModel,
  resultDir,
} from '../modules/shared.mjs'
import { inputUserMessageTexts } from '../modules/desktop-server.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'

const TOGGLE = '[data-testid="remote-task-access-toggle"]'
const LOCAL_PROMPT = 'WEWORK_LOCAL_TASK_REMOTE_ACCESS'
const REMOTE_PROMPT = 'WEWORK_CONTINUE_ORIGINAL_LOCAL_TASK'
const CREATE_PROMPT = 'WEWORK_CREATE_FROM_PHONE_ON_LOCAL_COMPUTER'
const PRIVATE_PROMPT = 'WEWORK_LOCAL_TASK_AFTER_REMOTE_ACCESS_REVOCATION'
const COMPLETE = `${REMOTE_PROMPT}_COMPLETE`
const taskId = task => task.taskId ?? task.localTaskId ?? task.id
const tasks = work => (work.workspaces ?? []).flatMap(workspace => workspace.tasks ?? [])
const decode = value =>
  value?.encoding === 'gzip+base64+json'
    ? JSON.parse(gunzipSync(Buffer.from(value.payload, 'base64')).toString('utf8'))
    : value

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

// Only the model is simulated. UI, local IPC, both App installations, storage,
// hybrid device inventory, authenticated task RPC, and live events are real.
export function createDesktopScenario({ workspacePath, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let socket
  const gates = new Map(
    [CREATE_PROMPT, REMOTE_PROMPT].map(prompt => [
      prompt,
      { first: deferred(), finish: deferred() },
    ])
  )
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = inputUserMessageTexts(body).join('\n')
      const prompt = [CREATE_PROMPT, REMOTE_PROMPT, LOCAL_PROMPT, PRIVATE_PROMPT].find(value =>
        input.includes(value)
      )
      assert.ok(prompt, 'Unexpected model request outside the task-access case')
      assert.ok(input.includes(prompt), 'Unexpected model request outside the task-access case')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const text = `${prompt}_COMPLETE`
      const stream = streamingTextEvents(prompt, text, 'final_answer')
      const chunks = text.match(/[\s\S]{1,8}/g).map((delta, index) => ({
        type: 'response.output_text.delta',
        item_id: stream.itemId,
        output_index: 0,
        content_index: 0,
        delta,
        offset: index * 8,
      }))
      const gate = gates.get(prompt)
      response.write(createSse(stream.start))
      if (gate) await gate.first.promise
      response.write(createSse(chunks.slice(0, 1)))
      if (gate) await gate.finish.promise
      response.end(createSse([...chunks.slice(1), ...stream.finish]))
      return true
    },
    async verify(control) {
      const original = await cloud.waitForConnectedAppDevice()
      const route = original.execution_target_id
      assert.ok(route)
      assert.equal(original.runtime_features?.remoteTaskAccess?.enabled, false)
      await cloud.startDuplicateAppDeviceIdentity()
      const peer = (await cloud.devices()).find(
        device => device.device_type === 'app' && device.id !== original.id
      )
      assert.ok(peer)
      assert.notEqual(peer.execution_target_id, route)
      assert.equal(peer.runtime_features?.remoteTaskAccess?.enabled, false)

      await createSingleRootLocalProject(control, workspacePath, 'remote-task-access-workspace')
      const before = new Set(
        tasks(JSON.parse(await control.command('getLocalRuntimeWork', 'body'))).map(taskId)
      )
      await control.command('click', '[data-testid="new-chat-button"]')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: LOCAL_PROMPT })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: `${LOCAL_PROMPT}_COMPLETE`,
          timeoutMs: workbenchReadyTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
        { visible: false }
      )
      const local = JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
      const task = tasks(local).find(item => !before.has(taskId(item)))
      assert.ok(task, 'Local task creation did not persist a new conversation')
      const address = {
        deviceId: route,
        taskId: taskId(task),
        workspacePath: task.workspacePath,
        runtime: task.runtime,
      }

      const { io } = createRequire(
        new URL('../../../../packages/chat-core/package.json', import.meta.url)
      )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
      socket = io(`${cloud.backendUrl}/wework-runtime`, {
        path: '/socket.io',
        auth: { token: cloud.authToken, client_origin: 'wework' },
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
        forceNew: true,
      })
      const events = []
      socket.on('runtime:event', event => events.push(event))
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
        socket.connect()
      })
      const rpc = (method, params = {}, device = route) =>
        socket.timeout(workbenchReadyTimeoutMs).emitWithAck('runtime:request', {
          type: 'request',
          id: `remote-access-${Date.now()}`,
          method,
          params,
          device_id: device,
        })
      const denied = await rpc('runtime.tasks.list')
      assert.equal(denied.ok, false)
      assert.equal(denied.error.code, 'remote_control_disabled')
      const createDenied = await rpc('runtime.tasks.create', {
        taskId: randomUUID(),
        message: CREATE_PROMPT,
      })
      assert.equal(createDenied.ok, false)
      assert.equal(createDenied.error.code, 'remote_control_disabled')
      await control.command('navigate', 'body', { value: '/settings/connections' })
      await control.command('waitFor', TOGGLE)
      assert.equal(
        await control.command('getAttribute', TOGGLE, { value: 'aria-checked' }),
        'false'
      )
      await control.command('clickWhenEnabled', TOGGLE)
      await until(
        () => cloud.devices(),
        devices =>
          devices.find(device => device.id === original.id)?.runtime_features?.remoteTaskAccess
            ?.enabled === true,
        'Local consent did not reach the real device inventory',
        workbenchReadyTimeoutMs
      )

      const listing = await rpc('runtime.tasks.list')
      assert.equal(listing.ok, true, JSON.stringify(listing.error))
      assert.ok(tasks(decode(listing.result)).some(item => taskId(item) === address.taskId))
      const history = await rpc('runtime.tasks.transcript', address)
      assert.equal(history.ok, true, JSON.stringify(history.error))
      assert.ok(JSON.stringify(decode(history.result)).includes(`${LOCAL_PROMPT}_COMPLETE`))
      const peerDenied = await rpc('runtime.tasks.list', {}, peer.execution_target_id)
      assert.equal(
        peerDenied.ok,
        false,
        'Enabling one computer must not authorize another installation'
      )
      const toggleDenied = await rpc(
        'executor.remote_task_access.update',
        { enabled: true },
        peer.execution_target_id
      )
      assert.equal(
        toggleDenied.ok,
        false,
        'Another computer must never be able to change the local switch'
      )

      const createdTaskId = randomUUID()
      const createParams = { taskId: createdTaskId, message: CREATE_PROMPT }
      const peerResult = await rpc('runtime.tasks.create', createParams, peer.execution_target_id)
      assert.equal(peerResult.ok, false, 'Task creation crossed installation-local consent')
      assert.equal(peerResult.error.code, 'remote_control_disabled')
      const evidence = []
      const verifyLiveStreaming = async (prompt, id) => {
        const received = () => events.filter(event => event.payload?.taskId === id)
        await until(
          received,
          values => values.some(event => event.event === 'response.created'),
          'The reader did not receive the response start before model text',
          workbenchReadyTimeoutMs
        )
        evidence.push({ prompt, phase: 'waiting' })
        gates.get(prompt).first.resolve()
        await until(
          received,
          values => values.some(event => event.event === 'response.output_text.delta'),
          'The reader did not receive partial text while the model stream was open',
          workbenchReadyTimeoutMs
        )
        assert.ok(!received().some(event => event.event === 'response.completed'))
        evidence.push({ prompt, phase: 'partial' })
        gates.get(prompt).finish.resolve()
      }
      const createdResponse = await fetch(`${cloud.backendUrl}/api/runtime-work/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 2,
          deviceId: route,
          taskId: createdTaskId,
          standaloneChatWorkspace: true,
          workspaceKind: 'chat',
          runtime: 'codex',
          message: CREATE_PROMPT,
          modelId: CLOUD_PUBLIC_MODEL_NAME,
          modelType: 'public',
          modelSelection: { modelName: CLOUD_PUBLIC_MODEL_NAME, modelType: 'public' },
        }),
      })
      assert.equal(createdResponse.ok, true, `Remote creation failed: ${createdResponse.status}`)
      const created = await createdResponse.json()
      assert.equal(created.accepted, true)
      assert.equal(created.taskId, createdTaskId)
      assert.ok(created.workspacePath.replaceAll('\\', '/').includes('/Documents/Codex/'))
      await verifyLiveStreaming(CREATE_PROMPT, createdTaskId)
      await until(
        () => events.filter(event => event.payload?.taskId === createdTaskId),
        values => values.some(event => event.event === 'response.completed'),
        'The phone-created conversation did not deliver live completion',
        workbenchReadyTimeoutMs
      )
      const assertStreaming = id => {
        const received = events.filter(event => event.payload?.taskId === id)
        assert.ok(received.every(event => event.payload.deviceId === route))
        const names = received.map(event => event.event)
        const firstDelta = names.indexOf('response.output_text.delta')
        assert.ok(names.indexOf('response.created') >= 0)
        assert.ok(firstDelta > names.indexOf('response.created'))
        assert.ok(names.filter(name => name === 'response.output_text.delta').length > 1)
        assert.ok(names.indexOf('response.completed') > firstDelta)
      }
      assertStreaming(createdTaskId)
      await until(
        () => rpc('runtime.tasks.transcript', { taskId: createdTaskId }),
        result =>
          result.ok && JSON.stringify(decode(result.result)).includes(`${CREATE_PROMPT}_COMPLETE`),
        'The phone-created conversation did not execute on the selected computer',
        workbenchReadyTimeoutMs
      )
      const createdLocalWork = JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
      assert.ok(tasks(createdLocalWork).some(item => taskId(item) === createdTaskId))

      const response = await fetch(`${cloud.backendUrl}/api/runtime-work/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          address,
          message: REMOTE_PROMPT,
          clientUserMessageId: 'mobile-continuation',
          modelSelection: { modelName: CLOUD_PUBLIC_MODEL_NAME, modelType: 'public' },
        }),
      })
      assert.equal(response.ok, true, `Remote continuation failed: ${await response.text()}`)
      await verifyLiveStreaming(REMOTE_PROMPT, address.taskId)
      await until(
        () => events,
        values =>
          values.some(
            event =>
              event.payload?.taskId === address.taskId &&
              event.payload?.deviceId === route &&
              event.event === 'response.completed'
          ),
        'The remote reader did not receive the original task result on its unique device route',
        workbenchReadyTimeoutMs
      )
      assertStreaming(address.taskId)
      await writeFile(
        join(resultDir, 'remote-streaming-evidence.json'),
        JSON.stringify(evidence, null, 2)
      )
      const continued = await rpc('runtime.tasks.transcript', address)
      assert.ok(JSON.stringify(decode(continued.result)).includes(COMPLETE))

      // Remount settings to prove consent persistence before revoking it locally.
      await control.command('navigate', 'body', { value: '/' })
      await control.command('navigate', 'body', { value: '/settings/connections' })
      await control.command('waitFor', TOGGLE)
      await until(
        () => control.command('getAttribute', TOGGLE, { value: 'aria-checked' }),
        value => value === 'true',
        'Local consent was not persisted',
        uiTimeoutMs
      )
      await control.command('clickWhenEnabled', TOGGLE)
      await until(
        () => cloud.devices(),
        devices =>
          devices.find(device => device.id === original.id)?.runtime_features?.remoteTaskAccess
            ?.enabled === false,
        'Local revocation did not reach the device inventory',
        workbenchReadyTimeoutMs
      )
      const revoked = await rpc('runtime.tasks.transcript', address)
      assert.equal(
        revoked.ok,
        false,
        'An already connected reader retained access after local revocation'
      )
      assert.equal(revoked.error.code, 'remote_control_disabled')
      const createRevoked = await rpc('runtime.tasks.create', {
        taskId: randomUUID(),
        message: CREATE_PROMPT,
      })
      assert.equal(createRevoked.ok, false, 'Creation remained available after revocation')
      assert.equal(createRevoked.error.code, 'remote_control_disabled')
      await control.command('navigate', 'body', { value: '/' })
      const privateBefore = new Set(
        tasks(JSON.parse(await control.command('getLocalRuntimeWork', 'body'))).map(taskId)
      )
      const eventOffset = events.length
      await control.command('click', '[data-testid="new-chat-button"]')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PRIVATE_PROMPT })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: `${PRIVATE_PROMPT}_COMPLETE`, timeoutMs: workbenchReadyTimeoutMs }
      )
      const privateWork = JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
      const privateTask = tasks(privateWork).find(item => !privateBefore.has(taskId(item)))
      assert.ok(privateTask, 'Local execution must remain available after remote revocation')
      const observeUntil = Date.now() + 1000
      await until(
        () => {
          assert.ok(
            !events.slice(eventOffset).some(event => event.payload?.taskId === taskId(privateTask)),
            'A connected remote reader received private task events after revocation'
          )
          return Date.now() >= observeUntil
        },
        done => done,
        'Private-event observation did not finish'
      )
    },
    async cleanup() {
      for (const gate of gates.values()) {
        gate.first.resolve()
        gate.finish.resolve()
      }
      socket?.disconnect()
    },
  }
}
