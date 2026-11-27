import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { requestJson, waitForValue } from '../modules/collaboration-cloud-story-checks.mjs'
import { modelRequestTexts } from '../modules/model-tool-output.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  handleModelMaintenanceRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const prompts = ['PLATFORM_FIRST_TURN', 'DESKTOP_SECOND_TURN', 'PLATFORM_THIRD_TURN']
const prefixes = ['', 'Desktop streaming prefix', 'Platform streaming prefix']
const replies = [
  'First platform result',
  prefixes[1] + ' desktop complete',
  prefixes[2] + ' platform complete',
]
const pane = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  const observerJoined = Promise.withResolvers()
  const calls = []
  const releases = new Map()
  const post = (path, body) =>
    requestJson(cloud.backendUrl, cloud.authToken, path, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, res) || handleEmptyReplyPrediction(body, res))
        return true
      const input = modelRequestTexts(body, 'user')
      const turn = prompts.findLastIndex(prompt => input.includes(prompt))
      if (turn < 0) return false
      calls.push({ turn, thread: req.headers['thread-id'] })
      const id = `platform-continuation-${calls.length}`
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (turn > 0) {
        const stream = streamingTextEvents(id, replies[turn], 'final_answer')
        const delta = (text, offset) => ({
          type: 'response.output_text.delta',
          item_id: stream.itemId,
          output_index: 0,
          content_index: 0,
          delta: text,
          offset,
        })
        res.write(createSse([...stream.start, delta(prefixes[turn], 0)]))
        assert.ok(!releases.has(turn), 'A held streaming turn was submitted twice')
        releases.set(turn, () =>
          res.end(
            createSse([
              delta(replies[turn].slice(prefixes[turn].length), prefixes[turn].length),
              ...stream.finish,
            ])
          )
        )
        return true
      }
      await observerJoined.promise
      res.end(
        createSse([responseCreated(id), assistantMessage(replies[turn]), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      await post('/api/admin/setup-complete', {})
      const name = `platform-continuation-${process.pid}`
      const model = 'desktop-e2e-cloud-responses'
      const bot = await post('/api/bots', {
        name,
        shell_name: 'Codex',
        namespace: 'default',
        agent_config: { bind_model: model, bind_model_type: 'public' },
        system_prompt: 'Answer each user message.',
      })
      const team = await post('/api/teams', {
        name,
        namespace: 'default',
        bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
        bind_mode: ['task'],
        requires_workspace: false,
        is_active: true,
      })
      const device = await cloud.waitForConnectedAppDevice()
      assert.ok(device.execution_target_id)
      const send = (turn, taskId) =>
        post('/api/device-chat/tasks', {
          teamId: team.id,
          deviceId: device.execution_target_id,
          modelId: model,
          modelType: 'public',
          clientOrigin: 'frontend',
          ...(taskId ? {} : { title: 'Ordinary device conversation' }),
          taskId,
          message: prompts[turn],
        })
      const { io } = createRequire(
        new URL('../../../../packages/chat-core/package.json', import.meta.url)
      )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
      const socket = io(`${cloud.backendUrl}/chat`, {
        transports: ['websocket'],
        auth: { token: cloud.authToken },
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        timeout: uiTimeoutMs,
      })
      const completions = []
      const chunks = []
      try {
        socket.on('chat:chunk', event => chunks.push(event))
        socket.on('chat:done', event => completions.push(event))
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve)
          socket.once('connect_error', reject)
          socket.connect()
        })
        const first = await send(0)
        const detail = () =>
          requestJson(cloud.backendUrl, cloud.authToken, `/api/tasks/${first.taskId}`, {
            signal: AbortSignal.timeout(uiTimeoutMs),
          })
        const waitResult = turn =>
          waitForValue(
            detail,
            value =>
              value.subtasks.some(
                row => row.status === 'COMPLETED' && row.result?.value === replies[turn]
              ),
            `Task ${first.taskId} did not persist turn ${turn + 1} result`,
            workbenchReadyTimeoutMs
          )
        const releaseAfterBothReceivedPrefix = async turn => {
          await control.command('waitFor', pane, {
            text: prefixes[turn],
            timeoutMs: workbenchReadyTimeoutMs,
          })
          await control.command('waitFor', `${pane} [data-testid="pause-response-button"]`, {
            visible: true,
            timeoutMs: uiTimeoutMs,
          })
          const partial = await waitForValue(
            () => chunks,
            events =>
              events.find(
                event => event.task_id === first.taskId && event.content?.includes(prefixes[turn])
              ),
            `Platform subscriber did not receive the live prefix for turn ${turn + 1}`,
            uiTimeoutMs
          )
          const stored = (await detail()).subtasks.find(row => row.id === partial.subtask_id)
          assert.equal(
            stored?.status,
            'RUNNING',
            'The platform must still be running the held turn'
          )
          assert.ok(!completions.some(event => event.subtask_id === partial.subtask_id))
          assert.ok(
            !(await control.command('getText', pane)).includes(replies[turn]),
            'Desktop displayed the final reply before release'
          )
          if (turn === 1) await captureScreenshot(control, 'platform-task-streaming.png', pane)
          releases.get(turn)()
          releases.delete(turn)
        }
        const join = await socket
          .timeout(uiTimeoutMs)
          .emitWithAck('task:join', { task_id: first.taskId })
        assert.ok(join && !join.error, 'Platform observer could not subscribe to the device task')
        observerJoined.resolve()
        await waitResult(0)
        const owner = await requestJson(cloud.backendUrl, cloud.authToken, '/api/users/me')
        await control.command('openWeworkScheme', 'body', {
          value: `wework://platform-tasks/${encodeURIComponent(`${cloud.backendUrl}/api`)}/${owner.id}/${first.taskId}`,
        })
        await control.command('waitFor', pane, { text: replies[0], timeoutMs: uiTimeoutMs })
        await control.command(
          'fill',
          `${pane} [data-testid="chat-message-input"][contenteditable="true"]`,
          { value: prompts[1] }
        )
        await control.command('clickWhenEnabled', `${pane} [data-testid="send-message-button"]`)
        await releaseAfterBothReceivedPrefix(1)
        await control.command('waitFor', pane, {
          text: replies[1],
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await waitResult(1)
        const third = await send(2, first.taskId)
        assert.equal(third.taskId, first.taskId)
        await releaseAfterBothReceivedPrefix(2)
        const final = await waitResult(2)
        await control.command('waitFor', pane, {
          text: replies[2],
          timeoutMs: workbenchReadyTimeoutMs,
        })
        assert.deepEqual(
          calls.map(call => call.turn),
          [0, 1, 2],
          'Each accepted turn must reach Codex exactly once'
        )
        assert.ok(calls[0].thread, 'The model request must carry its real Codex thread ID')
        assert.equal(
          new Set(calls.map(call => call.thread)).size,
          1,
          'Both entry points must resume the same Codex thread'
        )
        assert.equal(final.subtasks.filter(row => row.role === 'USER').length, 3)
        const assistants = final.subtasks.filter(row => row.role === 'ASSISTANT')
        assert.deepEqual(
          assistants.map(row => row.result?.value),
          replies
        )
        const expectedIds = assistants.map(row => row.id)
        const completedIds = () =>
          completions.filter(event => event.task_id === first.taskId).map(event => event.subtask_id)
        await waitForValue(
          completedIds,
          ids => expectedIds.every(id => ids.includes(id)),
          'Platform observer did not receive all three terminal events',
          uiTimeoutMs
        )
        assert.deepEqual(completedIds(), expectedIds)
        await captureScreenshot(control, 'platform-task-continuation.png', pane)
      } finally {
        observerJoined.resolve()
        for (const release of releases.values()) release()
        socket.disconnect()
      }
    },
  }
}
