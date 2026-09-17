import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { CLOUD_PUBLIC_MODEL_LABEL, CLOUD_PUBLIC_MODEL_NAME, selectE2EModel } from './shared.mjs'
import {
  assistantMessage,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const INITIAL = 'BOARD_REPLY_CLOUD_MODEL_INITIAL'
const REPLY = 'BOARD_REPLY_CLOUD_MODEL_CONTINUE'

async function verifyPersistedExecutions({ backendUrl, authToken, projectId }, taskId, timeoutMs) {
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${backendUrl}/wework-runtime`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: authToken },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: timeoutMs,
  })
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
      socket.connect()
    })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ack = await socket.timeout(timeoutMs).emitWithAck('wework:project_chat:subscribe', {
        projectId,
        taskId,
        afterSequence: 0,
      })
      assert.equal(ack.ok, true, 'A new client must be able to read persisted execution states')
      const runs = ack.result.messages.filter(
        message =>
          message.sender.type === 'agent' &&
          [INITIAL, REPLY].some(marker => message.content.includes(`${marker}_DONE`))
      )
      if (
        runs.length === 2 &&
        runs.every(
          message => message.status === 'completed' && message.metadata.run_status === 'completed'
        )
      )
        return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('Execution states were not persisted for a fresh client after opening history')
  } finally {
    socket.disconnect()
  }
}

async function verifyExecutionDetail(control, scope, card, expectedText, timeoutMs) {
  const snapshot = JSON.parse(await control.command('snapshot', card))
  const badgeId = [...new Set(snapshot.testIds)]
    .filter(id => id.startsWith('cloud-task-activity-execution-badge-'))
    .at(-1)
  assert.ok(badgeId, 'The completed comment must expose its execution status')
  const badge = scope(`[data-testid="${badgeId}"]`)
  await control.command('click', badge)
  await control.command('waitFor', '[data-testid="runtime-execution-detail-body"]', {
    text: expectedText,
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="runtime-execution-detail-status"]', {
    text: '执行成功',
    timeoutMs,
  })
  const completedDialog = JSON.parse(
    await control.command('snapshot', '[data-testid="runtime-execution-detail-overlay"]')
  )
  assert.ok(
    !completedDialog.testIds.includes('runtime-execution-detail-stop'),
    'An execution confirmed as finished must not offer a stop action'
  )
  await control.command('click', '[data-testid="runtime-execution-detail-close"]')
  await control.command('waitFor', `${badge}[data-status="succeeded"]`, { timeoutMs })
  return badge
}

export function createBoardReplyModelRegression({ executorHome, uiTimeoutMs }) {
  let active = false
  const upstreamModels = new Map()

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      const text = latestModelInputText(body)
      const marker = text.includes(REPLY) ? REPLY : text.includes(INITIAL) ? INITIAL : null
      if (marker) upstreamModels.set(marker, body.model)
      const id = `board-reply-model-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          ...(marker ? [assistantMessage(`${marker}_DONE`)] : []),
          responseCompleted(id),
        ])
      )
      return true
    },

    async verify(control, issue, scope, cloud) {
      active = true
      try {
        const activity = scope(`[data-testid="cloud-task-activity-${issue.id}"]`)
        const composer = `${activity} [data-testid="cloud-task-activity-composer"]`
        await control.command('click', `${activity} [data-testid="task-comment-settings-toggle"]`)
        await selectE2EModel(
          control,
          CLOUD_PUBLIC_MODEL_NAME,
          CLOUD_PUBLIC_MODEL_LABEL,
          `${activity} footer`
        )
        await control.command('fill', composer, { value: INITIAL })
        await control.command('press', composer, { key: 'Enter' })
        await control.command('waitFor', activity, {
          text: `${INITIAL}_DONE`,
          timeoutMs: uiTimeoutMs,
        })

        const readTask = async taskId => {
          const index = JSON.parse(
            await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
          )
          return Object.values(index.tasks).find(task =>
            taskId
              ? task.local_task_id === taskId
              : task.runtime_handle?.origin?.loopItemId === issue.id && task.title === INITIAL
          )
        }
        const original = await readTask()
        assert.ok(original, 'The board comment did not create a persisted runtime task')
        const selection = original.runtime_handle.modelSelection
        assert.equal(selection.modelName, CLOUD_PUBLIC_MODEL_NAME)
        assert.equal(selection.modelType, 'public')
        const rootId = original.runtime_handle.origin.rootCommentId
        assert.ok(rootId, 'The runtime task has no owning comment')
        const card = `${activity} [data-testid="cloud-task-activity-card-${rootId}"]`
        const initialBadge = await verifyExecutionDetail(
          control,
          scope,
          card,
          `${INITIAL}_DONE`,
          uiTimeoutMs
        )
        // An unrelated new-comment selection must not override this card's model.
        await selectE2EModel(control, undefined, undefined, `${activity} footer`)
        const reply = `${activity} [data-testid="cloud-task-activity-card-composer-${rootId}"]`
        await control.command('fill', reply, { value: REPLY })
        await control.command('press', reply, { key: 'Enter' })
        await control.command('waitFor', activity, {
          text: `${REPLY}_DONE`,
          timeoutMs: uiTimeoutMs,
        })
        await verifyExecutionDetail(control, scope, card, `${REPLY}_DONE`, uiTimeoutMs)
        await control.command('waitFor', `${initialBadge}[data-status="succeeded"]`, {
          timeoutMs: uiTimeoutMs,
        })
        const continued = await readTask(original.local_task_id)
        assert.ok(continued, 'The original board runtime task disappeared after replying')
        assert.equal(continued.thread_id, original.thread_id)
        assert.deepEqual(continued.runtime_handle.modelSelection, selection)
        assert.equal(upstreamModels.get(INITIAL), 'desktop-e2e-public-upstream-model')
        assert.equal(upstreamModels.get(REPLY), 'desktop-e2e-public-upstream-model')
        await verifyPersistedExecutions(cloud, issue.id, uiTimeoutMs)
      } finally {
        active = false
      }
    },
  }
}
