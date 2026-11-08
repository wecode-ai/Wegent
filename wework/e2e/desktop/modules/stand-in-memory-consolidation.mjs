import assert from 'node:assert/strict'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { until } from './plugin-regression-fixture.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

export const MEMORY_HISTORY_FACT = '我长期使用中文做项目汇报。'
const CONTENT = `MEMORY_LEARNING：${MEMORY_HISTORY_FACT}`
const USER = 9001
const SOURCE = `stand-in-chat-${USER}-primary`

export function assertMemoryReviewToolBoundary(body) {
  const pending = [
    ...(body.tools ?? []),
    ...(body.input ?? [])
      .filter(item => item.type === 'additional_tools')
      .flatMap(item => item.tools ?? []),
  ]
  while (pending.length) {
    const tool = pending.pop()
    pending.push(...(tool.tools ?? []))
    const name = tool.name ?? tool.function?.name ?? tool.type ?? ''
    assert.doesNotMatch(
      name,
      /^(exec_command|write_stdin|apply_patch|shell|shell_command|js_repl|python|spawn_agent|send_message|view_image|web_search|web_search_preview|image_generation)$/,
      'Memory review must not expose native execution tools'
    )
    if (name.startsWith('mcp__')) {
      assert.ok(
        name.startsWith('mcp__wework_stand_in__'),
        `Unexpected memory review MCP tool: ${name}`
      )
    }
  }
}

/** Exercise the native scheduled run and evidence tools, scripting only model decisions. */
export function createMemoryConsolidation({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  autoComplete = false,
}) {
  let active = false
  let call
  let sequence = 0
  let foundSource = false
  let historyComplete = false
  let saved
  let committed
  let releaseFinalResponse
  const emit = body =>
    mcpToolRequestEvents(body, {
      toolName: call.name,
      directToolName: `mcp__wework_stand_in__${call.name}`,
      argumentsValue: call.args,
      searchCallId: `${call.id}-search`,
      toolCallId: call.id,
    }).events
  const next = (body, name, args) => {
    call = { name, args, id: `memory-consolidation-${++sequence}` }
    return emit(body)
  }
  const advance = body => {
    if (!call) return next(body, 'list_memory_sources', {})
    if (!requestContainsToolOutput(body, call.id)) return emit(body)
    const result = JSON.parse(readMcpToolOutput(body, call.id))
    assert.ok(!result.error && !result.isError, JSON.stringify(result))
    switch (call.name) {
      case 'list_memory_sources':
        foundSource ||= result.items.some(item => item.taskId === SOURCE)
        if (result.nextCursor) return next(body, call.name, { cursor: result.nextCursor })
        assert.ok(foundSource, 'The scheduled identity must discover the actual owner conversation')
        return next(body, 'search_review_memories', { query: CONTENT })
      case 'search_review_memories':
        assert.deepEqual(result.items, [], 'The historical fact was not saved in the live chat')
        assert.equal(result.nextCursor, null)
        return next(body, 'next_memory_page', { taskId: SOURCE })
      case 'next_memory_page': {
        historyComplete = result.historyReadComplete
        assert.equal(typeof result.pendingWriteCount, 'number')
        const message = result.page?.messages?.find(
          item => item.role === 'user' && item.content.includes(MEMORY_HISTORY_FACT)
        )
        if (message && !saved)
          return next(body, 'remember_from_conversation', {
            ...result.readArguments,
            taskId: SOURCE,
            messageId: message.id,
            excerpt: MEMORY_HISTORY_FACT,
            content: CONTENT,
          })
        if (!historyComplete) return next(body, 'next_memory_page', { taskId: SOURCE })
        assert.ok(saved, 'The review must read and persist the historical user statement')
        assert.equal(result.readyToComplete, true)
        assert.equal(result.pendingWriteCount, 0)
        return next(body, 'complete_memory_source', { taskId: SOURCE })
      }
      case 'remember_from_conversation':
        assert.equal(result.content, CONTENT)
        assert.equal(result.evidence.taskId, SOURCE)
        assert.equal(result.evidence.excerpt, MEMORY_HISTORY_FACT)
        assert.equal(result.evidence.role, 'user')
        saved = result
        return next(body, historyComplete ? 'complete_memory_source' : 'next_memory_page', {
          taskId: SOURCE,
        })
      case 'complete_memory_source':
        assert.ok(
          result.completedThrough > 0,
          'Only a fully read and saved source advances progress'
        )
        committed = result
        return [assistantMessage('Memory consolidation evidence committed.')]
      default:
        throw new Error(`Unexpected memory tool ${call.name}`)
    }
  }
  return {
    activate() {
      active = true
    },
    get result() {
      return { saved, committed }
    },
    handleModel(body, response) {
      if (
        !active ||
        !JSON.stringify(body.input ?? []).includes('Consolidate useful durable memories')
      )
        return false
      assertMemoryReviewToolBoundary(body)
      const id = `memory-consolidation-response-${Date.now()}`
      const events = advance(body)
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (committed && !autoComplete) {
        response.write(createSse([responseCreated(id)]))
        releaseFinalResponse = () => {
          response.end(createSse([...events, responseCompleted(id)]))
          releaseFinalResponse = undefined
        }
        return true
      }
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const rpc = (method, payload) => requestExecutor(control, method, payload, uiTimeoutMs)
      const settings = await rpc('runtime.stand_in.personal.get', { userId: USER })
      await rpc('runtime.stand_in.personal.save', {
        userId: USER,
        settings: { ...settings, primary: { ...settings.primary, enabled: true } },
      })
      // The production provisioning tick is 30 seconds; this wait observes its actual result.
      const schedule = await until(
        async () =>
          (await rpc('runtime.automations.list', {})).items.find(
            item =>
              item.taskRequest?.standInOwner?.userId === USER &&
              item.taskRequest?.standInCalendar?.template === 'memory_review'
          ),
        Boolean,
        'The native scheduler must provision memory consolidation',
        45000
      )
      assert.deepEqual(schedule.schedule, { type: 'interval', value: 6, unit: 'hours' })
      assert.equal(schedule.conversationMode, 'independent')
      assert.equal(schedule.notificationPolicy, 'attention_only')
      active = true
      try {
        const started = await rpc('runtime.automations.run_now', { automationId: schedule.id })
        assert.ok(started.run?.id, 'Run now must return a real execution receipt')
        // Hold only the simulated model's final response. Open the actual run
        // through its calendar entry before releasing it, without reload/poll repair.
        for (const selector of [
          'personal-stand-in-button',
          'stand-in-settings-open',
          'stand-in-primary-connections-open',
          'stand-in-time-connections',
          `automation-open-${schedule.id}`,
        ]) {
          if (selector === 'stand-in-settings-open') await openStandInSettings(control)
          else await control.command('clickWhenEnabled', `[data-testid="${selector}"]`)
        }
        await control.command(
          'clickWhenEnabled',
          `[data-testid="automation-run-open-${started.run.id}"]`,
          { timeoutMs: modelResponseTimeoutMs }
        )
        await control.command('waitFor', '[data-testid="message-user"]', {
          text: 'Consolidate useful durable memories',
          timeoutMs: modelResponseTimeoutMs,
        })
        await until(
          async () => typeof releaseFinalResponse === 'function',
          Boolean,
          'Evidence must be committed before the held model response is released',
          modelResponseTimeoutMs
        )
        releaseFinalResponse()
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: 'Memory consolidation evidence committed.',
          timeoutMs: modelResponseTimeoutMs,
        })
        const run = await until(
          async () =>
            (
              await rpc('runtime.automation_runs.list', {
                automationId: schedule.id,
              })
            ).items.find(item => item.id === started.run.id),
          item => ['succeeded', 'failed', 'cancelled'].includes(item?.status),
          'The exact memory consolidation run must terminate',
          modelResponseTimeoutMs
        )
        assert.equal(run.status, 'succeeded', JSON.stringify(run))
        assert.notEqual(run.taskId, SOURCE, 'Consolidation uses a separate conversation')
        assert.ok(committed)
        const memories = (await rpc('runtime.stand_in.memory.list', { userId: USER })).items
        assert.deepEqual(
          memories.filter(item => item.content === CONTENT),
          [saved]
        )
      } finally {
        releaseFinalResponse?.()
        active = false
        await rpc('runtime.automations.toggle', { automationId: schedule.id, enabled: false })
      }
    },
  }
}
