import assert from 'node:assert/strict'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const INPUT = `${ACTIVE} [data-testid="chat-message-input"]`
const GHOST = `${ACTIVE} [data-testid="chat-message-input-prediction"]`
const PENDING = `${ACTIVE} [data-testid="chat-message-input-prediction-pending"]`
const ACCEPT = `${ACTIVE} [data-testid="chat-message-input-prediction-accept"]`
const INITIAL = '请分析迁移方案，保留运行中的任务，不要重启服务。'
const ANSWER = '可以先迁移当前进程，再配置后续任务的启动入口。迁移不会中断正在运行的任务。'
const SUGGESTION = '请按这个方案迁移，并配置后续启动入口，不要中断当前任务。'
const EDITED = '请先迁移当前进程，并验证任务仍在运行。'
const MODEL_SELECT = '[data-testid="reply-prediction-model"]'
const CONVERSATION_MODEL = 'gpt-5.6-luna'

function complete(response, text) {
  const id = `reply-prediction-${Date.now()}`
  const events = [
    { type: 'response.created', response: { id } },
    {
      type: 'response.output_item.done',
      item: {
        id: `${id}-message`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    },
  ]
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  response.end(
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  )
}

export function createDesktopScenario({ captureScreenshot, workspacePath }) {
  let active = false
  let normalRequests = 0
  let predictionRequests = 0
  let conversationInstructions
  let conversationTools
  let releasePrediction
  const heldPrediction = new Promise(resolve => {
    releasePrediction = resolve
  })
  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const input = JSON.stringify(body.input ?? body.messages ?? [])
      if (input.includes('Predict one natural next USER message')) {
        predictionRequests += 1
        assert.equal(body.model, CONVERSATION_MODEL, 'Prediction changed the conversation model')
        assert.equal(
          body.instructions,
          conversationInstructions,
          'Prediction changed the cached instructions'
        )
        assert.deepEqual(
          body.tools,
          conversationTools,
          'Prediction changed the cached tool definitions'
        )
        assert.equal(
          body.reasoning?.effort,
          'low',
          'Prediction inherited the task reasoning effort'
        )
        assert.ok(input.includes(INITIAL), 'Prediction lost the original user constraints')
        assert.ok(
          !input.includes('originalGoal'),
          'Prediction rebuilt the conversation as a text summary'
        )
        await heldPrediction
        // A draft edit can cancel the stale prediction before the next turn settles.
        if (response.destroyed || response.writableEnded) return true
        complete(response, JSON.stringify({ suggestion: SUGGESTION }))
        return true
      }
      if (!input.includes(INITIAL) && !input.includes(EDITED)) return false
      normalRequests += 1
      conversationInstructions = body.instructions
      conversationTools = body.tools
      complete(response, normalRequests === 1 ? ANSWER : '迁移完成，任务仍在运行。')
      return true
    },
    async verify(control) {
      active = true
      const capture = name => captureScreenshot(control, name, 'body')
      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', '[data-testid="reply-prediction-enabled"]')
      assert.equal(Number(await control.command('getElementCount', MODEL_SELECT)), 0)
      await control.command('scrollIntoView', '[data-testid="reply-prediction-settings"]')
      await control.command(
        'waitFor',
        '[data-testid="reply-prediction-enabled"][aria-checked="true"]'
      )
      await capture('reply-01-default-enabled.png')
      await control.command('click', '[data-testid="settings-back-button"]')
      await createSingleRootLocalProject(control, workspacePath, '回复建议验证')
      await control.command('waitFor', INPUT)
      await selectE2EModel(control)
      await control.command('fill', INPUT, { value: INITIAL })
      await capture('reply-03-original-request.png')
      await control.command('press', INPUT, { key: 'Enter' })
      await control.command('waitFor', PENDING, { text: '正在生成建议' })
      await control.command('fill', INPUT, { value: '生成时我也能输入' })
      assert.equal(Number(await control.command('getElementCount', PENDING)), 0)
      // Predictions abort after 30 seconds. Release the held response before
      // slower parallel checkpoint work can turn this deliberate hold into a timeout.
      releasePrediction()
      await control.command('fill', INPUT, { value: '' })
      await control.command('waitFor', GHOST, { text: SUGGESTION, timeoutMs: 30000 })
      assert.equal(Number(await control.command('getElementCount', PENDING)), 0)
      assert.equal(await control.command('getValue', INPUT), '')
      assert.equal(normalRequests, 1)
      await capture('reply-04-ghost-suggestion.png')
      const predictionRequestsBeforeReload = predictionRequests
      await reloadMainWindow(control, 'Reply prediction reload did not reconnect')
      await control.command('waitFor', GHOST, { text: SUGGESTION })
      assert.equal(
        predictionRequests,
        predictionRequestsBeforeReload,
        'Reload regenerated the completed-turn suggestion'
      )
      assert.equal(Number(await control.command('getElementCount', PENDING)), 0)
      await control.command('fill', INPUT, { value: '/model' })
      await control.command('waitFor', `${ACTIVE} [data-testid="slash-command-option-model"]`)
      await control.command('click', `${ACTIVE} [data-testid="slash-command-option-model"]`)
      await control.command('waitFor', '[data-testid="model-selector-menu"]')
      assert.equal(
        Number(
          await control.command('getElementCount', `${ACTIVE} [data-testid="slash-model-menu"]`)
        ),
        0
      )
      assert.equal(Number(await control.command('getElementCount', GHOST)), 0)
      assert.equal(Number(await control.command('getElementCount', ACCEPT)), 0)
      assert.equal(await control.command('getValue', INPUT), '')
      await capture('reply-04c-model-menu-suppresses-suggestion.png')
      await control.command('press', '[data-testid="model-selector-menu"]', {
        key: 'Escape',
      })
      await control.command('waitFor', GHOST, { text: SUGGESTION })
      await control.command('click', `${ACTIVE} [data-testid="model-selector-button"]`)
      await control.command('waitFor', '[data-testid="model-selector-menu"]')
      assert.equal(Number(await control.command('getElementCount', GHOST)), 0)
      assert.equal(Number(await control.command('getElementCount', ACCEPT)), 0)
      await capture('reply-04d-toolbar-model-selector.png')
      await control.command('press', '[data-testid="model-selector-menu"]', { key: 'Escape' })
      await control.command('waitFor', GHOST, { text: SUGGESTION })
      await control.command('fill', INPUT, { value: '我自己写的草稿' })
      assert.equal(Number(await control.command('getElementCount', GHOST)), 0)
      assert.equal(await control.command('getValue', INPUT), '我自己写的草稿')
      await capture('reply-04b-existing-draft-protected.png')
      const predictionRequestsBeforeEdit = predictionRequests
      await control.command('fill', INPUT, { value: '' })
      await control.command('waitFor', GHOST, { text: SUGGESTION })
      assert.equal(
        predictionRequests,
        predictionRequestsBeforeEdit,
        'Editing the draft regenerated a prediction'
      )
      await control.command('nativePress', INPUT, { key: 'Enter' })
      assert.equal(await control.command('getValue', INPUT), SUGGESTION)
      assert.equal(normalRequests, 1, 'Accepting the suggestion sent a message')
      await capture('reply-05-accepted-not-sent.png')
      await control.command('fill', INPUT, { value: '' })
      const predictionRequestsBeforeAccept = predictionRequests
      await reloadMainWindow(control, 'Accepted reply prediction reload did not reconnect')
      await control.command('waitFor', INPUT)
      await control.command('waitFor', `${ACTIVE} [data-testid="message-assistant"]`, {
        text: ANSWER,
      })
      assert.equal(Number(await control.command('getElementCount', GHOST)), 0)
      assert.equal(Number(await control.command('getElementCount', PENDING)), 0)
      assert.equal(
        predictionRequests,
        predictionRequestsBeforeAccept,
        'Reload regenerated an accepted suggestion'
      )
      await control.command('fill', INPUT, { value: EDITED })
      await control.command(
        'waitFor',
        `${ACTIVE} [data-testid="send-message-button"]:not([disabled])`
      )
      await capture('reply-06-edited-draft.png')
      await control.command('nativePress', INPUT, { key: 'Enter' })
      await control.command('waitFor', `${ACTIVE} [data-testid="message-assistant"]`, {
        text: '迁移完成，任务仍在运行。',
        timeoutMs: 30000,
      })
      assert.equal(normalRequests, 2)
      await capture('reply-07-edited-sent.png')
      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', '[data-testid="reply-prediction-settings"]')
      await control.command('scrollIntoView', '[data-testid="reply-prediction-settings"]')
      await control.command('click', '[data-testid="reply-prediction-enabled"]')
      await control.command(
        'waitFor',
        '[data-testid="reply-prediction-enabled"][aria-checked="false"]'
      )
      await capture('reply-08-disabled.png')
      await control.command('click', '[data-testid="settings-back-button"]')
      assert.equal(Number(await control.command('getElementCount', GHOST)), 0)
      await capture('reply-09-disabled-conversation.png')

      const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const task = debug.workbench?.currentRuntimeTask
      assert.ok(task?.deviceId && task?.taskId, 'The completed task address is missing')
      const cacheKey = `wework.replyPrediction.v1.${JSON.stringify([
        task.deviceId,
        task.taskId,
        task.workspacePath,
      ])}`
      const cached = await control.command('getLocalStorageItem', 'body', { value: cacheKey })
      assert.ok(cached, 'The completed task did not persist its prediction result')
      await control.command('hover', `[data-testid="runtime-local-task-row-${task.taskId}"]`)
      await control.command('click', `[data-testid="runtime-local-task-archive-${task.taskId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="runtime-local-task-archive-toast-${task.taskId}"]`
      )
      const archiveDeadline = Date.now() + 10000
      while (
        Number(
          await control.command(
            'getElementCount',
            `[data-testid="runtime-local-task-row-${task.taskId}"]`
          )
        )
      ) {
        assert.ok(Date.now() < archiveDeadline, 'The task did not finish archiving')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      await control.command('navigate', 'body', { value: '/settings/archived-conversations' })
      const taskSuffix = `${task.deviceId}-${task.taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
      const deleteButton = `[data-testid="archived-delete-button-${taskSuffix}"]`
      await control.command('waitFor', deleteButton)
      assert.equal(
        await control.command('getLocalStorageItem', 'body', { value: cacheKey }),
        cached,
        'Archiving removed the reusable suggestion cache'
      )
      await control.command('click', deleteButton)
      await control.command('click', '[data-testid="archived-delete-confirm-dialog-cancel-button"]')
      assert.equal(
        await control.command('getLocalStorageItem', 'body', { value: cacheKey }),
        cached,
        'Cancelling deletion removed the suggestion cache'
      )
      await control.command('click', deleteButton)
      await control.command(
        'click',
        '[data-testid="archived-delete-confirm-dialog-confirm-button"]'
      )
      const deletionDeadline = Date.now() + 10000
      while (await control.command('getLocalStorageItem', 'body', { value: cacheKey })) {
        assert.ok(Date.now() < deletionDeadline, 'Deleting the task left its suggestion cache')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      await reloadMainWindow(control, 'Deleted reply prediction reload did not reconnect')
      await control.command('waitFor', '[data-testid="archived-conversations-settings-page"]')
      assert.equal(await control.command('getLocalStorageItem', 'body', { value: cacheKey }), '')
      assert.equal(Number(await control.command('getElementCount', deleteButton)), 0)
      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', '[data-testid="reply-prediction-settings"]')
      await control.command('scrollIntoView', '[data-testid="reply-prediction-settings"]')
      await control.command(
        'waitFor',
        '[data-testid="reply-prediction-enabled"][aria-checked="false"]'
      )
    },
    diagnostics() {
      return { normalRequests, predictionRequests }
    },
  }
}
