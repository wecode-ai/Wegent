import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { mcpElicitationConfigToml } from '../modules/desktop-build-flows.mjs'
import {
  currentTurnHasToolOutput,
  currentTurnHasToolSearchResult,
} from '../modules/runtime-input-answer-model.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  namespacedFunctionCall,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectMcpTool,
  selectToolSearch,
  toolSearchResponseEvents,
} from '../modules/response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  selectE2EModel,
} from '../modules/shared.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const PROMPT = 'WEWORK_E2E_INPUT_ANSWER_PERSISTENCE: confirm the inner-site access audience.'
const COMPLETION = 'WEWORK_E2E_INPUT_ANSWER_PERSISTENCE_COMPLETE'
const TOOL_NAMESPACE = 'wegent_sites_interactions'
const TOOL_NAME = 'confirm_inner_site_access'
const SEARCH_CALL_ID = 'wework-e2e-input-answer-elicitation-search'
const TOOL_CALL_ID = 'wework-e2e-input-answer-elicitation-call'
const ANSWER_OPTION = '[data-testid="request-user-input-option-audience-1"]'
const ANSWER_TEXT = '仅自己'
const SIDE_CHAT = '[data-testid="right-workspace-chat-panel"]'
const SIDE_COMPOSER = `${SIDE_CHAT} [data-testid="chat-message-input"]`
const WORKBENCH = ACTIVE_WORKBENCH_SELECTOR

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function lastUserMessageBody(body) {
  const input = Array.isArray(body.input) ? body.input : []
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === 'user') return JSON.stringify(input[index])
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.length > 0 ? JSON.stringify(messages.at(-1)) : ''
}

function hasAcceptedQuestionAnswer(messages) {
  return messages.some(message =>
    (message.blocks ?? []).some(block => {
      const payload = block?.renderPayload
      const response =
        payload?.response ??
        payload?.requestUserInputResponse ??
        payload?.request_user_input_response
      const audienceAnswers = response?.answers?.audience?.answers
      return (
        payload?.kind === 'request_user_input' &&
        Array.isArray(payload.questions) &&
        payload.questions.length > 0 &&
        Array.isArray(audienceAnswers) &&
        audienceAnswers.includes('owner')
      )
    })
  )
}

async function waitForCount(control, selector, expected, message, timeoutMs) {
  const startedAt = Date.now()
  let latest = null
  while (Date.now() - startedAt < timeoutMs) {
    latest = Number(await control.command('getElementCount', selector, { visible: true }))
    if (latest === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: observed=${latest}`)
}

async function waitForConversationMessages(control, address, expectedLength, message, timeoutMs) {
  const startedAt = Date.now()
  let latest = []
  while (Date.now() - startedAt < timeoutMs) {
    latest = JSON.parse(
      await control.command('getRuntimeConversationMessages', 'body', {
        value: JSON.stringify(address),
      })
    )
    if (latest.length === expectedLength) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: observed=${latest.length}`)
}

async function waitForRequestHold(control) {
  const held = JSON.parse(await control.command('awaitLocalExecutorRequestHold', 'body'))
  assert.ok(held?.heldCount > 0, `The request hold was never entered: ${JSON.stringify(held)}`)
  return held
}

async function releaseRequestHold(control, timeoutMs) {
  assert.equal(
    await control.command('releaseLocalExecutorRequestHold', 'body'),
    'true',
    'The work-list refresh gate was not held'
  )
  const startedAt = Date.now()
  let latest = null
  while (Date.now() - startedAt < timeoutMs) {
    latest = JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body'))
    if (latest?.released && latest.completedCount === latest.heldCount) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`The held executor request never completed: ${JSON.stringify(latest)}`)
}

async function recordElicitationFailure(control, scope, resultDir, transportCaptureId) {
  try {
    const transport = JSON.parse(
      await control.command('readRuntimeTransportGate', 'body', { value: transportCaptureId })
    )
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const task = snapshot.pane?.currentRuntimeTask ?? snapshot.workbench?.currentRuntimeTask
    const address = task && { deviceId: task.deviceId, taskId: task.taskId }
    const native = task?.taskId
      ? JSON.parse(
          await control.command('getLocalRuntimeTranscript', 'body', {
            value: JSON.stringify({ taskId: task.taskId, limit: 100 }),
          })
        )
      : null
    const messages = address
      ? JSON.parse(
          await control.command('getRuntimeConversationMessages', 'body', {
            value: JSON.stringify(address),
          })
        )
      : []
    await writeFile(
      join(resultDir, 'runtime-input-answer-native-failure.json'),
      JSON.stringify(
        { scope, address, transport, native, messages, transitions: snapshot.paneTransitions },
        null,
        2
      )
    )
  } catch (error) {
    console.error('[desktop-e2e] Elicitation failure diagnostics unavailable:', String(error))
  }
}

async function openElicitation(control, scope, composer, timeoutMs, resultDir) {
  // Observe the original form event without holding or changing its delivery.
  const transportCaptureId = `elicitation-form-${Date.now()}`
  await control.command('armRuntimeTransportGate', 'body', {
    value: JSON.stringify({
      id: transportCaptureId,
      kind: 'event',
      name: 'response.block.created',
      hold: false,
      where: [{ path: '**.interactionKind', equals: 'mcp_form' }],
    }),
  })
  await control.command('fill', composer, { value: PROMPT })
  await control.command('press', composer, { key: 'Enter' })
  const deadline = Date.now() + Math.max(timeoutMs, 90_000)
  while (Date.now() < deadline) {
    const urlCard = Number(
      await control.command(
        'getElementCount',
        `${scope} [data-testid="mcp-url-authorization-card"]`,
        { visible: true }
      )
    )
    if (urlCard > 0) {
      await control.command('click', `${scope} [data-testid="mcp-url-authorization-cancel"]`)
      await waitForCount(
        control,
        `${scope} [data-testid="mcp-url-authorization-card"]`,
        0,
        'The URL authorization card did not close',
        10_000
      )
      continue
    }
    const formCard = Number(
      await control.command(
        'getElementCount',
        `${scope} [data-testid="request-user-input-questions"]`,
        { visible: true }
      )
    )
    if (formCard > 0) {
      await control.command('waitFor', `${scope} [data-testid="request-user-input-questions"]`, {
        text: '访问范围',
        visible: true,
        timeoutMs: 10_000,
      })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await recordElicitationFailure(control, scope, resultDir, transportCaptureId)
  assert.fail(`Timed out waiting for the elicitation form in ${scope}`)
}

async function assertAnswerSummary(control, scope) {
  const summary = `${scope} [data-testid="request-user-input-summary"]`
  await control.command('waitFor', `${scope} [data-testid="final-processing-toggle"]`, {
    visible: true,
    timeoutMs: 10_000,
  })
  const visible = Number(await control.command('getElementCount', summary, { visible: true }))
  if (visible === 0) {
    await control.command('click', `${scope} [data-testid="final-processing-toggle"]`)
  }
  await control.command('waitFor', summary, {
    text: ANSWER_TEXT,
    visible: true,
    timeoutMs: 10_000,
  })
}

async function assertAcceptedAnswerCached(control, scope) {
  await control.command('waitFor', `${scope} [data-testid="request-user-input-summary"]`, {
    text: ANSWER_TEXT,
    visible: true,
    timeoutMs: 10_000,
  })
  await waitForCount(
    control,
    `${scope} [data-testid="request-user-input-questions"]`,
    0,
    'The accepted answer left its request form pending',
    10_000
  )
}

async function startNewChat(control, composer, timeoutMs) {
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', `${WORKBENCH} [data-testid="desktop-empty-composer-frame"]`, {
    visible: true,
    timeoutMs,
  })
  await control.command('waitFor', composer, { visible: true, timeoutMs })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, WORKBENCH)
}

export function createDesktopScenario({ resultDir, uiTimeoutMs, modelResponseTimeoutMs }) {
  const evidencePath = join(resultDir, 'runtime-input-answer-evidence.jsonl')
  const pendingGates = new Set()
  let activeContinuationGate = null
  let modelRequestCount = 0

  function nextContinuationGate() {
    const gate = deferred()
    pendingGates.add(gate)
    activeContinuationGate = gate
    return gate
  }

  async function handleHttp(request, response, url) {
    if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
      return false
    }
    // Native approval inspection may have consumed the stream; reuse its cache.
    const body = await readRequestBody(request)
    if (!lastUserMessageBody(body).includes(PROMPT)) {
      if (handleEmptyReplyPrediction(body, response)) return true
      return false
    }
    modelRequestCount += 1
    const responseId = `wework-input-answer-${modelRequestCount}-${Date.now()}`
    if (currentTurnHasToolOutput(body, TOOL_CALL_ID)) {
      assert.ok(
        JSON.stringify(body).includes('E2E_MCP_ELICITATION_ACCEPTED:owner'),
        'The real MCP server did not return the accepted audience to the model'
      )
      const gate = activeContinuationGate
      assert.ok(gate, 'The terminal continuation arrived without a release gate')
      await gate.promise
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(COMPLETION),
          responseCompleted(responseId),
        ])
      )
      return true
    }
    let events
    const namespaceAdvertised = (Array.isArray(body.tools) ? body.tools : []).some(
      tool => tool?.type === 'namespace' && tool.name === TOOL_NAMESPACE
    )
    if (namespaceAdvertised || currentTurnHasToolSearchResult(body, TOOL_NAMESPACE)) {
      const tool = selectMcpTool(body, TOOL_NAMESPACE, TOOL_NAME, {})
      events = namespacedFunctionCall(TOOL_CALL_ID, tool.namespace, tool.name, tool.arguments)
    } else {
      events = toolSearchResponseEvents(SEARCH_CALL_ID, selectToolSearch(body, TOOL_NAME))
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
    return true
  }

  return {
    codexConfigToml: mcpElicitationConfigToml(evidencePath),
    handleHttp,
    cleanup() {
      for (const gate of pendingGates) gate.resolve()
      pendingGates.clear()
    },
    async verify(control) {
      const taskTimeoutMs = Math.max(uiTimeoutMs, modelResponseTimeoutMs, 30_000)
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: taskTimeoutMs,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, WORKBENCH)

      const mainGate = nextContinuationGate()
      await openElicitation(control, WORKBENCH, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs, resultDir)
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId,
        'The main elicitation was not attached to a runtime task',
        taskTimeoutMs
      )
      await control.command('holdLocalExecutorRequests', 'body', {
        value: JSON.stringify({ method: 'runtime.tasks.list' }),
      })
      await control.command('click', `${WORKBENCH} ${ANSWER_OPTION}`)
      await waitForRequestHold(control)
      await assertAcceptedAnswerCached(control, WORKBENCH)
      mainGate.resolve()
      await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
        text: COMPLETION,
        visible: true,
        timeoutMs: taskTimeoutMs,
      })
      await assertAnswerSummary(control, WORKBENCH)
      assert.equal(
        JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body'))?.released,
        false,
        'The terminal history was asserted after the work-list refresh completed'
      )
      await releaseRequestHold(control, taskTimeoutMs)
      await control.command('waitFor', `${WORKBENCH} [data-testid="request-user-input-summary"]`, {
        text: ANSWER_TEXT,
        visible: true,
        timeoutMs: taskTimeoutMs,
      })

      const sideGate = nextContinuationGate()
      const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
      await control.command('nativePress', ACTIVE_COMPOSER_SELECTOR, {
        key: `${primary}+Alt+S`,
      })
      await control.command('waitFor', SIDE_CHAT, { visible: true, timeoutMs: taskTimeoutMs })
      await control.command('waitFor', SIDE_COMPOSER, { visible: true, timeoutMs: taskTimeoutMs })
      await openElicitation(control, SIDE_CHAT, SIDE_COMPOSER, taskTimeoutMs, resultDir)
      await control.command('holdLocalExecutorRequests', 'body', {
        value: JSON.stringify({ method: 'runtime.tasks.list' }),
      })
      await control.command('click', `${SIDE_CHAT} ${ANSWER_OPTION}`)
      await waitForRequestHold(control)
      await assertAcceptedAnswerCached(control, SIDE_CHAT)
      sideGate.resolve()
      await control.command('waitFor', `${SIDE_CHAT} [data-testid="message-assistant"]`, {
        text: COMPLETION,
        visible: true,
        timeoutMs: taskTimeoutMs,
      })
      await assertAnswerSummary(control, SIDE_CHAT)
      assert.equal(
        JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body'))?.released,
        false,
        'The temporary-chat terminal history settled after its work-list refresh completed'
      )
      await releaseRequestHold(control, taskTimeoutMs)
      await control.command('waitFor', `${SIDE_CHAT} [data-testid="request-user-input-summary"]`, {
        text: ANSWER_TEXT,
        visible: true,
        timeoutMs: taskTimeoutMs,
      })

      await startNewChat(control, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs)
      const failureGate = nextContinuationGate()
      await openElicitation(control, WORKBENCH, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs, resultDir)
      const failureTask = await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId,
        'The transport-failure elicitation was not attached to a runtime task',
        taskTimeoutMs
      )
      const failureAddress = failureTask.workbench.currentRuntimeTask
      await control.command('failNextLocalExecutorRequest', 'body', {
        value: JSON.stringify({
          method: 'runtime.tasks.send',
          message: 'Desktop E2E intentional runtime transport failure',
        }),
      })
      await control.command('click', `${WORKBENCH} ${ANSWER_OPTION}`)
      await waitForWorkbenchDebugState(
        control,
        snapshot => String(snapshot.workbench?.error ?? '').includes('transport failure'),
        'The rejected transport did not surface an error',
        taskTimeoutMs
      )
      assert.equal(
        hasAcceptedQuestionAnswer(
          JSON.parse(
            await control.command('getRuntimeConversationMessages', 'body', {
              value: JSON.stringify(failureAddress),
            })
          )
        ),
        false,
        'A failed answer transport was recorded as accepted'
      )
      await waitForCount(
        control,
        `${WORKBENCH} [data-testid="request-user-input-questions"]`,
        1,
        'A failed answer transport removed its pending form',
        taskTimeoutMs
      )
      await control.command(
        'waitFor',
        `${WORKBENCH} [data-testid="request-user-input-questions"]`,
        {
          text: '访问范围',
          visible: true,
          timeoutMs: taskTimeoutMs,
        }
      )
      await control.command('click', `${WORKBENCH} ${ANSWER_OPTION}`)
      failureGate.resolve()
      await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
        text: COMPLETION,
        visible: true,
        timeoutMs: taskTimeoutMs,
      })
      await assertAnswerSummary(control, WORKBENCH)

      await startNewChat(control, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs)
      const rejectionGate = deferred()
      activeContinuationGate = rejectionGate
      await openElicitation(control, WORKBENCH, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs, resultDir)
      const rejectionTask = await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId,
        'The rejection elicitation was not attached to a runtime task',
        taskTimeoutMs
      )
      const rejectionAddress = rejectionTask.workbench.currentRuntimeTask
      await control.command('holdLocalExecutorRequests', 'body', {
        value: JSON.stringify({
          method: 'runtime.tasks.send',
          phase: 'before-dispatch',
        }),
      })
      await control.command('click', `${WORKBENCH} ${ANSWER_OPTION}`)
      await waitForRequestHold(control)
      const cancelled = JSON.parse(
        await control.command('cancelRuntimeTaskDirectly', 'body', {
          value: JSON.stringify(rejectionAddress),
        })
      )
      assert.equal(cancelled.accepted, true, 'The runtime task did not accept cancellation')
      rejectionGate.resolve()
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.pane?.status?.isBusy === false,
        'The runtime turn did not finish before the stale answer was dispatched',
        taskTimeoutMs
      )
      await releaseRequestHold(control, taskTimeoutMs)
      await waitForWorkbenchDebugState(
        control,
        snapshot =>
          /(not pending|response channel is closed)/.test(String(snapshot.workbench?.error ?? '')),
        'The executor rejection did not surface for the stale answer',
        taskTimeoutMs
      )
      assert.equal(
        hasAcceptedQuestionAnswer(
          JSON.parse(
            await control.command('getRuntimeConversationMessages', 'body', {
              value: JSON.stringify(rejectionAddress),
            })
          )
        ),
        false,
        'A rejected input answer was recorded as accepted'
      )

      await startNewChat(control, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs)
      const archiveGate = nextContinuationGate()
      await openElicitation(control, WORKBENCH, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs, resultDir)
      const archiveTask = await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId,
        'The archive elicitation was not attached to a runtime task',
        taskTimeoutMs
      )
      const archiveAddress = archiveTask.workbench.currentRuntimeTask
      await control.command('holdLocalExecutorRequests', 'body', {
        value: JSON.stringify({
          method: 'runtime.tasks.send',
          phase: 'after-response',
        }),
      })
      await control.command('click', `${WORKBENCH} ${ANSWER_OPTION}`)
      await waitForRequestHold(control)
      const archiveRow = `[data-testid="runtime-local-task-row-${archiveAddress.taskId}"]`
      const archiveButton = `[data-testid="runtime-local-task-archive-${archiveAddress.taskId}"]`
      await control.command('waitFor', archiveRow, { visible: true, timeoutMs: taskTimeoutMs })
      await control.command('hover', archiveRow)
      await control.command('waitFor', archiveButton, { visible: true, timeoutMs: taskTimeoutMs })
      await control.command('click', archiveButton)
      await waitForCount(
        control,
        archiveRow,
        0,
        'The task was not archived while the input answer acceptance was pending',
        taskTimeoutMs
      )
      await waitForConversationMessages(
        control,
        archiveAddress,
        0,
        'The archived conversation cache was not cleared',
        taskTimeoutMs
      )
      await startNewChat(control, ACTIVE_COMPOSER_SELECTOR, taskTimeoutMs)
      // Archiving cancels the live turn. Release the model and the held answer
      // only afterward so late completions cannot restore the conversation.
      archiveGate.resolve()
      await releaseRequestHold(control, taskTimeoutMs)
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.deepEqual(
        JSON.parse(
          await control.command('getRuntimeConversationMessages', 'body', {
            value: JSON.stringify(archiveAddress),
          })
        ),
        [],
        'An accepted input answer was restored into its archived conversation'
      )
      await waitForCount(
        control,
        archiveRow,
        0,
        'An archived conversation was restored by its late input answer',
        taskTimeoutMs
      )
    },
  }
}
