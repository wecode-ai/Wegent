import assert from 'node:assert/strict'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const INPUT = `${ACTIVE} [data-testid="chat-message-input"]`
const GHOST = `${ACTIVE} [data-testid="chat-message-input-prediction"]`
const INITIAL = '请分析迁移方案，保留运行中的任务，不要重启服务。'
const ANSWER = '可以先迁移当前进程，再配置后续任务的启动入口。迁移不会中断正在运行的任务。'
const SUGGESTION = '请按这个方案迁移，并配置后续启动入口，不要中断当前任务。'
const EDITED = '请先迁移当前进程，并验证任务仍在运行。'
const MODEL_SELECT = '[data-testid="reply-prediction-model"]'
const PREDICTION_MODEL = 'desktop-e2e-responses-model'

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
        assert.equal(body.model, PREDICTION_MODEL, 'Prediction used the conversation model')
        assert.deepEqual(body.tools ?? [], [], 'Prediction exposed tools to the model')
        assert.ok(input.includes(INITIAL), 'Prediction lost the original user constraints')
        complete(
          response,
          JSON.stringify({ suggestion: predictionRequests === 1 ? SUGGESTION : null })
        )
        return true
      }
      if (!input.includes(INITIAL) && !input.includes(EDITED)) return false
      normalRequests += 1
      complete(response, normalRequests === 1 ? ANSWER : '迁移完成，任务仍在运行。')
      return true
    },
    async verify(control) {
      active = true
      const capture = name => captureScreenshot(control, name, 'body')
      await control.command('navigate', 'body', { value: '/settings/personal/models' })
      await control.command('waitFor', MODEL_SELECT)
      await control.command('scrollIntoView', '[data-testid="reply-prediction-settings"]')
      assert.equal(await control.command('getValue', MODEL_SELECT), '')
      await capture('reply-01-unconfigured.png')
      await control.command('select', MODEL_SELECT, {
        value: 'runtime:local-model:desktop-e2e-responses',
      })
      await control.command(
        'waitFor',
        '[data-testid="reply-prediction-enabled"][aria-checked="true"]'
      )
      await capture('reply-02-model-enabled.png')
      await control.command('click', '[data-testid="settings-back-button"]')
      await createSingleRootLocalProject(control, workspacePath, '回复建议验证')
      await control.command('waitFor', INPUT)
      await selectE2EModel(control)
      await control.command('fill', INPUT, { value: INITIAL })
      await capture('reply-03-original-request.png')
      await control.command('press', INPUT, { key: 'Enter' })
      await control.command('waitFor', GHOST, { text: SUGGESTION, timeoutMs: 30000 })
      assert.equal(await control.command('getValue', INPUT), '')
      assert.equal(normalRequests, 1)
      await capture('reply-04-ghost-suggestion.png')
      await control.command('fill', INPUT, { value: '我自己写的草稿' })
      assert.equal(Number(await control.command('getElementCount', GHOST)), 0)
      assert.equal(await control.command('getValue', INPUT), '我自己写的草稿')
      await capture('reply-04b-existing-draft-protected.png')
      await control.command('fill', INPUT, { value: '' })
      await control.command('waitFor', GHOST, { text: SUGGESTION })
      assert.equal(predictionRequests, 1, 'Editing the draft regenerated a prediction')
      await control.command('nativePress', INPUT, { key: 'Enter' })
      assert.equal(await control.command('getValue', INPUT), SUGGESTION)
      assert.equal(normalRequests, 1, 'Accepting the suggestion sent a message')
      await capture('reply-05-accepted-not-sent.png')
      await control.command('fill', INPUT, { value: EDITED })
      await capture('reply-06-edited-draft.png')
      await control.command('nativePress', INPUT, { key: 'Enter' })
      await control.command('waitFor', `${ACTIVE} [data-testid="message-assistant"]`, {
        text: '迁移完成，任务仍在运行。',
        timeoutMs: 30000,
      })
      assert.equal(normalRequests, 2)
      await capture('reply-07-edited-sent.png')
      await control.command('navigate', 'body', { value: '/settings/personal/models' })
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
    },
    diagnostics() {
      return { normalRequests, predictionRequests }
    },
  }
}
