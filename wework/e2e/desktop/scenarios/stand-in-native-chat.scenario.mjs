import assert from 'node:assert/strict'
import { createDesktopScenario as createSessions } from './stand-in-sessions.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCreated,
  responseCompleted,
  selectTool,
} from '../modules/response-protocol.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'

const FIRST = 'STAND_IN_NATIVE_BACKGROUND_REQUEST'
const NEXT = 'STAND_IN_NATIVE_SECOND_MESSAGE'
const CHILD = 'STAND_IN_NATIVE_CHILD_WORK'
const RESULT = '原生子代理已经完成后台检查。'
const CHAT =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-conversation"]'

/** Extend the CI-owned session checkpoint without another app or Backend lifecycle. */
export function createDesktopScenario(options) {
  const sessions = createSessions(options)
  let active = false
  let spawned = false
  let followedUp = false
  let childResponse
  let released = false
  let sequence = 0
  const reply = (response, events) => {
    const id = `native-stand-in-${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  const releaseChild = () => {
    if (!childResponse || released) return
    released = true
    reply(childResponse, [assistantMessage('Native child verified its isolated work.')])
  }
  return {
    ...sessions,
    async handleHttp(request, response, url) {
      if (!active) return sessions.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      if (isCollaborationSubagentRequest(request.headers) && input.includes(CHILD)) {
        assert.equal(childResponse, undefined, 'Create exactly one real native child')
        childResponse = response
        return true
      }
      if (!input.includes(FIRST)) return false
      if (!spawned) {
        spawned = true
        reply(
          response,
          selectedToolCall(
            'native-chat-spawn',
            selectTool(body, 'spawn_agent', {
              task_name: 'stand_in_native_chat',
              message: CHILD,
            })
          )
        )
      } else if (released) {
        const result = assistantMessage(RESULT)
        result.item.id = 'native-chat-result'
        reply(response, [result])
      } else {
        const receivedNext = input.includes(NEXT)
        const events = []
        if (receivedNext && !followedUp) {
          followedUp = true
          const acknowledgement = assistantMessage('第二句话已收到，原来的子代理继续执行。')
          acknowledgement.item.id = 'native-chat-followup'
          events.push(acknowledgement)
        } else if (!receivedNext && sequence === 1) {
          events.push(assistantMessage('已交给原生子代理，你可以继续交代其他事情。'))
        }
        for (const event of events) event.item.phase = 'commentary'
        events.push(
          ...selectedToolCall(
            `native-chat-wait-${sequence}`,
            selectTool(body, 'wait_agent', {
              timeout_ms: 60000,
            }),
            events.length
          )
        )
        reply(response, events)
      }
      return true
    },
    async verify(control) {
      await sessions.verify(control)
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      const send = async text => {
        const editor = `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`
        await control.command('fill', editor, { value: text })
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      }
      const badge = '[data-testid="personal-stand-in-unread-count"]'
      try {
        await control.command('focusMainWindow', 'body')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', CHAT)
        await control.command('waitFor', badge, { visible: false })
        active = true
        await send(FIRST)
        await storyUntil(
          () => Promise.resolve(Boolean(childResponse)),
          Boolean,
          options.modelResponseTimeoutMs,
          'The real native subagent must reach the model'
        )
        await control.command(
          'waitFor',
          `${CHAT} [data-testid="assistant-message-content"].rounded-3xl`,
          {
            text: '已交给原生子代理',
            timeoutMs: options.modelResponseTimeoutMs,
          }
        )
        const primary = await rpc('runtime.tasks.get', { taskId: 'stand-in-chat-9001-primary' })
        assert.equal(
          primary.task.running,
          true,
          'The parent remains active while waiting on its native child'
        )
        await send(NEXT)
        await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
          text: '第二句话已收到',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.equal(released, false, 'Follow-up must be processed before the child completes')
        assert.equal(followedUp, true)
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('closeMainWindowToTray', 'body')
        releaseChild()
        await control.command('waitFor', badge, {
          text: '1',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await control.command('focusMainWindow', 'body')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', `${CHAT} [data-testid="assistant-message-content"]`, {
          text: RESULT,
        })
        await control.command(
          'waitFor',
          `${CHAT} [data-testid="message-assistant"]:has([data-runtime-item-id="native-chat-followup"]):not(:has([data-runtime-item-id="native-chat-result"]))`,
          {
            text: '第二句话已收到',
          }
        )
        await control.command(
          'waitFor',
          `${CHAT} [data-testid="message-assistant"]:has([data-runtime-item-id="native-chat-result"]):not(:has([data-runtime-item-id="native-chat-followup"]))`,
          {
            text: RESULT,
          }
        )
        await control.command('waitFor', `${CHAT} [data-testid="processing-duration-label"]`, {
          visible: false,
        })
        await control.command('waitFor', `${CHAT} [data-testid="final-processing-toggle"]`, {
          visible: false,
        })
        await control.command('waitFor', badge, { visible: false })
        const after = await rpc('runtime.tasks.get', { taskId: 'stand-in-chat-9001-primary' })
        assert.equal(
          after.task.threadId,
          primary.task.threadId,
          'All messages remain in the same identity conversation'
        )
      } finally {
        releaseChild()
        await control.command('focusMainWindow', 'body')
      }
    },
    diagnostics() {
      return { sessions: sessions.diagnostics(), active, spawned, followedUp, released, sequence }
    },
  }
}
