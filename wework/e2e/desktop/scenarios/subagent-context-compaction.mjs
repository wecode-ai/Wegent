import assert from 'node:assert/strict'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  handleEmptyReplyPrediction,
  latestModelInputText,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectShellTool,
  selectTool,
} from '../modules/response-protocol.mjs'
import { withTimeout } from '../modules/shared.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_SELECTOR,
  openNewChatWithE2EModel,
  SUBAGENT_CHILD_STARTUP_TIMEOUT_MS,
} from '../modules/streaming-text-fixture.mjs'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const PROMPT = 'WEWORK_E2E_COMPACT_WHILE_SUBAGENT_RUNS'
const DRAFT = 'Keep this follow-up available during compaction.'
const SPAWN = 'compaction-spawn-child'
const CHILD = 'compaction_child'
const COMPACTION = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="context-compaction-indicator"]`
const PAUSE = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
const SEND = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
const CHILD_STATUS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="subagent-activity-status"]`

function finish(response, id, toolCalls = [], inputTokens = 0) {
  const completed = responseCompleted(id)
  completed.response.usage.input_tokens = inputTokens
  completed.response.usage.total_tokens = inputTokens
  response.end(createSse([...toolCalls, completed]))
}

export function createSubagentCompactionVerification({
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workspacePath,
}) {
  const childStarted = Promise.withResolvers()
  const compactionStarted = Promise.withResolvers()
  let active = false
  let child
  let compaction
  let usedBudget = false

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }

      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const kind = codexRequestKind(body)
      const id = `subagent-context-compaction-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(createSse([responseCreated(id)]))

      if (kind === 'prewarm') {
        finish(response, id)
      } else if (isCollaborationSubagentRequest(request.headers)) {
        child = { response, id }
        childStarted.resolve()
      } else if (kind === 'compaction') {
        assert.ok(usedBudget, 'The parent must cross the context budget after spawning its child')
        compaction = response
        compactionStarted.resolve()
      } else if (requestContainsToolOutput(body, SPAWN)) {
        await withTimeout(
          childStarted.promise,
          SUBAGENT_CHILD_STARTUP_TIMEOUT_MS,
          'The native subagent did not start its model request before the parent crossed the context budget'
        )
        // A real tool follow-up keeps the parent turn active past the context limit.
        const tool = selectShellTool(body, workspacePath)
        usedBudget = true
        finish(response, id, selectedToolCall('compaction-trigger-tool', tool), 260_000)
      } else if (latestModelInputText(body).includes(PROMPT)) {
        const tool = selectTool(body, 'spawn_agent', {
          task_name: CHILD,
          message: 'Remain working until the parent finishes this verification.',
          agent_type: 'explorer',
        })
        finish(response, id, selectedToolCall(SPAWN, tool))
      } else {
        assert.fail(`Unexpected subagent compaction model request: ${kind}`)
      }
      return true
    },

    async verify(control) {
      await openNewChatWithE2EModel(control, uiTimeoutMs)
      active = true
      try {
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('clickWhenEnabled', SEND)
        await withTimeout(
          childStarted.promise,
          SUBAGENT_CHILD_STARTUP_TIMEOUT_MS,
          'The native subagent did not start its held model request'
        )
        await withTimeout(
          compactionStarted.promise,
          modelResponseTimeoutMs,
          'The parent did not start an automatic compaction model request with a held subagent'
        )
        await control.command('waitFor', COMPACTION, { text: '正在自动压缩上下文' })
        await control.command('waitFor', CHILD_STATUS, { text: '工作中' })
        const running = await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.pane?.status?.isBusy === true &&
            snapshot.pane.subagentStatuses[0]?.status === 'running',
          'The main turn and its subagent must both be running while the compaction is held'
        )
        const { taskId } = running.pane.currentRuntimeTask
        await control.command('waitFor', `${PAUSE}:enabled`)
        assert.equal(Number(await control.command('getElementCount', SEND)), 0)

        await control.command('fill', COMPOSER_SELECTOR, { value: DRAFT })
        await control.command('waitFor', `${SEND}:enabled`)
        await control.command('clickWhenEnabled', PAUSE)
        await control.command('waitFor', COMPACTION, { text: '上下文压缩未完成' })
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.pane?.currentRuntimeTask?.taskId === taskId &&
            snapshot.pane?.status?.isBusy === false,
          'The paused turn must return to idle while the compaction response is still held'
        )
      } finally {
        compaction?.destroy()
        if (child?.response.writable && !child.response.destroyed) {
          finish(child.response, child.id, [assistantMessage('Subagent verification complete.')])
        }
        active = false
      }
    },
  }
}
