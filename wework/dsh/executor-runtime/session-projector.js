import { createHash, randomUUID } from 'node:crypto'

const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'error',
])

export class ExecutorSessionProjector {
  constructor(sessions, options = {}) {
    this.sessions = sessions
    this.onTurnCompleted = options.onTurnCompleted ?? (() => {})
    this.tasks = new Map()
  }

  handle(envelope) {
    if (!isRecord(envelope) || envelope.type !== 'event' || !isRecord(envelope.payload)) return
    const payload = envelope.payload
    const taskId = stringField(payload, 'taskId')
    if (!taskId) return

    const state = this.taskState(payload, taskId)
    const taskTitle = stringField(payload, 'taskTitle')
    if (taskTitle) state.title = taskTitle
    const event = stringField(envelope, 'event')
    if (!event) return
    const subtaskId = stringField(payload, 'subtaskId')

    if (event === 'response.created' || event === 'response.in_progress') {
      this.openTurn(state, subtaskId)
      this.appendGeneratedUserMessage(state, payload)
      return
    }

    if (event === 'response.output_text.delta' || event === 'response.refusal.delta') {
      const text = stringField(recordField(payload, 'data'), 'delta')
      if (text) this.appendDelta(state, subtaskId, 'text', text)
      return
    }

    if (
      event === 'response.reasoning_summary_text.delta' ||
      event === 'response.reasoning_summary_part.added'
    ) {
      const data = recordField(payload, 'data')
      const text =
        stringField(data, 'delta') ??
        stringField(data, 'text') ??
        stringField(recordField(data, 'part'), 'text')
      if (text) this.appendDelta(state, subtaskId, 'reasoning', text)
      return
    }

    if (event === 'response.block.created') {
      this.appendBlockCreated(state, subtaskId, recordField(payload, 'data'))
      return
    }

    if (event === 'response.block.updated') {
      this.appendBlockUpdated(state, subtaskId, recordField(payload, 'data'))
      return
    }

    if (event === 'thread/tokenUsage/updated' || event === 'thread.tokenUsage.updated') {
      const runtimeUsage = recordField(recordField(payload, 'data'), 'tokenUsage')
      const totalUsage = tokenUsage(recordField(runtimeUsage, 'total'))
      const lastUsage = tokenUsage(recordField(runtimeUsage, 'last'))
      const increment = usageIncrement(totalUsage, state.sourceUsage, lastUsage)
      if (!increment || !totalUsage) return
      this.ensureOpenTurn(state, subtaskId)
      state.sourceUsage = totalUsage
      state.usage = addUsage(state.usage, increment)
      const appended = state.session.append('assistant/chunk', {
        turn: state.turn,
        step: 1,
        chunk: { type: 'usage', usage: state.usage },
      })
      state.sourceEventSeqs.push(appended.seq)
      return
    }

    if (TERMINAL_EVENTS.has(event)) {
      this.finishTurn(state, subtaskId, event, recordField(payload, 'data'))
    }
  }

  taskState(payload, taskId) {
    const deviceId = stringField(payload, 'deviceId') ?? 'local'
    const key = `${deviceId}\u0000${taskId}`
    const existing = this.tasks.get(key)
    if (existing) return existing

    const sessionId = executorSessionId(deviceId, taskId)
    const session = this.sessions.get(sessionId) ?? this.sessions.create(sessionId)
    const state = {
      session,
      deviceId,
      taskId,
      transcriptId: stringField(payload, 'transcriptId') ?? taskId,
      title: stringField(payload, 'taskTitle') ?? '',
      turn: completedTurns(session),
      subtaskId: null,
      open: false,
      text: '',
      reasoning: '',
      textStarted: false,
      reasoningStarted: false,
      usage: null,
      sourceUsage: null,
      blocks: new Map(),
      sourceEventSeqs: [],
      generatedUserMessageIds: new Set(),
    }
    this.tasks.set(key, state)
    return state
  }

  openTurn(state, subtaskId) {
    if (state.open && (!subtaskId || state.subtaskId === subtaskId)) return
    if (state.open) this.closeTurn(state, 'response.incomplete', {})

    state.turn += 1
    state.subtaskId = subtaskId ?? null
    state.open = true
    state.text = ''
    state.reasoning = ''
    state.textStarted = false
    state.reasoningStarted = false
    state.usage = null
    state.blocks.clear()
    state.sourceEventSeqs = []
    state.session.append('turn/start', { turn: state.turn })
    state.session.append('step/start', { turn: state.turn, step: 1 })
  }

  ensureOpenTurn(state, subtaskId) {
    if (!state.open || (subtaskId && state.subtaskId && subtaskId !== state.subtaskId)) {
      this.openTurn(state, subtaskId)
    }
  }

  appendGeneratedUserMessage(state, payload) {
    const generated = recordField(payload, 'runtimeGeneratedUserMessage')
    const text = stringField(generated, 'message')
    if (!text) return
    const id = stringField(generated, 'id') ?? randomUUID()
    if (state.generatedUserMessageIds.has(id)) return
    state.generatedUserMessageIds.add(id)
    state.session.append(
      'user/message',
      {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' }
    )
  }

  appendDelta(state, subtaskId, kind, text) {
    this.ensureOpenTurn(state, subtaskId)
    const index = kind === 'reasoning' ? 0 : 1
    const startedKey = kind === 'reasoning' ? 'reasoningStarted' : 'textStarted'
    if (!state[startedKey]) {
      const start = state.session.append('assistant/chunk', {
        turn: state.turn,
        step: 1,
        chunk: { type: 'block-start', index, blockType: kind },
      })
      state.sourceEventSeqs.push(start.seq)
      state[startedKey] = true
    }
    state[kind] += text
    const appended = state.session.append('assistant/chunk', {
      turn: state.turn,
      step: 1,
      chunk: {
        type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
        index,
        text,
      },
    })
    state.sourceEventSeqs.push(appended.seq)
  }

  appendBlockCreated(state, subtaskId, data) {
    const block = recordField(data, 'block')
    const id = stringField(block, 'id')
    const kind = projectedBlockKind(block)
    if (!id || !kind) return
    const content = stringField(block, 'content') ?? ''
    state.blocks.set(id, { kind, content })
    if (content) this.appendDelta(state, subtaskId, kind, content)
  }

  appendBlockUpdated(state, subtaskId, data) {
    const id = stringField(data, 'block_id') ?? stringField(data, 'blockId')
    if (!id) return
    const tracked = state.blocks.get(id)
    if (!tracked) return
    const updates = recordField(data, 'updates')
    const delta = stringField(updates, 'content_delta') ?? stringField(updates, 'contentDelta')
    if (delta) {
      tracked.content += delta
      this.appendDelta(state, subtaskId, tracked.kind, delta)
      return
    }
    const content = stringField(updates, 'content')
    if (!content || content === tracked.content) return
    if (!content.startsWith(tracked.content)) return
    const suffix = content.slice(tracked.content.length)
    tracked.content = content
    if (suffix) this.appendDelta(state, subtaskId, tracked.kind, suffix)
  }

  finishTurn(state, subtaskId, event, data) {
    if (!state.open) {
      if (!subtaskId || subtaskId === state.subtaskId) return
      this.openTurn(state, subtaskId)
    } else {
      this.ensureOpenTurn(state, subtaskId)
    }

    const completedText = responseText(data)
    if (!state.text && completedText) this.appendDelta(state, subtaskId, 'text', completedText)
    const completedUsage = responseUsage(data)
    if (!state.usage && completedUsage) state.usage = completedUsage
    this.closeTurn(state, event, data)
  }

  closeTurn(state, event, data) {
    if (!state.open) return
    if (state.reasoningStarted) this.appendBlockEnd(state, 'reasoning', 0)
    if (state.textStarted) this.appendBlockEnd(state, 'text', 1)
    if (event === 'response.completed') {
      const finish = state.session.append('assistant/chunk', {
        turn: state.turn,
        step: 1,
        chunk: { type: 'finish', reason: { kind: 'stop' } },
      })
      state.sourceEventSeqs.push(finish.seq)
    }

    const content = []
    if (state.reasoning) content.push({ type: 'reasoning', text: state.reasoning })
    if (state.text) content.push({ type: 'text', text: state.text })
    state.session.append(
      'assistant/message',
      {
        turn: state.turn,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content,
          source: {
            kind: 'model',
            provider: 'wegent-executor',
            model: 'executor-managed',
          },
        },
        ...(state.usage ? { usage: state.usage } : {}),
        ...(event === 'response.completed' ? {} : { interrupted: true }),
      },
      { surfaceOp: 'append', sourceEventSeqs: state.sourceEventSeqs }
    )
    state.session.append('step/end', { turn: state.turn, step: 1 })
    state.session.append('turn/end', {
      turn: state.turn,
      reason: turnEndReason(event, data),
    })
    if (syncableExecutorTurn(state.subtaskId)) {
      this.onTurnCompleted({
        transcriptId: state.transcriptId,
        taskId: state.taskId,
        title: state.title,
        sequence: state.turn,
        turnId: syncTurnId(state),
        sessionId: state.session.id,
        executorTurnId: state.subtaskId,
      })
    }
    state.open = false
  }

  appendBlockEnd(state, kind, index) {
    const appended = state.session.append('assistant/chunk', {
      turn: state.turn,
      step: 1,
      chunk: { type: 'block-end', index, block: { type: kind, text: state[kind] } },
    })
    state.sourceEventSeqs.push(appended.seq)
  }
}

function syncTurnId(state) {
  return createHash('sha256')
    .update(`${state.deviceId}\u0000${state.taskId}\u0000${state.subtaskId ?? state.turn}`)
    .digest('base64url')
}

function syncableExecutorTurn(subtaskId) {
  return !subtaskId?.endsWith('-context-compact')
}

export function executorSessionId(deviceId, taskId) {
  return `wegent-executor-${encodeId(deviceId)}-${encodeId(taskId)}`
}

function encodeId(value) {
  return Buffer.from(value).toString('base64url')
}

function completedTurns(session) {
  return session.events.reduce(
    (maximum, event) =>
      event.type === 'turn/end' && Number.isSafeInteger(event.data?.turn)
        ? Math.max(maximum, event.data.turn)
        : maximum,
    0
  )
}

function tokenUsage(value) {
  if (!isRecord(value)) return null
  const total = isRecord(value.total) ? value.total : value
  const input = nonNegativeInteger(total.inputTokens)
  const output = nonNegativeInteger(total.outputTokens)
  if (input === null || output === null) return null
  const cached = nonNegativeInteger(total.cachedInputTokens) ?? 0
  const cacheWrite = nonNegativeInteger(total.cacheWriteInputTokens) ?? 0
  const reasoning = nonNegativeInteger(total.reasoningOutputTokens)
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
  }
}

function usageIncrement(total, previousTotal, last) {
  if (!total) return null
  if (!previousTotal) return last ?? total
  const keys = usageKeys(total, previousTotal)
  if (keys.some(key => usageValue(total, key) < usageValue(previousTotal, key))) {
    return last ?? total
  }
  return Object.fromEntries(
    keys.map(key => [key, usageValue(total, key) - usageValue(previousTotal, key)])
  )
}

function addUsage(current, increment) {
  const keys = usageKeys(current, increment)
  return Object.fromEntries(
    keys.map(key => [key, usageValue(current, key) + usageValue(increment, key)])
  )
}

function usageKeys(...values) {
  return [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ].filter(key => values.some(value => value && Object.hasOwn(value, key)))
}

function usageValue(usage, key) {
  return usage?.[key] ?? 0
}

function responseUsage(data) {
  const response = recordField(data, 'response')
  const usage = recordField(response, 'usage')
  if (!Object.keys(usage).length) return null
  return tokenUsage({
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    cachedInputTokens:
      recordField(usage, 'input_tokens_details').cached_tokens ??
      recordField(usage, 'inputTokensDetails').cachedTokens,
    reasoningOutputTokens:
      recordField(usage, 'output_tokens_details').reasoning_tokens ??
      recordField(usage, 'outputTokensDetails').reasoningTokens,
  })
}

function projectedBlockKind(block) {
  const processKind = stringField(block, 'process_kind') ?? stringField(block, 'processKind')
  if (processKind === 'assistant_message') return 'text'
  if (processKind === 'reasoning') return 'reasoning'
  return null
}

function responseText(data) {
  const direct = stringField(data, 'value') ?? stringField(data, 'output_text')
  if (direct) return direct
  const output = recordField(data, 'response').output
  if (!Array.isArray(output)) return ''
  return output
    .flatMap(item => {
      const content = isRecord(item) ? item.content : null
      return Array.isArray(content)
        ? content.flatMap(part => {
            const record = isRecord(part) ? part : {}
            return record.type === 'output_text' && typeof record.text === 'string'
              ? [record.text]
              : []
          })
        : []
    })
    .join('')
}

function turnEndReason(event, data) {
  if (event === 'response.completed') return { kind: 'completed' }
  if (event === 'response.incomplete') return { kind: 'interrupted' }
  return {
    kind: 'error',
    error: {
      message:
        stringField(data, 'message') ??
        stringField(recordField(data, 'error'), 'message') ??
        'Executor response failed',
      code: stringField(recordField(data, 'error'), 'code') ?? 'WEGENT_EXECUTOR_ERROR',
    },
  }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function stringField(record, key) {
  const value = record[key]
  return typeof value === 'string' && value ? value : null
}

function recordField(record, key) {
  const value = record[key]
  return isRecord(value) ? value : {}
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
