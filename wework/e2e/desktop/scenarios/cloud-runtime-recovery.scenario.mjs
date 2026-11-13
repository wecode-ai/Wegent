import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createCloudModelRecovery } from './cloud-model-recovery.scenario.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_DEVICE_ID,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_OPTIONS,
  fetchJson,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import { waitForTranscriptState } from '../modules/transcript-restoration.mjs'
import { createRuntimeNotificationReconnect } from '../modules/runtime-notification-reconnect.mjs'

const PROMPT = 'WEWORK_E2E_CLOUD_STREAM_RECOVERY'
const PARTIAL = 'CLOUD_STREAM_PARTIAL'
const COMPLETED = `${PARTIAL}_COMPLETED_WHILE_DISCONNECTED`
const ASSISTANT = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const PAUSE = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`

export async function assertSingleRecoveredCloudAnswer(control) {
  const text = await control.command('getText', ASSISTANT)
  assert.equal(text.split(COMPLETED).length - 1, 1, 'Recovery duplicated the completed answer')
}

// Extend the existing CI checkpoint without another Backend/Executor bootstrap.
// Only the model is scripted; the relay, history, task state and Electron stay real.
export function createDesktopScenario(options) {
  const existing = createCloudModelRecovery(options)
  const notifications = createRuntimeNotificationReconnect(options)
  const appEnvironment = { ...existing.appEnvironment }
  let cloud
  let proxy
  let active = false
  let finishModel

  return {
    ...existing,
    appEnvironment,
    async prepareCloud(value) {
      await existing.prepareCloud(value)
      proxy = await new TransportFaultProxy(value.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      appEnvironment.WEWORK_BACKEND_URL = proxy.url
      appEnvironment.WEWORK_SOCKET_URL = proxy.url
    },
    setCloudEnvironment(value) {
      cloud = value
      existing.setCloudEnvironment(value)
    },
    async handleHttp(request, response, url) {
      if (await notifications.handleHttp(request, response, url)) return true
      if (!active) return existing.handleHttp?.(request, response, url) ?? false
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(PROMPT)) return false
      assert.equal(finishModel, undefined, 'The held cloud model request was duplicated')
      const stream = streamingTextEvents('cloud-stream-recovery', COMPLETED, 'final_answer')
      const delta = (text, offset) => ({
        type: 'response.output_text.delta',
        item_id: stream.itemId,
        output_index: 0,
        content_index: 0,
        delta: text,
        offset,
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(createSse([...stream.start, delta(PARTIAL, 0)]))
      let finished = false
      finishModel = () => {
        if (finished) return
        finished = true
        response.end(
          createSse([delta(COMPLETED.slice(PARTIAL.length), PARTIAL.length), ...stream.finish])
        )
      }
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      const request = (path, body) =>
        fetchJson(`${cloud.backendUrl}${path}`, {
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'Content-Type': 'application/json',
          },
        })
      try {
        const teams = await request('/api/teams?page=1&limit=100')
        assert.ok(teams.items?.[0]?.id, 'The cloud task requires a Team fixture')
        const workspacePath = join(cloud.runtimeWorkspaceRoot, `stream-recovery-${process.pid}`)
        await mkdir(workspacePath, { recursive: true })
        const task = await request('/api/runtime-work/create', {
          deviceId: CLOUD_DEVICE_ID,
          workspacePath,
          teamId: teams.items[0].id,
          runtime: 'codex',
          message: PROMPT,
          title: 'Cloud stream recovery',
          modelId: CLOUD_PUBLIC_MODEL_NAME,
          modelType: 'public',
          modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
          modelSelection: {
            modelName: CLOUD_PUBLIC_MODEL_NAME,
            modelType: 'public',
            options: CLOUD_PUBLIC_MODEL_OPTIONS,
          },
        })
        assert.equal(task.accepted, true, `Cloud task was rejected: ${task.error}`)
        assert.ok(task.taskId, 'The cloud task has no identity')
        const address = { deviceId: CLOUD_DEVICE_ID, taskId: task.taskId, workspacePath }
        const route = new URLSearchParams({ deviceId: address.deviceId, taskId: address.taskId })
        await control.command('navigate', 'body', { value: `/runtime-tasks?${route}` })
        await control.command('waitFor', ASSISTANT, {
          text: PARTIAL,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await control.command('waitFor', PAUSE)
        assert.equal(typeof finishModel, 'function', 'The real Executor never reached the model')
        assert.ok(proxy.websockets.size > 0, 'The renderer bypassed the transport fault proxy')
        const readyCount = control.readyCount

        proxy.disconnectWebSockets(true)
        finishModel()
        const completed = await cloud.waitForRuntimeTask(address)
        // runtime-work exposes the list projection, not the native execution snapshot.
        assert.equal(completed.status, 'done', 'The cloud Executor did not complete successfully')
        assert.equal(completed.running, false, 'The cloud Executor is still running')
        assert.ok(!(await control.command('getText', ASSISTANT)).includes(COMPLETED))

        proxy.disconnectWebSockets(false)
        await control.command('waitFor', ASSISTANT, {
          text: COMPLETED,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await control.command('waitFor', PAUSE, { visible: false })
        await waitForTranscriptState(
          control,
          snapshot =>
            snapshot.pane?.currentRuntimeTask?.taskId === address.taskId &&
            snapshot.pane?.status?.isBusy === false &&
            snapshot.pane?.transcript?.loading === false,
          'Cloud recovery did not settle the mounted conversation',
          options.uiTimeoutMs
        )
        await assertSingleRecoveredCloudAnswer(control)
        assert.equal(
          await control.command(
            'getElementCount',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
          ),
          '1',
          'Recovery duplicated the original user message'
        )
        assert.equal(
          Number(await control.command('getElementCount', ASSISTANT)),
          1,
          'Recovery duplicated the assistant message'
        )
        assert.equal(control.readyCount, readyCount, 'Cloud recovery required a renderer reload')
      } finally {
        finishModel?.()
        proxy.disconnectWebSockets(false)
        active = false
      }
      await notifications.verify(cloud, control)
    },
    async cleanup() {
      const errors = []
      for (const cleanup of [
        () => finishModel?.(),
        () => notifications.cleanup(),
        () => proxy?.stop(),
        () => existing.cleanup?.(),
      ]) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Cloud recovery cleanup failed')
    },
  }
}
