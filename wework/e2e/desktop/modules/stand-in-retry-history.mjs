import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { mcpToolRequestEvents, requestContainsToolOutput } from './response-protocol.mjs'

const HISTORY_CALL = 'retry-previous-conversation'

export function retryConversationHistory(
  body,
  { marker, retryTaskId, retryThreadId, retrySameNativeThread = false }
) {
  assert.ok(retryTaskId && retryThreadId, 'Retry must retain its original logical conversation')
  const conversation = (body.input ?? []).filter(item => ['user', 'assistant'].includes(item.role))
  const message = conversation.filter(item => item.role === 'user').at(-1)
  const text =
    typeof message?.content === 'string'
      ? message.content
      : (message?.content ?? []).map(part => part.text ?? '').join('')
  if (retrySameNativeThread) {
    assert.equal(
      conversation.filter(
        item => item.role === 'user' && JSON.stringify(item.content).includes(`${marker}_CHAT_`)
      ).length,
      1,
      'An in-place retry must retain exactly one original native request'
    )
    for (const previous of ['OFFICIAL', 'PROGRESS'])
      assert.ok(
        conversation.some(
          item =>
            item.role === 'assistant' &&
            JSON.stringify(item.content).includes(`${marker}_${previous}`)
        ),
        `An in-place retry must retain its previous native ${previous} content`
      )
  } else {
    assert.ok(
      text.includes(`read_task(${JSON.stringify({ taskId: retryTaskId })})`),
      'A new-session retry must identify the exact authorized conversation history'
    )
    assert.equal(
      JSON.stringify(conversation).includes(`${marker}_OFFICIAL`),
      false,
      'A cross-provider retry must not copy the previous official native session'
    )
  }
  assert.equal(
    JSON.stringify(retrySameNativeThread ? [message] : conversation).includes(`${marker}_CHAT_`),
    false,
    'Retry must send the continuation prompt rather than replaying the original request'
  )

  const messages = []
  const cursors = new Set()
  let beforeCursor
  for (let pageIndex = 0; ; pageIndex++) {
    const callId = pageIndex === 0 ? HISTORY_CALL : `${HISTORY_CALL}-${pageIndex}`
    if (!requestContainsToolOutput(body, callId)) {
      return {
        events: mcpToolRequestEvents(body, {
          toolName: 'read_task',
          directToolName: 'mcp__wework_stand_in__read_task',
          argumentsValue: { taskId: retryTaskId, ...(beforeCursor ? { beforeCursor } : {}) },
          searchCallId: `${callId}-search`,
          toolCallId: callId,
        }).events,
      }
    }
    const history = JSON.parse(readMcpToolOutput(body, callId))
    assert.equal(history.success, true, 'Retry must successfully read real authorized history')
    assert.equal(history.taskId, retryTaskId, 'Retry must read its exact original logical task')
    assert.ok(Array.isArray(history.messages), 'Retry must consume actual conversation messages')
    assert.ok(
      history.messages.every(message => message.contentComplete !== false),
      'The bounded retry fixture must read complete message content'
    )
    messages.unshift(...history.messages)
    if (history.hasMoreBefore !== true) return { messages }
    assert.ok(
      typeof history.beforeCursor === 'string' && history.beforeCursor.trim(),
      'Retry must receive an earlier history cursor'
    )
    assert.ok(!cursors.has(history.beforeCursor), 'Retry history pagination must advance')
    cursors.add(history.beforeCursor)
    beforeCursor = history.beforeCursor
  }
}
