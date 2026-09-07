import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutorSessionProjector, executorSessionId } from './session-projector.js'

test('projects executor text, reasoning, usage, and completion into standard session events', () => {
  const sessions = new SessionStoreFixture()
  const completed = []
  const projector = new ExecutorSessionProjector(sessions, {
    onTurnCompleted: turn => completed.push(turn),
  })

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
  assert.equal(completed.length, 1)
  assert.match(completed[0].turnId, /^[A-Za-z0-9_-]{43}$/u)
  assert.deepEqual(
    { ...completed[0], turnId: '<stable-sync-turn-id>' },
    {
      transcriptId: 'task-1',
      taskId: 'task-1',
      title: '',
      sequence: 1,
      turnId: '<stable-sync-turn-id>',
      sessionId: executorSessionId('device-1', 'task-1'),
      executorTurnId: 'task-1-turn-1',
    }
  )
})

test('uses device-scoped stable turn identities for cross-device transcript sequencing', () => {
  const completed = []
  for (const deviceId of ['device-a', 'device-b']) {
    const projector = new ExecutorSessionProjector(new SessionStoreFixture(), {
      onTurnCompleted: turn => completed.push(turn),
    })
    projector.handle({
      ...executorEvent(1, 'response.completed', {}),
      payload: {
        ...executorEvent(1, 'response.completed', {}).payload,
        deviceId,
        transcriptId: 'shared-transcript',
      },
    })
  }

  assert.equal(completed[0].transcriptId, 'shared-transcript')
  assert.equal(completed[1].transcriptId, 'shared-transcript')
  assert.notEqual(completed[0].turnId, completed[1].turnId)
})

test('projects streamed Executor text blocks into standard assistant deltas', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(executorEvent(1, 'response.created', {}))
  projector.handle(
    executorEvent(2, 'response.block.created', {
      block: {
        id: 'reasoning-1',
        type: 'thinking',
        process_kind: 'reasoning',
        content: 'Inspect',
        status: 'streaming',
      },
    })
  )
  projector.handle(
    executorEvent(3, 'response.block.updated', {
      block_id: 'reasoning-1',
      updates: { content_delta: ' logs', status: 'streaming' },
    })
  )
  projector.handle(
    executorEvent(4, 'response.block.created', {
      block: {
        id: 'message-1',
        type: 'text',
        process_kind: 'assistant_message',
        content: 'Fix',
        status: 'streaming',
      },
    })
  )
  projector.handle(
    executorEvent(5, 'response.block.updated', {
      block_id: 'message-1',
      updates: { content: 'Fixed', status: 'done' },
    })
  )

  const session = sessions.get(executorSessionId('device-1', 'task-1'))
  const deltas = session.events
    .filter(
      event =>
        event.type === 'assistant/chunk' &&
        (event.data.chunk.type === 'text-delta' || event.data.chunk.type === 'reasoning-delta')
    )
    .map(event => [event.data.chunk.type, event.data.chunk.text])
  assert.deepEqual(deltas, [
    ['reasoning-delta', 'Inspect'],
    ['reasoning-delta', ' logs'],
    ['text-delta', 'Fix'],
    ['text-delta', 'ed'],
  ])
})

test('ignores non-model workbench blocks in the standard assistant stream', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(
    executorEvent(1, 'response.block.created', {
      block: {
        id: 'tool-1',
        type: 'tool',
        content: 'command output',
        status: 'streaming',
      },
    })
  )

  const session = sessions.get(executorSessionId('device-1', 'task-1'))
  assert.equal(
    session.events.some(event => event.type === 'assistant/chunk'),
    false
  )
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

test('projects per-call Codex usage as cumulative usage within the DSH turn', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(executorEvent(1, 'response.created', {}))
  projector.handle(
    executorEvent(2, 'thread/tokenUsage/updated', {
      tokenUsage: {
        total: usageBreakdown(1000, 100, 400, 10, 20),
        last: usageBreakdown(1000, 100, 400, 10, 20),
      },
    })
  )
  projector.handle(
    executorEvent(3, 'thread/tokenUsage/updated', {
      tokenUsage: {
        total: usageBreakdown(2200, 160, 1200, 20, 25),
        last: usageBreakdown(1200, 60, 800, 10, 5),
      },
    })
  )
  projector.handle(
    executorEvent(4, 'thread/tokenUsage/updated', {
      tokenUsage: {
        total: usageBreakdown(3100, 220, 1900, 30, 35),
        last: usageBreakdown(900, 60, 700, 10, 10),
      },
    })
  )
  projector.handle(
    executorEvent(5, 'response.completed', {
      response: {
        usage: {
          input_tokens: 900,
          output_tokens: 60,
          input_tokens_details: { cached_tokens: 700 },
          output_tokens_details: { reasoning_tokens: 10 },
        },
      },
    })
  )

  const session = sessions.get(executorSessionId('device-1', 'task-1'))
  const usageEvents = session.events.filter(
    event => event.type === 'assistant/chunk' && event.data.chunk.type === 'usage'
  )
  assert.deepEqual(
    usageEvents.map(event => event.data.chunk.usage),
    [
      {
        inputTokens: 600,
        outputTokens: 100,
        cacheReadTokens: 400,
        cacheWriteTokens: 10,
        reasoningTokens: 20,
      },
      {
        inputTokens: 1000,
        outputTokens: 160,
        cacheReadTokens: 1200,
        cacheWriteTokens: 20,
        reasoningTokens: 25,
      },
      {
        inputTokens: 1200,
        outputTokens: 220,
        cacheReadTokens: 1900,
        cacheWriteTokens: 30,
        reasoningTokens: 35,
      },
    ]
  )
  assert.deepEqual(
    session.events.find(event => event.type === 'assistant/message').data.usage,
    usageEvents.at(-1).data.chunk.usage
  )
})

test('keeps the source usage baseline while resetting projected usage for a new turn', () => {
  const sessions = new SessionStoreFixture()
  const projector = new ExecutorSessionProjector(sessions)

  projector.handle(executorEvent(1, 'response.created', {}))
  projector.handle(
    executorEvent(2, 'thread/tokenUsage/updated', {
      tokenUsage: {
        total: usageBreakdown(1000, 100, 400, 10, 20),
        last: usageBreakdown(1000, 100, 400, 10, 20),
      },
    })
  )
  projector.handle(executorEvent(3, 'response.completed', {}))
  projector.handle(executorEvent(4, 'response.created', {}, 'task-1', 'turn-2'))
  projector.handle(
    executorEvent(
      5,
      'thread/tokenUsage/updated',
      {
        tokenUsage: {
          total: usageBreakdown(1800, 150, 1000, 20, 25),
          last: usageBreakdown(800, 50, 600, 10, 5),
        },
      },
      'task-1',
      'turn-2'
    )
  )

  const session = sessions.get(executorSessionId('device-1', 'task-1'))
  const usageEvents = session.events.filter(
    event => event.type === 'assistant/chunk' && event.data.chunk.type === 'usage'
  )
  assert.deepEqual(usageEvents.at(-1).data.chunk.usage, {
    inputTokens: 200,
    outputTokens: 50,
    cacheReadTokens: 600,
    cacheWriteTokens: 10,
    reasoningTokens: 5,
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

test('does not enqueue internal context compaction as a portable conversation turn', () => {
  const completed = []
  const projector = new ExecutorSessionProjector(new SessionStoreFixture(), {
    onTurnCompleted: turn => completed.push(turn),
  })

  projector.handle(
    executorEvent(1, 'response.completed', {}, 'task-1', 'runtime-task-1-context-compact')
  )
  projector.handle(executorEvent(2, 'response.completed', {}, 'task-1', 'user-turn-2'))

  assert.equal(completed.length, 1)
  assert.equal(completed[0].executorTurnId, 'user-turn-2')
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

function executorEvent(sequence, event, data, taskId = 'task-1', subtaskId = `${taskId}-turn-1`) {
  return {
    type: 'event',
    protocolVersion: 1,
    sequence,
    event,
    payload: {
      taskId,
      subtaskId,
      deviceId: 'device-1',
      data,
      ...(data.runtimeGeneratedUserMessage
        ? { runtimeGeneratedUserMessage: data.runtimeGeneratedUserMessage }
        : {}),
    },
  }
}

function usageBreakdown(
  inputTokens,
  outputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  reasoningOutputTokens
) {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  }
}
