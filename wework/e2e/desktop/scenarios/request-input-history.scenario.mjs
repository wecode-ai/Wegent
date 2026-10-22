import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExecutorNetworkOrder } from '../modules/executor-network-order.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { mcpElicitationConfigToml } from '../modules/desktop-build-flows.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  MCP_ELICITATION_PROMPT,
  MCP_ELICITATION_COMPLETION_TEXT,
  MCP_ELICITATION_NAMESPACE,
  MCP_ELICITATION_TOOL_NAME,
  MCP_ELICITATION_CALL_ID,
  MCP_ELICITATION_SEARCH_ID,
  createSingleRootLocalProject,
  reservePort,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
  namespacedFunctionCall,
  selectMcpTool,
  selectToolSearch,
  toolSearchResponseEvents,
  requestContainsToolOutput,
} from '../modules/response-protocol.mjs'

const SOURCE = 'REQUEST_INPUT_HISTORY_SOURCE'
const SWITCH = 'REQUEST_INPUT_HISTORY_OTHER_TASK'
const SIDE = '[data-testid="right-workspace-chat-panel"]'
const id = value => `[data-testid="${value}"]`

// Real Electron, Codex, MCP server, Executor and history; only the model is mocked.
// CDP delays or rejects the real answer transport without fabricating its result.
export function createDesktopScenario({ checkpoint, workspacePath, resultDir, uiTimeoutMs }) {
  const temporary = checkpoint.includes('temporary')
  const historyBeforeAck = checkpoint.includes('before')
  const evidencePath = join(resultDir, 'request-input-history-mcp.jsonl')
  const electronLaunchArguments = []
  let port
  let order
  let active = false
  let questionRequests = 0
  const pane = temporary ? SIDE : ACTIVE_WORKBENCH_SELECTOR
  const composer = temporary ? `${SIDE} ${id('chat-message-input')}` : ACTIVE_COMPOSER_SELECTOR
  const evidence = []
  const mainPrompt = async (control, prompt) => {
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: prompt })
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
  }
  async function assertSummary(control) {
    await control.command('waitFor', `${pane} ${id('final-processing-toggle')}`)
    await control.command('click', `${pane} ${id('final-processing-toggle')}`)
    await control.command('waitFor', `${pane} ${id('request-user-input-summary')}`, {
      text: '仅自己',
    })
    assert.equal(
      Number(await control.command('getElementCount', `${pane} ${id('request-user-input-card')}`)),
      0,
      'An accepted answer reopened as a pending question'
    )
  }
  async function nativeHistory(control) {
    assert.ok(order.answerAddress, 'The answer did not identify its actual runtime task')
    const deadline = Date.now() + uiTimeoutMs
    let terminal = false
    while (Date.now() < deadline) {
      const result = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        {
          address: order.answerAddress,
          refresh: true,
        },
        uiTimeoutMs
      )
      terminal = result.turns.some(turn => ['completed', 'done'].includes(turn.status))
      if (terminal) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(terminal, true, 'The real terminal transcript was not available')
    evidence.push({ event: 'terminal-history-read', acknowledgmentHeld: Boolean(order.heldAnswer) })
  }

  return {
    codexConfigToml: mcpElicitationConfigToml(evidencePath),
    electronLaunchArguments,
    async prepareApp() {
      port = await reservePort()
      electronLaunchArguments.push(`--remote-debugging-port=${port}`)
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      const latest = latestModelInputText(body)
      const responseId = `request-input-history-${Date.now()}`
      let events
      if (latest.includes(SOURCE) || latest.includes(SWITCH)) {
        const marker = latest.includes(SWITCH) ? SWITCH : SOURCE
        events = [assistantMessage(`${marker}_COMPLETE`)]
      } else {
        questionRequests += 1
        if (questionRequests === 1) {
          assert.ok(JSON.stringify(body).includes(MCP_ELICITATION_PROMPT))
          events = toolSearchResponseEvents(
            MCP_ELICITATION_SEARCH_ID,
            selectToolSearch(body, MCP_ELICITATION_TOOL_NAME)
          )
        } else if (questionRequests === 2) {
          const tool = selectMcpTool(body, MCP_ELICITATION_NAMESPACE, MCP_ELICITATION_TOOL_NAME, {})
          events = namespacedFunctionCall(
            MCP_ELICITATION_CALL_ID,
            tool.namespace,
            tool.name,
            tool.arguments
          )
        } else {
          assert.equal(questionRequests, 3, 'Unexpected question model request')
          assert.ok(requestContainsToolOutput(body, MCP_ELICITATION_CALL_ID))
          assert.ok(JSON.stringify(body).includes('E2E_MCP_ELICITATION_ACCEPTED:owner'))
          events = [assistantMessage(MCP_ELICITATION_COMPLETION_TEXT)]
        }
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        createSse([responseCreated(responseId), ...events, responseCompleted(responseId)])
      )
      return true
    },
    async verify(control) {
      active = true
      await createSingleRootLocalProject(control, workspacePath, checkpoint)
      await selectE2EModel(control)
      if (temporary) {
        await mainPrompt(control, SOURCE)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} ${id('message-assistant')}`,
          { text: `${SOURCE}_COMPLETE` }
        )
        const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
        await control.command('nativePress', ACTIVE_COMPOSER_SELECTOR, { key: `${primary}+Alt+S` })
        await control.command('waitFor', composer)
      }
      const origin = await control.command('getLocationOrigin', 'body')
      order = await ExecutorNetworkOrder.connect(port, origin)
      await control.command('fill', composer, { value: MCP_ELICITATION_PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', `${pane} ${id('mcp-url-authorization-cancel')}`)
      await control.command('click', `${pane} ${id('mcp-url-authorization-cancel')}`)
      await control.command('waitFor', `${pane} ${id('request-user-input-card')}`, {
        text: '访问范围',
      })
      const sourceTask = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask

      if (!historyBeforeAck) {
        order.mode = 'reject-answer'
        await control.command('click', `${pane} ${id('request-user-input-option-audience-1')}`)
        await order.waitFor(
          () => order.records.some(record => record.rejected),
          'Failed send did not reach the real transport'
        )
        await control.command('waitFor', `${pane} ${id('request-user-input-option-audience-1')}`, {
          enabled: true,
        })
        assert.equal(
          Number(
            await control.command('getElementCount', `${pane} ${id('request-user-input-summary')}`)
          ),
          0
        )
        const records = (await readFile(evidencePath, 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
        assert.equal(
          records.some(record => record.event === 'elicitation_result'),
          false,
          'A rejected answer was committed to the real MCP server'
        )
        evidence.push({ event: 'failed-send-kept-pending' })
      }
      order.holdTerminalHistory = !historyBeforeAck
      order.mode = historyBeforeAck ? 'hold-answer' : null
      await control.command('click', `${pane} ${id('request-user-input-option-audience-1')}`)
      await control.command('waitFor', `${pane} ${id('message-assistant')}`, {
        text: MCP_ELICITATION_COMPLETION_TEXT,
        timeoutMs: 30_000,
      })
      if (historyBeforeAck) {
        await order.waitFor(() => Boolean(order.heldAnswer), 'The real acknowledgment was not held')
        await order.waitFor(
          () => order.records.some(record => record.terminalHistory && !record.heldHistory),
          'The renderer did not receive real terminal history before acknowledgment'
        )
        await nativeHistory(control)
        await control.command('click', id('new-chat-button'))
        await mainPrompt(control, SWITCH)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} ${id('message-assistant')}`,
          { text: `${SWITCH}_COMPLETE` }
        )
        if (!temporary) {
          const switchedTask = JSON.parse(
            await control.command('getWorkbenchDebugSnapshot', 'body')
          ).workbench.currentRuntimeTask
          const historyStart = order.records.length
          await control.command('click', id(`runtime-local-task-row-${sourceTask.taskId}`))
          await order.waitFor(
            () =>
              order.records
                .slice(historyStart)
                .some(
                  record =>
                    record.method === 'runtime.tasks.transcript' &&
                    record.responseStage &&
                    record.answerTask
                ),
            'The selected conversation did not load real terminal history before acknowledgment'
          )
          await control.command('waitFor', `${pane} ${id('message-assistant')}`, {
            text: MCP_ELICITATION_COMPLETION_TEXT,
          })
          await control.command('click', id(`runtime-local-task-row-${switchedTask.taskId}`))
          await control.command('waitFor', `${pane} ${id('message-assistant')}`, {
            text: `${SWITCH}_COMPLETE`,
          })
        }
        await order.releaseAnswer()
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} ${id('message-assistant')}`,
          { text: `${SWITCH}_COMPLETE`, stableMs: 500 }
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${ACTIVE_WORKBENCH_SELECTOR} ${id('request-user-input-summary')}`
            )
          ),
          0,
          'Resolving the previous answer contaminated the selected task'
        )
        await control.command('click', id(`runtime-local-task-row-${sourceTask.taskId}`))
        await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} ${id('message-user')}`, {
          text: temporary ? SOURCE : MCP_ELICITATION_PROMPT,
        })
      } else {
        await order.waitFor(
          () => order.records.some(record => record.answer && record.responseStage),
          'The accepted answer acknowledgment did not return'
        )
        await control.command('waitFor', `${pane} ${id('request-user-input-card')}`, {
          visible: false,
        })
        await order.waitFor(
          () => order.heldHistory.length > 0,
          'The real renderer terminal history was not held until acknowledgment'
        )
        await order.releaseHistory()
        await nativeHistory(control)
        if (!temporary) {
          await control.command('click', id('new-chat-button'))
          const historyStart = order.records.length
          await control.command('click', id(`runtime-local-task-row-${sourceTask.taskId}`))
          await order.waitFor(
            () =>
              order.records
                .slice(historyStart)
                .some(
                  record =>
                    record.method === 'runtime.tasks.transcript' &&
                    record.responseStage &&
                    record.answerTask
                ),
            'The selected conversation did not load real terminal history after acknowledgment'
          )
          await control.command('waitFor', `${pane} ${id('message-assistant')}`, {
            text: MCP_ELICITATION_COMPLETION_TEXT,
          })
        }
      }
      await assertSummary(control)
      const cachedMessages = JSON.parse(
        await control.command('getRuntimeConversationMessages', 'body', {
          value: JSON.stringify(order.answerAddress),
        })
      )
      const acceptedAnswers = cachedMessages
        .flatMap(message => message.blocks ?? [])
        .filter(block => block.renderPayload?.response?.answers?.audience)
      assert.equal(
        acceptedAnswers.length,
        1,
        'The captured answer was lost or duplicated in conversation history'
      )
      const records = (await readFile(evidencePath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      assert.deepEqual(
        records
          .filter(record => record.event === 'elicitation_result')
          .map(record => record.result),
        [{ action: 'accept', content: { audience: 'owner' } }]
      )
      await writeFile(
        join(resultDir, 'request-input-history-order.json'),
        JSON.stringify({ checkpoint, evidence, transport: order.records }, null, 2)
      )
    },
    async cleanup() {
      await order?.close()
    },
  }
}
