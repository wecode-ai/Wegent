import { createOrdinaryMcpRegression } from './ordinary-mcp-regression.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const prompt = 'WEWORK_E2E_MCP_APP'
const completion = 'MCP_APP_COMPLETE'
const callId = 'mcp-app-open'
const composer =
  '[data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]'

export function createDesktopScenario({
  workspacePath,
  resultDir,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
}) {
  const ordinaryMcp = createOrdinaryMcpRegression({ uiTimeoutMs, modelResponseTimeoutMs })
  let calls = 0
  let activeCase = { callId, tool: 'show_app', prompt, completion }
  return {
    prepareApp: ordinaryMcp.prepareApp,
    codexConfigToml: `\n[mcp_servers.counter]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fileURLToPath(new URL('../../utils/mcp-app-server.mjs', import.meta.url)))}]\n`,
    async handleHttp(request, response, url) {
      if (await ordinaryMcp.handleHttp(request, response, url)) return true
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(activeCase.prompt))
      if (activeCase.tool !== 'show_app') {
        assert.ok(
          JSON.stringify(body).includes('counter-selection'),
          'App context must reach the next model turn'
        )
      }
      calls++
      let events
      if (requestContainsToolOutput(body, activeCase.callId)) {
        events = [assistantMessage(activeCase.completion), responseCompleted('mcp-app', [])]
      } else {
        events = [
          ...mcpToolRequestEvents(body, {
            toolName: activeCase.tool,
            argumentsValue: {},
            directToolName: `mcp__counter__${activeCase.tool}`,
            searchCallId: `${activeCase.callId}-search`,
            toolCallId: activeCase.callId,
          }).events,
          responseCompleted('mcp-app'),
        ]
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated('mcp-app'), ...events]))
      return true
    },
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'mcp-apps')
      await selectE2EModel(control)
      await control.command('fill', composer, { value: prompt })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: completion,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="mcp-app-frame"][data-ready="true"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      assert.ok(address.taskId)
      const origin = await control.command('getLocationOrigin', 'body')
      let frameUrl = await control.command('getAttribute', '[data-testid="mcp-app-frame"]', {
        value: 'src',
      })
      assert.match(
        frameUrl,
        /^codex-sandbox:\/\/[a-f0-9-]+\.web-sandbox\.oaiusercontent\.com\/mcp-app\.html$/
      )
      const frameAction = async (action, selector, value) => {
        const response = await fetch(`${origin}/wework/electron-host/v1/invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            capability: 'e2e.mcpAppFrame',
            params: { url: frameUrl, action, selector, value },
          }),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
        const result = await response.json()
        assert.equal(result.ok, true, JSON.stringify(result.error))
        return result.result
      }
      assert.equal(await frameAction('document-status', 'body'), 200)
      const waitText = async text => {
        const deadline = Date.now() + uiTimeoutMs
        let actual
        do {
          actual = await frameAction('text', '#status')
          if (actual === text) return
          await new Promise(resolve => setTimeout(resolve, 100))
        } while (Date.now() < deadline)
        assert.equal(actual, text)
      }
      const dismissRightPanel = async () => {
        await control.command('hover', '[data-testid^="right-workspace-mcp-app-tab-"][role="tab"]')
        await control.command(
          'click',
          '[data-testid^="right-workspace-mcp-app-tab-"][data-testid$="-close-button"]'
        )
        await control.command(
          'waitFor',
          '[data-testid="mcp-app-slot"] [data-testid="mcp-app"][data-display-mode="inline"]'
        )
      }
      await waitText('Result 0 ui-only-marker')
      assert.equal(await frameAction('attribute', 'body', 'data-csp'), 'blocked')
      await frameAction('fill', '#draft', 'preserved draft')
      await frameAction('click', '#refresh')
      await waitText('Counter 1')
      assert.equal(await frameAction('attribute', 'body', 'data-integrity'), 'verified')
      await frameAction('click', '#download')
      await waitText('Downloads complete')
      assert.equal(await readFile(join(resultDir, 'conversation-export-e2e.zip'), 'utf8'), 'second')
      await frameAction('click', '#context')
      await waitText('Context saved')
      await captureScreenshot(control, 'mcp-apps-inline.png', 'body')
      await frameAction('click', '#expand')
      await control.command(
        'waitFor',
        '[data-testid="mcp-app-workspace-panel"] [data-testid="mcp-app"][data-display-mode="fullscreen"]'
      )
      const [viewport] = JSON.parse(await control.command('getElementMetrics', 'body'))
      const [fullscreen] = JSON.parse(
        await control.command(
          'getElementMetrics',
          '[data-testid="mcp-app"][data-display-mode="fullscreen"]'
        )
      )
      const [panel] = JSON.parse(
        await control.command('getElementMetrics', '[data-testid="mcp-app-workspace-panel"]')
      )
      assert.ok(panel.left > 0, 'The app must share the main window with the conversation')
      assert.equal(fullscreen.left, panel.left)
      assert.equal(fullscreen.top, panel.top)
      assert.equal(fullscreen.width, panel.clientWidth)
      assert.equal(fullscreen.height, panel.clientHeight)
      await control.command('waitFor', composer)
      await captureScreenshot(control, 'mcp-apps-right-panel.png', 'body')

      assert.equal(
        await control.command('getAttribute', '[data-testid="mcp-app-frame"]', { value: 'src' }),
        frameUrl
      )
      await dismissRightPanel()
      assert.equal(await frameAction('value', '#draft'), 'preserved draft')
      await control.command('click', '[data-testid="mcp-app-expand"]')
      await control.command(
        'waitFor',
        '[data-testid="mcp-app-workspace-panel"] [data-testid="mcp-app-frame"]'
      )
      await dismissRightPanel()
      assert.equal(
        await control.command('getAttribute', '[data-testid="mcp-app-frame"]', { value: 'src' }),
        frameUrl
      )
      assert.equal(await frameAction('value', '#draft'), 'preserved draft')
      await captureScreenshot(control, 'mcp-apps-restored-inline.png', 'body')
      await frameAction('click', '#pip')
      await control.command(
        'waitFor',
        '[data-testid="mcp-app-overlays"] [data-testid="mcp-app"][data-display-mode="pip"]'
      )
      const [pip] = JSON.parse(
        await control.command(
          'getElementMetrics',
          '[data-testid="mcp-app"][data-display-mode="pip"]'
        )
      )
      assert.equal(pip.right, viewport.clientWidth - 16)
      assert.equal(pip.bottom, viewport.clientHeight - 16)
      assert.equal(await frameAction('value', '#draft'), 'preserved draft')
      await control.command('click', '[data-testid="mcp-app-expand"]')
      await control.command('waitFor', '[data-testid="mcp-app-workspace-panel"]')
      await dismissRightPanel()
      const list = await requestExecutor(
        control,
        'runtime.mcp_apps.request',
        { address, callId, method: 'tools/list' },
        uiTimeoutMs
      )
      assert.ok(list.tools.some(tool => tool.name === 'read_count'))
      assert.ok(!list.tools.some(tool => tool.name === 'model_only'))
      assert.equal(
        await requestExecutor(
          control,
          'runtime.mcp_apps.request',
          { address, callId: 'foreign' },
          uiTimeoutMs
        ),
        null
      )
      for (const data of [
        { callId: 'foreign', method: 'initialize' },
        { callId, method: 'tools/call', params: { name: 'model_only', arguments: {} } },
      ]) {
        await assert.rejects(
          requestExecutor(control, 'runtime.mcp_apps.request', { address, ...data }, uiTimeoutMs)
        )
      }
      await frameAction('click', '#heartbeat')
      await waitText('Heartbeats 3')
      await control.command('click', '[data-testid="mcp-app-close"]')
      await control.command('waitFor', '[data-testid="mcp-app-frame"]', {
        visible: false,
      })
      assert.equal(await frameAction('document-status', 'body'), 404)
      for (const [tool, expected] of [
        ['show_legacy', 'Legacy 1'],
        ['show_dynamic', 'Result 2 ui-only-marker'],
        ['show_recovery', 'Result 3 ui-only-marker'],
      ]) {
        activeCase = {
          callId: 'mcp-app-' + tool,
          tool,
          prompt: prompt + '_' + tool,
          completion: completion + '_' + tool,
        }
        await control.command('fill', composer, { value: activeCase.prompt })
        await control.command('press', composer, { key: 'Enter' })
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: activeCase.completion,
          timeoutMs: modelResponseTimeoutMs,
        })
        const scope = '[data-mcp-call-id="' + activeCase.callId + '"]'
        if (tool === 'show_recovery') {
          await control.command('waitFor', scope + ' [data-testid="mcp-app-retry"]')
          await control.command('click', scope + ' [data-testid="mcp-app-retry"]')
        }
        await control.command(
          'waitFor',
          scope + ' [data-testid="mcp-app-frame"][data-ready="true"]'
        )
        frameUrl = await control.command('getAttribute', scope + ' [data-testid="mcp-app-frame"]', {
          value: 'src',
        })
        await waitText(expected)
        await frameAction('click', '#refresh')
        await waitText('Counter ' + (tool === 'show_legacy' ? 2 : tool === 'show_dynamic' ? 3 : 4))
        await control.command('click', scope + ' [data-testid="mcp-app-close"]')
        await control.command('waitFor', scope + ' [data-testid="mcp-app-frame"]', {
          visible: false,
        })
        assert.equal(await frameAction('document-status', 'body'), 404)
      }
      const original = '[data-mcp-call-id="' + callId + '"]'
      await control.command('click', original + ' [data-testid="mcp-app-expand"]')
      await control.command(
        'waitFor',
        original + ' [data-testid="mcp-app-frame"][data-ready="true"]'
      )
      frameUrl = await control.command(
        'getAttribute',
        original + ' [data-testid="mcp-app-frame"]',
        { value: 'src' }
      )
      await waitText('Result 0 ui-only-marker')
      await control.command('waitFor', original + '[data-display-mode="inline"]')
      await control.command('click', original + ' [data-testid="mcp-app-close"]')
      await control.command('waitFor', original + ' [data-testid="mcp-app-frame"]', {
        visible: false,
      })
      assert.equal(await frameAction('document-status', 'body'), 404)
      await control.command('click', original + ' [data-testid="mcp-app-expand"]')
      await control.command(
        'waitFor',
        original + ' [data-testid="mcp-app-frame"][data-ready="true"]'
      )
      frameUrl = await control.command(
        'getAttribute',
        original + ' [data-testid="mcp-app-frame"]',
        { value: 'src' }
      )
      await waitText('Result 0 ui-only-marker')
      await frameAction('fill', '#draft', 'restart draft')
      const runtimeBefore = JSON.parse(
        await control.command('getDesktopRuntimeDiagnostics', 'body')
      )
      assert.ok(runtimeBefore.executorPid > 0)
      process.kill(runtimeBefore.executorPid, 'SIGTERM')
      const reconnectDeadline = Date.now() + 30000
      let restarted = false
      do {
        const runtimeAfter = JSON.parse(
          await control.command('getDesktopRuntimeDiagnostics', 'body')
        )
        if (
          runtimeAfter.executorPid > 0 &&
          runtimeAfter.executorPid !== runtimeBefore.executorPid
        ) {
          try {
            await requestExecutor(control, 'executor.health', {}, 1000)
            restarted = true
            break
          } catch (error) {
            assert.match(
              String(error),
              /not ready|not connected|transport|unavailable|disconnected/i
            )
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      } while (Date.now() < reconnectDeadline)
      assert.ok(restarted, 'The isolated executor must restart')
      assert.equal(
        await control.command('getAttribute', original + ' [data-testid="mcp-app-frame"]', {
          value: 'src',
        }),
        frameUrl
      )
      assert.equal(await frameAction('value', '#draft'), 'restart draft')
      await frameAction('click', '#refresh')
      await waitText('Counter 1')
      assert.equal(await frameAction('attribute', 'body', 'data-integrity'), 'verified')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composer)
      await control.command('waitFor', '[data-testid="mcp-app-frame"]', { visible: false })
      const releaseDeadline = Date.now() + uiTimeoutMs
      let released = false
      do {
        if ((await frameAction('document-status', 'body')) === 404) {
          released = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      } while (Date.now() < releaseDeadline)
      assert.ok(released, 'Leaving the task must release its app document')
      assert.ok(calls >= 8)
      await ordinaryMcp.verify(control)
    },
  }
}
