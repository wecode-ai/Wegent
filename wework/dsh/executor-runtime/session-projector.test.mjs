import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutorSessionProjector, executorSessionId } from './session-projector.js'

test('projects executor text, reasoning, usage, and completion into standard session events', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(
    executorEvent(1, 'response.created', {
      runtimeGeneratedUserMessage: { id: 'user-1', message: 'Build the feature' },
    })
  )
  projector.handle(executorEvent(2, 'response.reasoning_summary_text.delta', { delta: 'Think' }))
  projector.handle(executorEvent(3, 'response.output_text.delta', { delta: 'Done' }))
  projector.handle(
    executorEvent(4, 'thread/tokenUsage/updated', {
      tokenUsage: {
        total: {
          inputTokens: 1000,
          cachedInputTokens: 400,
          outputTokens: 250,
          reasoningOutputTokens: 50,
        },
        last: {
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 25,
          reasoningOutputTokens: 5,
        },
      },
    })
  )
  projector.handle(executorEvent(5, 'response.completed', {}))

  const session = sessions.get(executorSessionId('device-1', 'task-1'))
  assert.ok(session)
  assert.deepEqual(
    session.events.map(event => event.type),
    [
      'turn/start',
      'step/start',
      'user/message',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ]
  )
  const message = session.events.find(event => event.type === 'assistant/message')
  assert.deepEqual(message.data.message.content, [
    { type: 'reasoning', text: 'Think' },
    { type: 'text', text: 'Done' },
  ])
  assert.deepEqual(message.data.usage, {
    inputTokens: 60,
    outputTokens: 25,
    cacheReadTokens: 40,
    reasoningTokens: 5,
  })
  assert.equal(session.events.at(-1).data.reason.kind, 'completed')
})

test('keeps parallel executor tasks in independent DSH sessions', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(executorEvent(1, 'response.output_text.delta', { delta: 'A' }, 'task-a'))
  projector.handle(executorEvent(2, 'response.output_text.delta', { delta: 'B' }, 'task-b'))

  const first = sessions.get(executorSessionId('device-1', 'task-a'))
  const second = sessions.get(executorSessionId('device-1', 'task-b'))
  assert.equal(first.events.find(event => event.type === 'assistant/chunk').data.turn, 1)
  assert.equal(second.events.find(event => event.type === 'assistant/chunk').data.turn, 1)
  assert.notEqual(first, second)
})

test('uses final response usage when no live token update was emitted', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(
    executorEvent(1, 'response.completed', {
      response: {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Final answer' }],
          },
        ],
        usage: {
          input_tokens: 30,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    })
  )

  const session = sessions.get(executorSessionId('device-1', 'task-1'))
  const message = session.events.find(event => event.type === 'assistant/message')
  assert.deepEqual(message.data.message.content, [{ type: 'text', text: 'Final answer' }])
  assert.deepEqual(message.data.usage, {
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 20,
    reasoningTokens: 3,
  })
})

test('marks failed executor responses as interrupted error turns', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(executorEvent(1, 'response.output_text.delta', { delta: 'Partial' }))
  projector.handle(
    executorEvent(2, 'response.failed', {
      error: { code: 'MODEL_FAILED', message: 'Provider failed' },
    })
  )

  const session = sessions.get(executorSessionId('device-1', 'task-1'))
  const message = session.events.find(event => event.type === 'assistant/message')
  assert.equal(message.data.interrupted, true)
  assert.deepEqual(session.events.at(-1).data.reason, {
    kind: 'error',
    error: { message: 'Provider failed', code: 'MODEL_FAILED' },
  })
})

class SessionStoreFixture {
  constructor() {
    this.values = new Map()
  }

  get(id) {
    return this.values.get(id)
  }

  create(id) {
    const session = new SessionFixture(id)
    this.values.set(id, session)
    return session
  }
}

class SessionFixture {
  constructor(id) {
    this.id = id
    this.events = []
  }

  append(type, data, options) {
    const event = {
      type,
      data: structuredClone(data),
      seq: this.events.length,
      ...(options ?? {}),
    }
    this.events.push(event)
    return event
  }
}

function executorEvent(sequence, event, data, taskId = 'task-1') {
  return {
    type: 'event',
    protocolVersion: 1,
    sequence,
    event,
    payload: {
      taskId,
      subtaskId: `${taskId}-turn-1`,
      deviceId: 'device-1',
      data,
      ...(data.runtimeGeneratedUserMessage
        ? { runtimeGeneratedUserMessage: data.runtimeGeneratedUserMessage }
        : {}),
    },
  }
}
