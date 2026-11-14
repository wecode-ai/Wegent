import assert from 'node:assert/strict'
import { createDesktopScenario as createIdentities } from './stand-in-identities.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCreated,
  responseCompleted,
  mcpToolRequestEvents,
  requestContainsToolOutput,
  isReplyPredictionRequest,
  codexRequestKind,
} from '../modules/response-protocol.mjs'

const USER = 9001
const QUERY = 'CONTEXT_RECALL_RELEASE'
const FACT = '发布计划已经确认改到周二，证据编号RECALL7319。'

/** Extend the existing identity checkpoint; only model responses are scripted. */
export function createDesktopScenario(options) {
  const original = createIdentities(options)
  let active = false
  let sourceTaskId
  let call
  let recalled = false
  let searched = false
  let sequence = 0
  const emit = body =>
    mcpToolRequestEvents(body, {
      toolName: 'search_context',
      directToolName: 'mcp__wework_stand_in__search_context',
      argumentsValue: call.args,
      searchCallId: `${call.id}-discover`,
      toolCallId: call.id,
    }).events
  return {
    ...original,
    async handleHttp(req, response, url) {
      if (!active) return original.handleHttp(req, response, url)
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (
        isReplyPredictionRequest(body) ||
        ['prewarm', 'compaction'].includes(codexRequestKind(body))
      )
        return false
      const input = JSON.stringify(body.input ?? [])
      let events
      if (input.includes('CONTEXT_SOURCE_CREATE') && !input.includes('CONTEXT_QUERY_RUN')) {
        events = [assistantMessage('材料已记录。')]
      } else if (input.includes('CONTEXT_QUERY_RUN')) {
        if (!call) {
          assert.ok(
            input.includes(FACT),
            'The actual model turn must receive evidence from another conversation'
          )
          assert.ok(
            input.includes(sourceTaskId),
            'Recall must preserve the original conversation reference'
          )
          recalled = true
          call = { id: `context-search-${++sequence}`, args: { query: QUERY } }
          events = emit(body)
        } else if (!requestContainsToolOutput(body, call.id)) {
          events = emit(body)
        } else {
          const page = JSON.parse(readMcpToolOutput(body, call.id))
          assert.ok(!page.error && !page.isError, JSON.stringify(page))
          searched ||= page.items.some(
            item => item.taskId === sourceTaskId && item.excerpt.includes(FACT)
          )
          if (!searched && page.nextCursor) {
            call = {
              id: `context-search-${++sequence}`,
              args: { query: QUERY, cursor: page.nextCursor },
            }
            events = emit(body)
          } else {
            assert.ok(searched, 'The native MCP search must find the original evidence')
            events = [assistantMessage('CONTEXT_RECALL_VERIFIED：发布改到周二。')]
          }
        }
      } else return original.handleHttp(req, response, url)
      const id = `context-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await original.verify(control)
      active = true
      const rpc = (method, payload) =>
        requestExecutor(control, method, payload, options.uiTimeoutMs)
      const primary = (await rpc('runtime.tasks.get', { taskId: `stand-in-chat-${USER}-primary` }))
        .task
      const selection = primary.runtimeHandle.modelSelection
      sourceTaskId = `context-source-${process.pid}`
      const message = `CONTEXT_SOURCE_CREATE ${QUERY} ${FACT}`
      const created = await rpc('runtime.tasks.create', {
        taskId: sourceTaskId,
        title: QUERY,
        message,
        workspacePath: options.workspacePath,
        modelSelection: selection,
        executionRequest: {
          task_id: sourceTaskId,
          subtask_id: sourceTaskId,
          new_session: true,
          bot: [{ shell_type: 'Codex', name: 'Context source' }],
          model_config: {
            model_id: selection.modelName,
            model_provider: selection.options.runnerModelProvider,
          },
          user_id: USER,
          prompt: message,
        },
      })
      assert.equal(created.success, true)
      await until(
        () => rpc('runtime.tasks.get', { taskId: sourceTaskId }),
        value => value.task?.status === 'done',
        'Source conversation must finish',
        options.modelResponseTimeoutMs
      )
      await rpc('runtime.stand_in.conversation', {
        userId: USER,
        message: `CONTEXT_QUERY_RUN ${QUERY} 发布计划`,
        options: {
          modelId: selection.modelName,
          modelType: selection.modelType,
          modelOptions: selection.options,
        },
      })
      await until(
        () => rpc('runtime.tasks.transcript', { taskId: primary.taskId, limit: 20 }),
        value =>
          value.messages?.some(
            item => item.role === 'assistant' && item.content?.includes('CONTEXT_RECALL_VERIFIED')
          ),
        'The assistant must finish with verified cross-conversation evidence',
        options.modelResponseTimeoutMs
      )
      assert.ok(recalled && searched)
    },
    diagnostics() {
      return { ...original.diagnostics(), recalled, searched }
    },
  }
}
