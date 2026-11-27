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
  toolOutputText,
} from '../modules/response-protocol.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'

const FIRST = 'STAND_IN_NATIVE_BACKGROUND_REQUEST'
const NEXT = 'STAND_IN_NATIVE_SECOND_MESSAGE'
const AUTO = 'STAND_IN_NATIVE_AUTOMATIC_GUIDANCE'
const CHILD = 'STAND_IN_NATIVE_CHILD_WORK'
const CHILD_RESULT = 'Native child verified its isolated work.'
const ACKNOWLEDGEMENT = '已交给原生子代理，你可以继续交代其他事情。'
const ACKNOWLEDGEMENT_ID = 'native-chat-acknowledgement'
const RESULT = '原生子代理已经完成后台检查。'
const NOTIFICATION_REQUEST = 'STAND_IN_NATIVE_NOTIFICATION_REQUEST'
const NOTIFICATION_RESULT = '助理已完成后台核对。'
const NOTIFICATION_RESULT_ID = 'native-chat-notification-result'
const CHAT =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-conversation"]'
const WAITING = `${CHAT} [data-testid="message-assistant-waiting"]`
const TRANSPARENT_BACKGROUND = 'rgba(0, 0, 0, 0)'

async function assertBorderlessAssistantText(control, selector) {
  const style = {
    backgroundColor: await control.command('getComputedStyleValue', selector, {
      value: 'background-color',
    }),
    boxShadow: await control.command('getComputedStyleValue', selector, { value: 'box-shadow' }),
    borderTopWidth: await control.command('getComputedStyleValue', selector, {
      value: 'border-top-width',
    }),
  }
  assert.deepEqual(
    style,
    { backgroundColor: TRANSPARENT_BACKGROUND, boxShadow: 'none', borderTopWidth: '0px' },
    'The assistant reply uses borderless text'
  )
  return style
}

/** Extend the CI-owned session checkpoint without another app or Backend lifecycle. */
export function createDesktopScenario(options) {
  const sessions = createSessions(options)
  let active = false
  let spawned = false
  let followedUp = false
  let automaticallyGuided = false
  let childResultObserved = false
  let nativeWaitObserved = false
  let lastWaitCallId
  let lastWaitResult
  let childResponse
  let notificationResponse
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
    reply(childResponse, [assistantMessage(CHILD_RESULT)])
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
      if (input.includes(NOTIFICATION_REQUEST)) {
        assert.equal(
          notificationResponse,
          undefined,
          'The notification request uses one model turn'
        )
        notificationResponse = response
        return true
      }
      if (isCollaborationSubagentRequest(request.headers) && input.includes(CHILD)) {
        assert.equal(childResponse, undefined, 'Create exactly one real native child')
        childResponse = response
        return true
      }
      if (!input.includes(FIRST)) return false
      if (lastWaitCallId) {
        const output = toolOutputText(body, lastWaitCallId)
        if (output != null) {
          lastWaitResult = output.slice(0, 2000)
          try {
            if (typeof JSON.parse(output).timed_out === 'boolean') nativeWaitObserved = true
          } catch {
            // Retain the result for diagnosis; the final assertion requires a real native wait.
          }
        }
      }
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
      } else if (released && input.includes(CHILD_RESULT)) {
        childResultObserved = true
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
          const acknowledgement = assistantMessage(ACKNOWLEDGEMENT)
          acknowledgement.item.id = ACKNOWLEDGEMENT_ID
          events.push(acknowledgement)
        }
        if (input.includes(AUTO) && !automaticallyGuided) {
          automaticallyGuided = true
          events.push(assistantMessage('普通发送也已进入正在运行的这一轮。'))
        }
        for (const event of events) event.item.phase = 'commentary'
        lastWaitCallId = `native-chat-wait-${sequence}`
        events.push(
          ...selectedToolCall(
            lastWaitCallId,
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
      const editor = `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`
      const send = async text => {
        await control.command('fill', editor, { value: text })
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      }
      const badge = '[data-testid="personal-stand-in-unread-count"]'
      try {
        await control.command('focusMainWindow', 'body')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', CHAT)
        await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
          text: '后续消息仍在第二段',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await control.command('waitFor', badge, { visible: false })
        active = true
        await send(FIRST)
        await storyUntil(
          () => Promise.resolve(Boolean(childResponse)),
          Boolean,
          options.modelResponseTimeoutMs,
          'The real native subagent must reach the model'
        )
        const assistantContent = `${CHAT} [data-testid="assistant-message-content"]`
        const initialAcknowledgement = `${assistantContent}[data-runtime-item-id="${ACKNOWLEDGEMENT_ID}"]`
        await control.command('waitFor', initialAcknowledgement, {
          text: ACKNOWLEDGEMENT,
          visible: true,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        const primary = await rpc('runtime.tasks.get', { taskId: 'stand-in-chat-9001-primary' })
        assert.equal(
          primary.task.running,
          true,
          'The parent remains active while waiting on its native child'
        )
        const oldSelector = `${assistantContent}.rounded-3xl`
        const oldSelectorMatches = await control.command('getElementCount', oldSelector)
        const currentSelectorMatches = await control.command(
          'getElementCount',
          initialAcknowledgement
        )
        assert.equal(oldSelectorMatches, '0', 'The old bubble selector must no longer match')
        assert.equal(currentSelectorMatches, '1', 'The acknowledgement is rendered exactly once')
        const style = await assertBorderlessAssistantText(control, initialAcknowledgement)
        const childHeld = Boolean(
          childResponse && !released && !childResponse.writableEnded && !childResponse.destroyed
        )
        assert.equal(
          childHeld,
          true,
          'The acknowledgement is visible while the native child is held'
        )
        console.log(
          '[stand-in-native-chat] acknowledgement-style',
          JSON.stringify({
            oldSelectorMatches,
            currentSelectorMatches,
            style,
            parentRunning: primary.task.running,
            childHeld,
          })
        )
        await control.command('waitFor', WAITING, {
          visible: false,
          timeoutMs: options.uiTimeoutMs,
        })
        await control.command('waitFor', `${CHAT} [data-testid="send-message-button"]`, {
          visible: true,
          timeoutMs: options.uiTimeoutMs,
        })
        await control.command('waitFor', `${CHAT} [data-testid="pause-response-button"]`, {
          visible: false,
          timeoutMs: options.uiTimeoutMs,
        })
        // The explicit guide action remains available during the active parent turn.
        await control.command(
          'fill',
          `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`,
          {
            value: NEXT,
          }
        )
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-mode-menu-button"]`)
        await control.command('clickWhenEnabled', '[data-testid="guide-current-turn-option"]')
        await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
          text: '第二句话已收到',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.equal(released, false, 'Follow-up must be processed before the child completes')
        assert.equal(followedUp, true)
        await send(AUTO)
        await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
          text: '普通发送也已进入正在运行的这一轮。',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.equal(automaticallyGuided, true)
        assert.equal(released, false)
        // Renderer controls can remain usable even after macOS gives focus to another app.
        // Establish that all foreground replies have been read before leaving the conversation.
        await control.command('focusMainWindow', 'body')
        await control.command('waitFor', badge, { visible: false })
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
        assert.equal(
          childResultObserved,
          true,
          'The parent must receive the real child result before reporting it'
        )
        assert.equal(
          nativeWaitObserved,
          true,
          'The parent must successfully use native mailbox wait, not poll tool errors'
        )
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
        await control.command('clearSystemNotifications', 'body')
        await send(NOTIFICATION_REQUEST)
        await storyUntil(
          () => Promise.resolve(Boolean(notificationResponse)),
          Boolean,
          options.modelResponseTimeoutMs,
          'The background notification request must reach the model'
        )
        const running = await rpc('runtime.tasks.get', { taskId: primary.task.taskId })
        assert.equal(running.task.threadId, primary.task.threadId)
        assert.equal(
          running.task.running,
          true,
          'The assistant turn is running with the model held'
        )
        const userMessage = `${CHAT} [data-testid="user-message-content"]`
        const thinking = `${WAITING} [data-testid="thinking-indicator"][role="status"]`
        const dots = `${thinking} > [aria-hidden="true"]`
        await control.command('waitFor', userMessage, {
          text: NOTIFICATION_REQUEST,
          visible: true,
          timeoutMs: options.uiTimeoutMs,
        })
        await control.command('waitFor', editor, {
          visible: true,
          timeoutMs: options.uiTimeoutMs,
        })
        try {
          for (const [preference, animationName] of [
            ['no-preference', 'pulse'],
            ['reduce', 'none'],
          ]) {
            await control.command('setReducedMotion', 'body', { value: preference })
            await control.command('waitFor', thinking, {
              text: '正在思考',
              visible: true,
              timeoutMs: options.uiTimeoutMs,
            })
            assert.equal(
              await control.command('getElementCount', dots),
              '3',
              `The held turn shows three thinking dots with ${preference}`
            )
            assert.equal(
              await control.command('getComputedStyleValue', `${dots}:last-child`, {
                value: 'animation-name',
              }),
              animationName,
              `The running indicator respects ${preference} while the model response is held`
            )
          }
        } finally {
          await control.command('setReducedMotion', 'body', { value: 'system' })
        }
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('closeMainWindowToTray', 'body')
        const acknowledgement = assistantMessage('收到，正在核对。')
        acknowledgement.item.phase = 'commentary'
        const result = assistantMessage(NOTIFICATION_RESULT)
        result.item.id = NOTIFICATION_RESULT_ID
        reply(notificationResponse, [acknowledgement, result])
        const notifications = await storyUntil(
          async () =>
            JSON.parse(await control.command('getSystemNotifications', 'body')).filter(
              item => item.address?.taskId === primary.task.taskId
            ),
          items => items.some(item => item.body === NOTIFICATION_RESULT),
          options.modelResponseTimeoutMs,
          'The assistant must deliver the final reply through the system notification channel'
        )
        assert.deepEqual(
          notifications.map(({ title, body }) => ({ title, body })),
          [{ title: '我的助理', body: NOTIFICATION_RESULT }],
          'The acknowledgement and result must produce only one system notification from the assistant'
        )
        await control.command('focusMainWindow', 'body')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        const assistantMessageContent = `${assistantContent}[data-runtime-item-id="${NOTIFICATION_RESULT_ID}"]`
        await control.command('waitFor', assistantMessageContent, {
          text: NOTIFICATION_RESULT,
          visible: true,
          timeoutMs: options.uiTimeoutMs,
        })
        await control.command('waitFor', WAITING, {
          visible: false,
          timeoutMs: options.uiTimeoutMs,
        })
        assert.equal(await control.command('getElementCount', WAITING), '0')
        const userMessageId = await control.command('getAttribute', userMessage, {
          text: NOTIFICATION_REQUEST,
          value: 'data-search-region-id',
        })
        assert.notEqual(
          await control.command(
            'getComputedStyleValue',
            `${userMessage}[data-search-region-id=${JSON.stringify(userMessageId)}]`,
            { value: 'background-color' }
          ),
          TRANSPARENT_BACKGROUND,
          'The user message keeps its filled bubble'
        )
        await assertBorderlessAssistantText(control, assistantMessageContent)
      } finally {
        releaseChild()
        if (notificationResponse && !notificationResponse.writableEnded) notificationResponse.end()
        await control.command('focusMainWindow', 'body')
      }
    },
    diagnostics() {
      return {
        sessions: sessions.diagnostics(),
        active,
        spawned,
        followedUp,
        childResultObserved,
        nativeWaitObserved,
        lastWaitResult,
        released,
        sequence,
      }
    },
  }
}
