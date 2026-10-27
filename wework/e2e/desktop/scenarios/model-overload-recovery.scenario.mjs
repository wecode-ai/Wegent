import { readRequestBody } from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { handleEmptyReplyPrediction } from '../modules/response-protocol.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { createCodexProtocolGate } from '../modules/codex-protocol-gate.mjs'

const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPT = 'WEWORK_E2E_MODEL_OVERLOAD_RECOVERY'
const CANCEL_PROMPT = 'WEWORK_E2E_MODEL_OVERLOAD_CANCEL'
const COMPLETION = 'WEWORK_E2E_MODEL_OVERLOAD_RECOVERED'
const TOOL_MARKER = 'WEWORK_E2E_MODEL_OVERLOAD_TOOL_DONE'
const CALL_ID = 'wework-overload-tool'
const TERMINAL_ERROR = 'WEWORK_E2E_TERMINAL_PERMISSION_DENIED'

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function completed(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function overloaded(id) {
  return {
    type: 'response.failed',
    response: {
      id,
      status: 'failed',
      error: {
        code: 'server_is_overloaded',
        message: 'Selected model is at capacity. Please try a different model.',
      },
    },
  }
}

function toolEvents(id, body, workspacePath) {
  const execNamespace = (body.input ?? [])
    .filter(item => item.type === 'additional_tools')
    .flatMap(item => item.tools ?? [])
    .find(tool => tool.type === 'namespace' && tool.tools?.some(child => child.name === 'exec'))
  const command = `echo ${TOOL_MARKER}`
  if (execNamespace) {
    const exec = execNamespace.tools.find(tool => tool.name === 'exec')
    assert.ok(exec.description.includes('exec_command'), 'Code mode did not advertise exec_command')
    return [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: `${id}-call`,
          type: 'custom_tool_call',
          call_id: CALL_ID,
          namespace: execNamespace.name,
          name: 'exec',
          input: `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspacePath, yield_time_ms: 1000 })}))`,
        },
      },
      completed(id),
    ]
  }
  const names = new Set((body.tools ?? []).map(tool => tool.name))
  const name = names.has('exec_command') ? 'exec_command' : 'shell_command'
  assert.ok(names.has(name), 'The real Codex did not advertise its shell tool')
  const argumentsValue =
    name === 'exec_command'
      ? { cmd: command, workdir: workspacePath, yield_time_ms: 1000 }
      : { command, workdir: workspacePath, timeout_ms: 1000 }
  return [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: `${id}-call`,
        type: 'function_call',
        call_id: CALL_ID,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    },
    completed(id),
  ]
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

export function createDesktopScenario({
  resultDir,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
}) {
  let active = false
  let cancelling = false
  let terminal = false
  let terminalRequests = 0
  let releaseOverload
  const overloadReleased = new Promise(resolve => {
    releaseOverload = resolve
  })
  const requests = []
  const cancelRequests = []
  const nativeGate = createCodexProtocolGate({ resultDir, kind: 'overload-terminal' })
  let releaseCompletion
  const completionReleased = new Promise(resolve => {
    releaseCompletion = resolve
  })

  return {
    // Header authentication leaves this custom provider on the native direct path:
    // configured_codex_provider cannot register a local proxy without an env_key.
    modelProviderAuthToml: '',
    modelProviderConfigToml: 'http_headers = { Authorization = "Bearer wework-e2e-test-key" }\n',
    appEnvironment: { WEWORK_E2E_SEED_LOCAL_MODELS: 'false' },
    prepareApp: nativeGate.prepareApp,

    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/responses', '/v1/responses'].includes(url.pathname)) return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (terminal) {
        terminalRequests += 1
        const id = `terminal-error-${Date.now()}`
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(
          sse([
            { type: 'response.created', response: { id } },
            {
              type: 'response.failed',
              response: {
                id,
                status: 'failed',
                error: { code: 'invalid_prompt', message: TERMINAL_ERROR },
              },
            },
          ])
        )
        return true
      }
      const id = `wework-model-overload-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(sse([{ type: 'response.created', response: { id } }]))
      if (cancelling) {
        cancelRequests.push(body)
        response.end(sse([overloaded(id)]))
        return true
      }
      requests.push(body)
      assert.ok(JSON.stringify(body).includes(PROMPT), 'Recovery lost the original task')
      if (requests.length === 1) {
        response.end(sse(toolEvents(id, body, workspacePath)))
        return true
      }
      const toolOutputs = (body.input ?? []).filter(
        item =>
          ['function_call_output', 'custom_tool_call_output'].includes(item.type) &&
          item.call_id === CALL_ID
      )
      assert.equal(toolOutputs.length, 1, 'Recovery lost or duplicated the completed tool output')
      assert.ok(JSON.stringify(toolOutputs[0]).includes(TOOL_MARKER))
      if (requests.length === 2) {
        await overloadReleased
        response.end(sse([overloaded(id)]))
        return true
      }
      assert.equal(requests.length, 3, 'Overload recovery issued an unexpected extra request')
      assert.equal(body.model, requests[0].model, 'Overload recovery switched the model')
      assert.deepEqual(
        body.input,
        requests[1].input,
        'Recovery changed the saved conversation input'
      )
      await completionReleased
      response.end(
        sse([
          {
            type: 'response.output_item.done',
            item: {
              id: `${id}-message`,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: COMPLETION, annotations: [] }],
            },
          },
          completed(id),
        ])
      )
      return true
    },

    async verify(control) {
      active = true
      await createSingleRootLocalProject(control, workspacePath, 'model-overload-recovery')
      await selectE2EModel(control, undefined, 'GPT-5.6 Luna', WORKBENCH)
      await control.command('fill', COMPOSER, { value: PROMPT })
      await control.command('press', COMPOSER, { key: 'Enter' })
      await waitUntil(
        () => requests.length >= 2,
        uiTimeoutMs,
        'The real tool did not finish before the model overload'
      )
      const gates = runtimeTransportGates(control)
      const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      await gates.arm({
        id: 'old-failed-history',
        kind: 'response',
        name: 'runtime.tasks.transcript',
        where: [
          { path: 'params.taskId', equals: address.taskId },
          { path: 'result.turns.*.status', equals: 'failed' },
        ],
      })
      await gates.arm({
        id: 'live-recovery',
        kind: 'event',
        name: 'response.block.created',
        hold: false,
        where: [
          { path: 'payload.taskId', equals: address.taskId },
          { path: 'payload.data.block.tool_name', equals: 'runtime_reconnecting' },
        ],
      })
      await nativeGate.arm()
      releaseOverload()
      const nativeFailure = await nativeGate.wait()
      await gates.wait('old-failed-history', () =>
        control.command('dispatchRuntimeEventLagged', 'body')
      )
      const failedHistory = await gates.read('old-failed-history')
      assert.ok(
        failedHistory.value.result.turns.some(
          turn => turn.id === nativeFailure.turnId && turn.status === 'failed'
        ),
        'The held failed snapshot did not belong to the real native terminal turn'
      )
      await nativeGate.release()
      await gates.wait('live-recovery')
      await gates.release('old-failed-history')
      const ordering = await gates.save(resultDir, 'overload-history-race.json', [
        'old-failed-history',
        'live-recovery',
      ])
      assert.ok(ordering['old-failed-history'].capturedAt < ordering['live-recovery'].deliveredAt)
      assert.ok(ordering['live-recovery'].deliveredAt < ordering['old-failed-history'].deliveredAt)
      await control.command('waitFor', `${WORKBENCH} [data-testid="pause-response-button"]`)
      await waitUntil(
        () => requests.length === 3,
        uiTimeoutMs,
        'The direct-provider overload did not automatically continue the saved conversation'
      )
      const log = await readFile(join(resultDir, 'executor.log'), 'utf8')
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const taskId = snapshot.workbench?.currentRuntimeTask?.taskId
      assert.ok(taskId, 'The overload task has no identity')
      assert.ok(
        log.includes(`task_id=${taskId} route=direct_user_provider`),
        'The overload scenario did not exercise native direct-provider execution'
      )
      assert.equal(snapshot.pane?.status?.isBusy, true, 'Recovery prematurely ended the task')
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${WORKBENCH} [data-testid="assistant-error-retry"]`
          )
        ),
        0,
        'A recoverable overload rendered a terminal failure'
      )
      releaseCompletion()
      await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitUntil(
        async () => {
          const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
          return state.pane?.status?.isBusy === false
        },
        uiTimeoutMs,
        'The recovered task did not finish'
      )
      assert.equal(
        Number(
          await control.command('getElementCount', `${WORKBENCH} [data-testid="message-user"]`)
        ),
        1,
        'Automatic overload recovery added a synthetic user message'
      )
      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${WORKBENCH} [data-testid="assistant-error-card"]`
          )
        ),
        0,
        'Reloading the recovered transcript restored a terminal overload failure'
      )
      assert.equal(
        Number(
          await control.command('getElementCount', `${WORKBENCH} [data-testid="message-user"]`)
        ),
        1,
        'Reloading the recovered transcript duplicated or removed the original task'
      )
      await control.command('click', `${WORKBENCH} [data-testid="processing-summary-toggle"]`)
      await control.command(
        'click',
        `${WORKBENCH} [data-tool-detail-toggle][aria-label="展开工具详情"]`
      )
      await control.command('waitFor', `${WORKBENCH} [data-testid="shell-tool-output"]`, {
        text: TOOL_MARKER,
        timeoutMs: uiTimeoutMs,
      })

      await gates.reset()
      cancelling = false
      terminal = true
      await control.command('waitFor', COMPOSER)
      await control.command('fill', COMPOSER, { value: TERMINAL_ERROR })
      await control.command('press', COMPOSER, { key: 'Enter' })
      await control.command('waitFor', `${WORKBENCH} [data-testid="assistant-error-card"]`, {
        text: TERMINAL_ERROR,
      })
      await waitUntil(
        async () =>
          JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane?.status
            ?.isBusy === false,
        uiTimeoutMs,
        'A real terminal error remained in recovery'
      )
      assert.equal(terminalRequests, 1, 'A real terminal error was retried as recoverable overload')
      assert.equal(
        JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
          .currentRuntimeTask.taskId,
        taskId,
        'Terminal error verification left the recovered conversation'
      )
      terminal = false

      cancelling = true
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control, undefined, 'GPT-5.6 Luna', WORKBENCH)
      await control.command('fill', COMPOSER, { value: CANCEL_PROMPT })
      await control.command('press', COMPOSER, { key: 'Enter' })
      // Model admission includes runtime startup; only then does backoff observation begin.
      await waitUntil(
        () => cancelRequests.length > 0,
        modelResponseTimeoutMs,
        'The cancellation task did not request its model response'
      )
      await waitUntil(
        async () => {
          const currentLog = await readFile(join(resultDir, 'executor.log'), 'utf8')
          return (currentLog.match(/codex overloaded turn recovery/g) ?? []).length === 2
        },
        uiTimeoutMs,
        'The cancellation task did not enter overload backoff'
      )
      await control.command('click', `${WORKBENCH} [data-testid="pause-response-button"]`)
      await waitUntil(
        async () => {
          const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
          return state.pane?.status?.isBusy === false
        },
        uiTimeoutMs,
        'Cancellation did not stop overload backoff'
      )
      await new Promise(resolve => setTimeout(resolve, 5500))
      assert.equal(cancelRequests.length, 1, 'A cancelled overload task sent another model request')
      assert.equal(requests.length, 3, 'The completed tool work was replayed')
      active = false
    },

    diagnostics() {
      return {
        active,
        cancelling,
        terminalRequests,
        requests: requests.length,
        cancelRequests: cancelRequests.length,
      }
    },
  }
}
